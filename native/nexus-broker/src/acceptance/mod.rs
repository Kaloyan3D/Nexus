//! Task acceptance contracts (Verification Engine, Phase 06): which requirements belong to a coding
//! task, who established them, and how the existing verification evidence relates to them.
//! Core-owned and independent of `engine/`; reporting only (it never blocks, prompts or schedules).

pub mod contract;
pub mod evaluate;
pub mod store;
pub mod tool;
pub mod verbs;

#[cfg(test)]
mod tests;

pub use tool::TOOL;

/// A one-line Core-derived pointer to the task's contract for the context manager, so compaction
/// never leaves the model unaware that requirements exist. Ids, origins and counts only: no
/// requirement text, no verdicts (those live in the contract, which compaction does not touch).
pub fn compaction_note(
    store: &crate::store::Store,
    state_dir: &std::path::Path,
    run_id: &str,
) -> Option<String> {
    let anchor = store::anchor_for_run(store, run_id)?;
    let c = store::load(state_dir, &store::task_key(&anchor))?;
    let (mut auth, mut cand) = (0u32, 0u32);
    for r in c.active() {
        if r.provenance.authoritative() {
            auth += 1;
        } else {
            cand += 1;
        }
    }
    if auth + cand == 0 {
        return None;
    }
    Some(format!(
        "[acceptance contract {} rev {}: {auth} authoritative, {cand} model-proposed requirement(s) on record; \
         the Core keeps them durably]",
        c.contract_id, c.revision
    ))
}

/// The acceptance reading for a run, or `None` when its task has no contract.
pub fn report_for_run(
    store: &crate::store::Store,
    state_dir: &std::path::Path,
    run_id: &str,
) -> Option<nexus_client::intent_client::AcceptanceSummary> {
    let anchor = store::anchor_for_run(store, run_id)?;
    store::bind_run(state_dir, &anchor, run_id);
    evaluate::evaluate(state_dir, &anchor.project_id, Some(&anchor), run_id)
}
