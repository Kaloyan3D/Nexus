//! The model's way to propose acceptance criteria (opt-in tool profile).
//!
//! It is a control-plane tool, handled by the broker: it has no Kernel tool id, takes no approval,
//! touches no file and makes no provider request. What it can do is fixed by this code:
//!
//! * add requirements whose provenance is `ModelProposed` (or `Assumption` when the model says so);
//!   a field that tries to name an authority is refused, not ignored;
//! * record an ADVISORY claim that one of the run's real, recorded checks covers a criterion; the
//!   claim is resolved against the evidence ledger (a call index that is not a recognized check is
//!   reported back as unresolved) and is never counted toward a requirement's status.

use super::store::{self, Anchor, Refusal};
use crate::verification::{evidence, persistence};
use serde_json::Value;
use std::path::Path;

pub const TOOL: &str = "acceptance_propose";
pub const MAX_CRITERIA: usize = 12;
pub const MAX_CLAIMS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub description: String,
    pub assumption: bool,
    pub checked_by: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub code: &'static str,
    pub message: String,
}

fn bad(code: &'static str, message: impl Into<String>) -> Invalid {
    Invalid {
        code,
        message: message.into(),
    }
}

/// Strict, closed validation of the tool arguments.
pub fn validate(args: &Value) -> Result<Vec<Criterion>, Invalid> {
    let obj = args
        .as_object()
        .ok_or_else(|| bad("invalid-arguments", "arguments must be an object"))?;
    if let Some(k) = obj.keys().find(|k| k.as_str() != "criteria") {
        return Err(bad(
            "unknown-field",
            format!("unknown field `{k}`: this tool takes only `criteria`"),
        ));
    }
    let list = obj
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("invalid-arguments", "`criteria` must be an array"))?;
    if list.is_empty() || list.len() > MAX_CRITERIA {
        return Err(bad(
            "invalid-arguments",
            format!("`criteria` needs 1 to {MAX_CRITERIA} items"),
        ));
    }
    let mut out = Vec::new();
    for item in list {
        let o = item
            .as_object()
            .ok_or_else(|| bad("invalid-arguments", "each criterion must be an object"))?;
        if let Some(k) = o
            .keys()
            .find(|k| !matches!(k.as_str(), "description" | "kind" | "checkedByCalls"))
        {
            // origin, provenance, authority, trusted, explicit ...: there is no such input
            return Err(bad(
                "unknown-field",
                format!("unknown field `{k}` in a criterion"),
            ));
        }
        let description = o
            .get("description")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                bad(
                    "invalid-arguments",
                    "a criterion needs a string `description`",
                )
            })?;
        let description = super::contract::clean_description(description)
            .map_err(|c| bad("invalid-arguments", format!("description rejected: {c}")))?;
        let assumption = match o.get("kind").map(Value::as_str) {
            None | Some(Some("criterion")) => false,
            Some(Some("assumption")) => true,
            _ => {
                return Err(bad(
                    "invalid-arguments",
                    "`kind` must be `criterion` or `assumption`",
                ))
            }
        };
        let mut checked_by = Vec::new();
        if let Some(v) = o.get("checkedByCalls") {
            let a = v
                .as_array()
                .ok_or_else(|| bad("invalid-arguments", "`checkedByCalls` must be an array"))?;
            if a.len() > MAX_CLAIMS {
                return Err(bad(
                    "invalid-arguments",
                    format!("at most {MAX_CLAIMS} entries in `checkedByCalls`"),
                ));
            }
            for n in a {
                let n = n
                    .as_u64()
                    .filter(|n| (1..=u64::from(u32::MAX)).contains(n))
                    .ok_or_else(|| {
                        bad(
                            "invalid-arguments",
                            "`checkedByCalls` holds tool-call numbers (integers >= 1)",
                        )
                    })?;
                checked_by.push(n as u32);
            }
        }
        out.push(Criterion {
            description,
            assumption,
            checked_by,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// (requirement id, new or duplicate)
    pub recorded: Vec<(String, bool)>,
    pub claims_recorded: u32,
    pub claims_unresolved: Vec<u32>,
}

/// Record the criteria. `run_id`'s evidence ledger must already hold every call made so far.
pub fn handle(
    state_dir: &Path,
    anchor: &Anchor,
    run_id: &str,
    call_index: u32,
    criteria: &[Criterion],
) -> Result<Outcome, Refusal> {
    let ledger = persistence::load(state_dir, run_id).ledger;
    let recs = ledger.records();
    let mut out = Outcome {
        recorded: vec![],
        claims_recorded: 0,
        claims_unresolved: vec![],
    };
    for c in criteria {
        let added = store::propose_model(
            state_dir,
            anchor,
            run_id,
            call_index,
            &c.description,
            c.assumption,
        )?;
        out.recorded.push((added.id.clone(), !added.duplicate));
        for n in &c.checked_by {
            // a claim can only point at a real, recorded, recognized check of THIS run
            let hit = recs.iter().find(|r| {
                r.call_index == *n
                    && r.kind == evidence::ObservationKind::Command
                    && r.check.as_ref().is_some_and(|k| {
                        matches!(k.recognition, evidence::Recognition::Recognized { .. })
                    })
            });
            match hit {
                Some(r) => {
                    store::claim_model(
                        state_dir,
                        anchor,
                        run_id,
                        call_index,
                        &added.id,
                        &r.evidence_id,
                    )?;
                    out.claims_recorded += 1;
                }
                None => out.claims_unresolved.push(*n),
            }
        }
    }
    Ok(out)
}

/// What the model is told. Plain, short, and explicit about what was NOT established.
pub fn render(o: &Outcome) -> String {
    let list = o
        .recorded
        .iter()
        .map(|(id, new)| format!("{id}{}", if *new { "" } else { " (already recorded)" }))
        .collect::<Vec<_>>()
        .join(", ");
    let mut s = format!(
        "Recorded as YOUR proposed criteria: {list}. They are your interpretation of the task, not user requirements, and recording them verifies nothing."
    );
    if o.claims_recorded > 0 {
        s.push_str(&format!(
            " {} coverage claim(s) were recorded as advisory: a claim never counts as verification; only a check that a trusted party bound to a requirement does.",
            o.claims_recorded
        ));
    }
    if !o.claims_unresolved.is_empty() {
        s.push_str(&format!(
            " Not recorded: tool call(s) {:?} are not recognized checks recorded in this run.",
            o.claims_unresolved
        ));
    }
    s
}
