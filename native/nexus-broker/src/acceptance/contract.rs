//! Task Acceptance Contract V1 (Verification Engine, Phase 06): the durable record of WHAT the
//! task requires, who said so, and which evidence a trusted party says covers it.
//!
//! The contract is an append-only journal of [`Event`]s; the current contract is a deterministic
//! fold of it ([`Contract::fold`]). Nothing here reads a model's words as authority:
//!
//! * a requirement's [`Provenance`] is set by the CODE PATH that wrote it, never by a field the
//!   writer supplies: the model tool can only produce `ModelProposed` / `Assumption`; the trusted
//!   client verbs can only produce `UserExplicit` / `ProjectPolicy`;
//! * every event records its [`Actor`]; the fold REJECTS an authoritative requirement, a
//!   supersession of one, or a trusted coverage binding whose actor is not trusted. A journal edited
//!   by hand to claim authority therefore gains none;
//! * a requirement is never rewritten. A revision supersedes it and creates a new requirement;
//!   evidence links are attached to one requirement id and never carried to its replacement.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const SCHEMA_VERSION: u32 = 1;
/// Journal file suffix (next to the verification ledger, same checksummed line format).
pub const SUFFIX: &str = ".acceptance.jsonl";
/// Input-size bounds (protection against absurd input, not engineering budgets).
pub const MAX_DESCRIPTION_CHARS: usize = 400;
pub const MAX_REQUIREMENTS: usize = 200;

/// Who established a requirement. Only the first two are authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provenance {
    /// Set through an authenticated client verb by the user.
    UserExplicit,
    /// Set through an authenticated client verb as the project's standing policy.
    ProjectPolicy,
    /// A criterion the active model proposed while interpreting the task.
    ModelProposed,
    /// An interpretation the model flagged as an assumption.
    Assumption,
}

impl Provenance {
    pub fn authoritative(self) -> bool {
        matches!(self, Self::UserExplicit | Self::ProjectPolicy)
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::UserExplicit => "user-explicit",
            Self::ProjectPolicy => "project-policy",
            Self::ModelProposed => "model-proposed",
            Self::Assumption => "assumption",
        }
    }
}

/// The party that wrote an event. Recorded by the Core, from the code path, never from input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Actor {
    /// An authenticated client of the broker (OS peer credentials), e.g. `uid:1000`.
    Trusted { client: String },
    /// The active model, through its tool, in this run at this tool call.
    Model { run_id: String, call_index: u32 },
}

impl Actor {
    pub fn trusted(&self) -> bool {
        matches!(self, Self::Trusted { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// One task (a conversation, or a run and its continuations).
    Task,
    /// Every task of a project.
    Project,
}

/// How a link was established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LinkOrigin {
    /// A trusted party declared that this check covers the requirement. Counts toward status.
    TrustedBinding { by: String },
    /// The model claimed that this evidence covers the requirement. Advisory, never counted.
    ModelAsserted { run_id: String, call_index: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LinkTarget {
    /// A check, by its identity digest (working directory + command words; see
    /// `verification::evidence::check_digest`): whichever execution of it is current.
    Check { digest: String, label: String },
    /// One recorded piece of evidence of a run (a model's claim, resolved to a real record).
    Evidence { run_id: String, evidence_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum Event {
    /// The contract's identity. Written once, first.
    Opened {
        schema: u32,
        contract_id: String,
        scope: Scope,
        project_id: String,
        anchor: String,
        /// Digest of the original request this task started from (the immutable reference); the
        /// request text is NOT copied here.
        source_request_digest: Option<String>,
        root_run_id: Option<String>,
    },
    Requirement {
        id: String,
        description: String,
        /// Digest of the normalized description (deduplication key).
        desc_digest: String,
        provenance: Provenance,
        by: Actor,
        /// The requirement this one replaces (a revision), if any.
        supersedes: Option<String>,
    },
    /// A requirement stops being an obligation. History is kept.
    Superseded {
        id: String,
        by_requirement: Option<String>,
        by: Actor,
    },
    Link {
        link_id: String,
        requirement_id: String,
        origin: LinkOrigin,
        target: LinkTarget,
    },
    /// A run that worked on this contract (informational; evidence is evaluated per run).
    RunBound { run_id: String },
}

/// One journal record: a deterministic event id plus the event. Replaying the same event cannot
/// change the contract (the fold keeps the first occurrence of an id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub eid: String,
    pub event: Event,
}

impl Record {
    pub fn new(contract_id: &str, event: Event) -> Self {
        let mut h = Sha256::new();
        h.update(b"nexus.acceptance.event.v1\0");
        h.update(contract_id.as_bytes());
        h.update([0]);
        // the event's canonical JSON (serde_json orders struct fields as declared: stable)
        h.update(serde_json::to_string(&event).unwrap_or_default().as_bytes());
        Self {
            eid: format!("ev_{}", hex::encode(h.finalize())),
            event,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Active,
    Superseded { by: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub id: String,
    pub description: String,
    pub desc_digest: String,
    pub provenance: Provenance,
    pub by: Actor,
    pub revision: u64,
    pub state: State,
    pub supersedes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub link_id: String,
    pub requirement_id: String,
    pub origin: LinkOrigin,
    pub target: LinkTarget,
}

/// The current contract: a pure function of the journal.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Contract {
    pub contract_id: String,
    pub scope: Option<Scope>,
    pub project_id: String,
    pub anchor: String,
    pub source_request_digest: Option<String>,
    pub root_run_id: Option<String>,
    /// Counts every applied change (requirements, supersessions, links).
    pub revision: u64,
    pub requirements: Vec<Requirement>,
    pub links: Vec<Link>,
    pub runs: Vec<String>,
    /// Journal lines that could not be read, plus events the fold refused. Non-zero means the
    /// contract may be incomplete or tampered: nothing is then reported verified.
    pub unreadable: usize,
    pub rejected: usize,
}

/// Normalization for deduplication: whitespace collapsed, case folded. Exact equality of the result
/// is the only notion of "the same requirement" (no similarity, no keywords).
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn desc_digest(text: &str) -> String {
    hex::encode(Sha256::digest(normalize(text).as_bytes()))
}

/// Validate and clean a requirement description.
pub fn clean_description(text: &str) -> Result<String, &'static str> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("empty-description");
    }
    if t.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err("description-too-long");
    }
    if t.chars().any(char::is_control) {
        return Err("control-characters");
    }
    Ok(t)
}

impl Contract {
    /// Fold journal records (oldest first). Deterministic: the same records give the same contract.
    pub fn fold(records: &[Record], unreadable: usize) -> Contract {
        let mut c = Contract {
            unreadable,
            ..Default::default()
        };
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for r in records {
            if !seen.insert(r.eid.as_str()) {
                continue; // a replay
            }
            c.apply(&r.event);
        }
        c
    }

    fn req(&self, id: &str) -> Option<&Requirement> {
        self.requirements.iter().find(|r| r.id == id)
    }

    fn apply(&mut self, e: &Event) {
        match e {
            Event::Opened {
                schema,
                contract_id,
                scope,
                project_id,
                anchor,
                source_request_digest,
                root_run_id,
            } => {
                if self.scope.is_some() || *schema != SCHEMA_VERSION {
                    // a second "opened" or a schema this build does not know is not trusted
                    self.rejected += 1;
                    return;
                }
                self.contract_id = contract_id.clone();
                self.scope = Some(*scope);
                self.project_id = project_id.clone();
                self.anchor = anchor.clone();
                self.source_request_digest = source_request_digest.clone();
                self.root_run_id = root_run_id.clone();
            }
            Event::Requirement {
                id,
                description,
                desc_digest,
                provenance,
                by,
                supersedes,
            } => {
                // authority comes from the actor, never from the claimed provenance alone
                if provenance.authoritative() != by.trusted() || self.req(id).is_some() {
                    self.rejected += 1;
                    return;
                }
                if let Some(old) = supersedes {
                    match self.req(old) {
                        // only a trusted actor may replace an authoritative requirement
                        Some(o) if o.provenance.authoritative() && !by.trusted() => {
                            self.rejected += 1;
                            return;
                        }
                        Some(_) => {}
                        None => {
                            self.rejected += 1;
                            return;
                        }
                    }
                }
                self.revision += 1;
                self.requirements.push(Requirement {
                    id: id.clone(),
                    description: description.clone(),
                    desc_digest: desc_digest.clone(),
                    provenance: *provenance,
                    by: by.clone(),
                    revision: 1,
                    state: State::Active,
                    supersedes: supersedes.clone(),
                });
            }
            Event::Superseded {
                id,
                by_requirement,
                by,
            } => {
                let authoritative = self.req(id).map(|r| r.provenance.authoritative());
                match authoritative {
                    None => self.rejected += 1,
                    // retiring an authoritative requirement needs a trusted actor
                    Some(true) if !by.trusted() => self.rejected += 1,
                    Some(_) => {
                        let rev = self.revision + 1;
                        if let Some(r) = self.requirements.iter_mut().find(|r| r.id == *id) {
                            if r.state == State::Active {
                                r.state = State::Superseded {
                                    by: by_requirement.clone(),
                                };
                                r.revision = rev;
                                self.revision = rev;
                            }
                        }
                    }
                }
            }
            Event::Link {
                link_id,
                requirement_id,
                origin,
                target,
            } => {
                let ok_origin = matches!(
                    (origin, target),
                    (LinkOrigin::TrustedBinding { .. }, LinkTarget::Check { .. })
                        | (
                            LinkOrigin::ModelAsserted { .. },
                            LinkTarget::Evidence { .. }
                        )
                );
                if self.req(requirement_id).is_none() || !ok_origin {
                    self.rejected += 1;
                    return;
                }
                if self.links.iter().any(|l| l.link_id == *link_id) {
                    return;
                }
                self.revision += 1;
                self.links.push(Link {
                    link_id: link_id.clone(),
                    requirement_id: requirement_id.clone(),
                    origin: origin.clone(),
                    target: target.clone(),
                });
            }
            Event::RunBound { run_id } => {
                if !self.runs.contains(run_id) {
                    self.runs.push(run_id.clone());
                }
            }
        }
    }

    pub fn active(&self) -> impl Iterator<Item = &Requirement> {
        self.requirements
            .iter()
            .filter(|r| r.state == State::Active)
    }

    /// The journal can be trusted to be complete.
    pub fn intact(&self) -> bool {
        self.unreadable == 0 && self.rejected == 0 && self.scope.is_some()
    }
}
