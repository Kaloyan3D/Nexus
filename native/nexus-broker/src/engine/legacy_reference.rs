//! Frozen copy of the pre-EM-01 policy (commit a497b87, `inspect.rs`), used ONLY as the
//! reference of the differential parity test. The functions are verbatim; only the state type
//! is a test struct with the same fields.
//!
//! Test-only twice over: `mod.rs` declares it under `#[cfg(test)]`, and the inner attribute
//! below compiles this file to nothing outside `cfg(test)` even if a declaration ever loses its
//! guard. Nothing outside `engine::tests` may use it.
#![cfg(test)]
#![allow(dead_code)]

#[derive(Default, Clone, Debug)]
pub struct LegacyState {
    pub expects_change: bool,
    pub carried_work: bool,
    pub applied: u32,
    pub last_test: Option<String>,
    pub tool_calls: u32,
    pub edits_used: u32,
    pub tests_used: u32,
    pub dirty_since_test: bool,
    pub created: std::collections::BTreeSet<String>,
    pub failed_checks: std::collections::BTreeSet<String>,
    pub nudges: u32,
    pub plan_nudges: u32,
    pub report_nudges: u32,
    pub verify_nudges: u32,
    pub fail_nudges: u32,
    pub tidy_nudges: u32,
    pub progress_mark: u32,
    pub steers: u32,
    pub recent_narration: Vec<String>,
}

fn applied_edits(ls: &LegacyState) -> u32 {
    ls.applied
}

pub const MAX_NUDGES: u32 = 7;

fn looks_like_report(t: &str) -> bool {
    t.len() >= 1500
        && t.lines().any(|l| {
            let l = l.trim_start();
            l.starts_with('#')
                || l.starts_with("**")
                || l.starts_with("- ")
                || l.starts_with("* ")
                || l.split_once('.')
                    .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
}
pub fn refresh_stall_budget(ls: &mut LegacyState) {
    let progress = ls.edits_used + ls.tests_used;
    if progress > ls.progress_mark {
        ls.progress_mark = progress;
        ls.nudges = 0;
        ls.plan_nudges = 0;
        ls.report_nudges = 0;
        ls.verify_nudges = 0;
        ls.fail_nudges = 0;
    }
}
pub fn premature_stop(ls: &mut LegacyState, text: &str) -> Option<(&'static str, &'static str)> {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    // 0. an implementation was asked for, nothing was changed and nothing was verified, yet
    //    the model ended on a plan or on tool calls written as prose (found live: a 40 KB
    //    planning ramble was accepted as the finished task)
    if ls.expects_change
        && applied_edits(ls) == 0
        && ls.last_test.as_deref() != Some("pass")
        && ls.plan_nudges < crate::completion::MAX_PLAN_NUDGES
    {
        if crate::completion::text_tool_calls(t) {
            ls.plan_nudges += 1;
            return Some((
                crate::completion::MSG_TEXT_CALLS,
                "tool calls written as text",
            ));
        }
        if crate::completion::plan_like(t)
            || t.is_empty()
            || (ls.tool_calls == 0 && !ls.carried_work)
        {
            ls.plan_nudges += 1;
            return Some((crate::completion::MSG_PLAN, "a plan instead of the work"));
        }
    }
    // 0b. changes exist, but the model stopped on "now the next step" (found live: five edits,
    //     then a one-line announcement was accepted as the end of the task)
    if ls.expects_change
        && ls.plan_nudges < crate::completion::MAX_PLAN_NUDGES
        && crate::completion::announcement(t)
    {
        ls.plan_nudges += 1;
        return Some((
            crate::completion::MSG_ANNOUNCE,
            "an announcement instead of the step",
        ));
    }
    // 1. an announcement of the next step instead of the step
    const MIDFLIGHT: [&str; 10] = [
        "re-issuing",
        "reissuing",
        "let me ",
        "i'll ",
        "i will ",
        "now i",
        "next, i",
        "continuing",
        "going to ",
        "proceeding",
    ];
    if ls.tool_calls > 0
        && t.len() < 700
        && (t.is_empty() || MIDFLIGHT.iter().any(|m| lower.contains(m)))
    {
        return Some((
            "You ended your turn without making the next tool call or writing the final answer. Continue the work now: call the tools you need, or if you are finished, write the complete final answer (for a review, the full report with evidence).",
            "no tool call and no final answer",
        ));
    }
    // 1b. a long investigation that ends without a written report
    if ls.edits_used == 0
        && ls.last_test.is_none()
        && ls.tool_calls >= 8
        && ls.report_nudges < 3
        && !looks_like_report(t)
    {
        ls.report_nudges += 1;
        return Some((
            "Your last message is not a finished report. Do not plan or narrate further. If you still need evidence, make the tool calls now (one call per step is fine). Otherwise write the COMPLETE final report now as your reply: headings, each finding with severity, the file path and line numbers you actually read, why it matters and a recommended fix, then a prioritized summary and what you did not inspect.",
            "no finished report yet",
        ));
    }
    // 1c. scratch files left in the project
    if ls.tidy_nudges < 1 {
        let junk: Vec<&String> = ls
            .created
            .iter()
            .filter(|p| {
                let l = p.to_ascii_lowercase();
                [".new", ".bak", ".orig", ".tmp", ".old", "~"]
                    .iter()
                    .any(|e| l.ends_with(e))
            })
            .collect();
        if !junk.is_empty() {
            ls.tidy_nudges += 1;
            return Some((
                "You left scratch files in the project that are not part of the change. Delete them now with fs_write mode \"delete\" (and only them), then give your final answer.",
                "scratch files left behind",
            ));
        }
    }
    // 2. changes that were never verified
    if ls.edits_used > 0
        && ls.dirty_since_test
        && ls.verify_nudges < if ls.expects_change { 3 } else { 1 }
    {
        ls.verify_nudges += 1;
        return Some((
            "You changed files but no build, test or type-check has run since your last change. Run the project's verification now (install dependencies first if they are missing) and fix anything that fails. Only then give your final answer.",
            "changes not verified",
        ));
    }
    // 3a. verification commands are still failing although the LAST one passed (a narrower command
    //     hides them; found live: five unresolved failures and a closing 15 KB narration)
    if ls.last_test.as_deref() != Some("fail")
        && !ls.failed_checks.is_empty()
        && ls.edits_used > 0
        && ls.fail_nudges < 2
    {
        ls.fail_nudges += 1;
        return Some((
            crate::completion::MSG_UNRESOLVED_CHECKS,
            "failed checks never re-run successfully",
        ));
    }
    // 3. the last verification failed
    if ls.last_test.as_deref() == Some("fail") && ls.edits_used > 0 && ls.fail_nudges < 2 {
        ls.fail_nudges += 1;
        return Some((
            "Your last verification command failed. Read its output. If your change caused it, fix the cause and run it again. If the failure was already there and is unrelated to the task, do not widen the task to fix it: say so explicitly in your final answer with the evidence.",
            "last verification failed",
        ));
    }
    None
}

/// The steer block of the pre-EM-01 turn loop (narration push at the start of the tool phase,
/// steer check after it), verbatim apart from the session/items side effects.
pub fn steer(ls: &mut LegacyState, text: &str) -> Option<String> {
    ls.recent_narration
        .push(crate::completion::normalize_narration(text));
    if ls.recent_narration.len() > 4 {
        ls.recent_narration.remove(0);
    }
    if ls.expects_change && applied_edits(ls) == 0 && ls.steers < crate::completion::MAX_STEERS {
        let due = ls.tool_calls >= crate::completion::STEER_EVERY * (ls.steers + 1);
        if due || crate::completion::repeated_narration(&ls.recent_narration) {
            ls.steers += 1;
            let n = ls.tool_calls;
            ls.recent_narration.clear();
            return Some(crate::completion::steer_message(n));
        }
    }
    None
}
