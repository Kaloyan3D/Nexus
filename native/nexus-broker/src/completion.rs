//! Completion classification for coding runs (found by a real self-development run).
//!
//! A provider "stop" only means the model ended its message. For a task that asks for an
//! IMPLEMENTATION, a message that merely plans (or describes tool calls in prose) while no
//! file was changed is not a fulfilled task, and a 40-turn exploration without a single edit
//! needs a nudge, not applause. Everything here is decided from the user's request and from
//! execution evidence (receipts), never from the model's claims alone, and it never forces a
//! change: a valid no-op (tests prove the behaviour already exists, or a plain explanation)
//! stays a normal completion.

/// A read-only exploration of this many tool calls without a change gets one steer, then one
/// per further block (bounded by [`MAX_STEERS`]).
pub const STEER_EVERY: u32 = 24;
pub const MAX_STEERS: u32 = 3;
/// Plan/tool-text nudges before the run is declared incomplete.
pub const MAX_PLAN_NUDGES: u32 = 5;

pub const MSG_PLAN: &str = "You ended your turn with a plan or narration, but this task asks you to IMPLEMENT it and no file has been changed yet. Do not write another plan or describe tool calls. Make the next tool call now: fs_edit or fs_write on the file you have already read (re-read only the exact lines you edit), then run the relevant tests. If you truly believe nothing needs to change, run the project's relevant tests to prove it and say so plainly.";
pub const MSG_ANNOUNCE: &str = "Your last message only announced the next step; the task is not finished. Do that step now with a tool call (fs_edit, fs_write, proc_run or fs_read), and write a final answer only when the work is done and verified.";
pub const MSG_TEXT_CALLS: &str = "Your message contains tool calls written as plain text, which do nothing. Tool calls must be made through the function-calling interface: issue the call itself now (fs_edit, fs_write, fs_read or proc_run) instead of describing it.";

pub fn steer_message(reads: u32) -> String {
    format!("[Nexus] You have made {reads} tool calls and changed nothing, and the task asks for an implementation. The investigation is sufficient: begin implementing now. Make the first fs_edit or fs_write in your next message (new files with fs_write; re-read only the exact lines you edit), then run the relevant tests. Do not announce what you will do; do it.")
}

const FILLERS: &[&str] = &[
    "please", "kindly", "now", "ok", "okay", "so", "then", "proceed", "go", "ahead", "just",
    "next", "and", "i", "want", "need", "you", "to", "can", "could", "would", "with", "let's",
    "lets", "must", "should", "also", "continue",
];
const QUESTION_WORDS: &[&str] = &[
    "how",
    "why",
    "what",
    "where",
    "which",
    "when",
    "who",
    "is",
    "are",
    "does",
    "do",
    "did",
    "explain",
    "describe",
    "summarize",
    "summarise",
    "list",
    "show",
    "tell",
    "review",
    "audit",
    "analyze",
    "analyse",
    "inspect",
    "investigate",
    "check",
];
/// Change verbs by stem ("implement" covers implements/implementing/implementation).
const CHANGE_STEMS: &[&str] = &[
    "implement",
    "fix",
    "add",
    "chang",
    "edit",
    "modif",
    "writ",
    "refactor",
    "remov",
    "delet",
    "updat",
    "creat",
    "renam",
    "appl",
    "patch",
    "make",
    "build",
    "rewrit",
    "replac",
    "migrat",
    "convert",
    "introduc",
    "extract",
    "mov",
    "improv",
    "resolv",
    "correct",
    "integrat",
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace('\u{2019}', "'")
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_change_word(w: &str) -> bool {
    CHANGE_STEMS.iter().any(|s| w.starts_with(s))
}

/// Does the request ask for the code to be CHANGED (an implementation task)? An imperative
/// ("Implement X", "Please fix Y", "Proceed with implementing Z") or a mixed request that
/// contains a change verb; a plain question or review ("How would I implement X?", "Review
/// the repository") does not.
pub fn expects_change(request: &str) -> bool {
    let w = words(request);
    let mut i = 0;
    while i < w.len() && FILLERS.contains(&w[i].as_str()) {
        i += 1;
    }
    let Some(first) = w.get(i) else {
        return false;
    };
    if is_change_word(first) {
        return true;
    }
    if QUESTION_WORDS.contains(&first.as_str()) {
        // "Review the code and fix what you find": a change is asked for as well
        return (i + 1..w.len().saturating_sub(1))
            .any(|j| matches!(w[j].as_str(), "and" | "then") && is_change_word(&w[j + 1]));
    }
    w.iter().take(80).any(|x| is_change_word(x))
}

/// "continue", "go on", "resume": a message that carries no task of its own but asks to carry on
/// the previous one. Its intent (implement or not) is the previous request's.
pub fn is_continuation(request: &str) -> bool {
    let w = words(request);
    if w.is_empty() || w.len() > 8 {
        return false;
    }
    matches!(
        w[0].as_str(),
        "continue"
            | "continuing"
            | "resume"
            | "proceed"
            | "go"
            | "keep"
            | "carry"
            | "finish"
            | "retry"
            | "again"
            | "ok"
            | "okay"
            | "yes"
            | "yep"
            | "yeah"
            | "sure"
            | "next"
    ) || (w[0] == "try" && w.get(1).is_some_and(|x| x == "again"))
}

const TOOL_NAMES: &[&str] = &[
    "fs_edit",
    "fs_write",
    "fs_read",
    "fs_search",
    "fs_list",
    "proc_run",
];

/// Tool calls written as prose or pseudo-syntax instead of being issued: `fs_edit({..})`,
/// `proc_run {`, `<tool_call>`, `[tool_call`, "assistant to=functions.".
pub fn text_tool_calls(text: &str) -> bool {
    let l = text.to_lowercase();
    if l.contains("<tool_call")
        || l.contains("[tool_call")
        || l.contains("to=functions.")
        || l.contains("<function_call")
    {
        return true;
    }
    for t in TOOL_NAMES {
        for sep in ["(", " {", "{\"", "(\"", " ({"] {
            if l.contains(&format!("{t}{sep}")) {
                return true;
            }
        }
    }
    false
}

/// Narration of intent instead of work: tool names discussed in prose, or many first-person
/// future-tense markers.
pub fn plan_like(text: &str) -> bool {
    let l = text.to_lowercase();
    let tools: usize = TOOL_NAMES.iter().map(|t| l.matches(t).count()).sum();
    const MARKERS: &[&str] = &[
        "i'll ",
        "i will ",
        "let me ",
        "now i",
        "next, i",
        "going to ",
        "about to ",
        "firing",
        "composing",
        "proceeding",
        "i need to",
        "i must",
        "i should",
        "plan for implementation",
        "here they are",
        "tool call",
    ];
    let marks: usize = MARKERS.iter().map(|m| l.matches(m).count()).sum();
    tools >= 2 || marks >= 3 || (tools >= 1 && marks >= 1)
}

/// A short message that announces what comes next instead of reporting a result ("X is wired -
/// now the bridge commands."). Found live: a run ended on one after five edits, mid-task.
/// Split at sentence ends (`.` `!` `?` newline), but never at a dot between two digits: a
/// version or a decimal ("version 0.5.0", "2.5 s") is not a sentence end. (Found in the P0
/// benchmark: "Item 9 is green. Now the final item 10, version 0.5.0." was read as ending on
/// "0" and accepted as the final answer with item 10 never done.)
fn sentences_of(l: &str) -> Vec<&str> {
    let b = l.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    for (i, &c) in b.iter().enumerate() {
        let end = match c {
            b'!' | b'?' | b'\n' => true,
            b'.' => {
                !(i > 0
                    && b[i - 1].is_ascii_digit()
                    && b.get(i + 1).is_some_and(|n| n.is_ascii_digit()))
            }
            _ => false,
        };
        if end {
            out.push(&l[start..i]);
            start = i + 1;
        }
    }
    out.push(&l[start..]);
    out
}

pub fn announcement(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.len() > 500 {
        return false;
    }
    let l = t.to_lowercase();
    // a report that states limits or "nothing to change" is an ending, whatever else it says
    const REPORT: &[&str] = &[
        "nothing to change",
        "no change needed",
        "no change is needed",
        "limitations",
        "summary",
    ];
    if REPORT.iter().any(|d| l.contains(d)) {
        return false;
    }
    // Judge how the message ENDS: earlier results ("contract tests pass") do not make a closing
    // "now the broker test ... attempting it" an ending (found live in the R-NATIVE-1 acceptance).
    let sentences: Vec<&str> = sentences_of(&l)
        .into_iter()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let last = sentences.last().copied().unwrap_or("");
    let closing = sentences[sentences.len().saturating_sub(2)..].join(". ");
    const DONE: &[&str] = &[
        "all tests pass",
        "all checks pass",
        "is complete",
        "are complete",
        "is done",
        "are done",
        "all done",
    ];
    if DONE.iter().any(|d| last.contains(d)) {
        return false;
    }
    const FORWARD: &[&str] = &[
        "now ",
        "next,",
        "next ",
        "going to",
        "about to",
        "let me",
        "i'll ",
        "i will ",
        "then i",
        "proceeding",
        "working on",
        "implementing ",
        "attempting",
        "trying ",
        "writing the",
        "adding the",
    ];
    // a closing sentence that opens with a gerund ("Running the final suites ...") is work in progress
    let gerund = |sentence: &str| {
        sentence
            .split_whitespace()
            .next()
            .is_some_and(|w| w.len() > 5 && w.ends_with("ing") && !w.starts_with("nothing"))
    };
    const ACTING: &[&str] = &[
        "running",
        "re-running",
        "rerunning",
        "checking",
        "verifying",
        "executing",
        "writing",
        "adding",
        "fixing",
        "building",
        "testing",
        "reading",
        "updating",
        "finalizing",
        "finalising",
        "starting",
        "launching",
        "compiling",
        "formatting",
        "creating",
    ];
    let acting = closing
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .any(|w| ACTING.contains(&w));
    gerund(last) || acting || FORWARD.iter().any(|f| closing.contains(f))
}

/// The same progress sentence turn after turn: a model stuck narrating.
pub fn repeated_narration(recent: &[String]) -> bool {
    if recent.len() < 3 {
        return false;
    }
    let tail = &recent[recent.len() - 3..];
    !tail[0].is_empty() && tail[0] == tail[1] && tail[1] == tail[2]
}

pub fn normalize_narration(text: &str) -> String {
    words(text).join(" ").chars().take(160).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    /// Not an implementation task, or files were changed.
    Fulfilled,
    /// Asked to implement; no change, but the relevant checks passed (a verified no-op).
    NoChangeVerified,
    /// Asked to implement; no change and no check, with a plain (non-plan) answer.
    NoChangeReported,
    /// Asked to implement; the run ended on a plan or with nothing done.
    Incomplete,
    /// Files were changed, but verification commands failed and were never re-run successfully.
    /// Not a success: the receipts, not the model's closing text, say the work is unverified.
    FailingChecks,
}

impl Completion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fulfilled => "fulfilled",
            Self::NoChangeVerified => "no-change-verified",
            Self::NoChangeReported => "no-change-reported",
            Self::Incomplete => "incomplete",
            Self::FailingChecks => "failing-checks",
        }
    }
}

/// How to classify the end of a coding run. `applied_edits` counts executed edits/writes,
/// `last_test` is the verdict of the last verification command.
pub fn decide(
    expects_change: bool,
    applied_edits: u32,
    last_test: Option<&str>,
    final_text: &str,
) -> Completion {
    if !expects_change {
        return Completion::Fulfilled;
    }
    if applied_edits > 0 {
        // changed files, but the run ended on "now the next step" (an earlier passing check does
        // not finish work that is announced as still to do)
        if announcement(final_text) {
            return Completion::Incomplete;
        }
        return Completion::Fulfilled;
    }
    if last_test == Some("pass") {
        return Completion::NoChangeVerified;
    }
    if final_text.trim().is_empty() || plan_like(final_text) || text_tool_calls(final_text) {
        return Completion::Incomplete;
    }
    Completion::NoChangeReported
}

/// `decide`, then the receipts of the whole run: an implementation that changed files is only
/// `Fulfilled` when no verification command is left failing (a later pass of the SAME command clears
/// it). Independent of what the final message says or how long it is.
pub fn decide_run(
    expects_change: bool,
    applied_edits: u32,
    last_test: Option<&str>,
    final_text: &str,
    unresolved_failed_checks: u32,
) -> Completion {
    let c = decide(expects_change, applied_edits, last_test, final_text);
    if c == Completion::Fulfilled
        && expects_change
        && applied_edits > 0
        && unresolved_failed_checks > 0
    {
        return Completion::FailingChecks;
    }
    c
}

/// Why a `failing-checks` run is not accepted as done. Plain words for the Desktop; blocked or
/// unverified is not passed, whatever the cause of the failure (an environment that cannot run the
/// check included). Only a genuine re-run of the same command to a pass clears it.
pub fn failing_checks_note(n: u32) -> String {
    format!(
        "Files were changed, but {n} verification command{} failed and {} never re-run successfully. {} blocked or unverified, not passed: re-run {} to a pass, or verify {} independently, before relying on this change.",
        if n == 1 { "" } else { "s" },
        if n == 1 { "was" } else { "were" },
        if n == 1 { "It is" } else { "They are" },
        if n == 1 { "it" } else { "them" },
        if n == 1 { "it" } else { "them" },
    )
}

/// The identity under which a verification command's failure is remembered and later cleared.
///
/// A pass clears a failure only when both have the SAME identity. By default the identity is the exact
/// command (`fallback`, the arguments digest). The one narrow equivalence: `cargo test|build|check|clippy`
/// whose arguments differ only in OUTPUT-ONLY flags - `--verbose`/`-v`/`-vv`, `--quiet`/`-q`,
/// `--color=<when>` before `--`, and `--nocapture`/`--show-output` after it (libtest's capture/printing,
/// which cannot change what is executed or the exit status). Everything else - test names and filters,
/// `-p`/`--package`/`--workspace`/`--test`/`--lib`, `--features`, `--release`/`--profile`, other libtest flags
/// (`--test-threads`, `--ignored`, `--include-ignored`, `--exact`, `--skip`), the working directory, ordering -
/// stays part of the identity, so a narrower or different command never clears a failure. Anything that is
/// not one of those four cargo subcommands keeps its exact identity. (The sandbox has no per-command
/// environment: `proc_run` takes only program, args and cwd.)
pub fn check_identity(args: &serde_json::Value, fallback: &str) -> String {
    use serde_json::Value;
    let prog = args.get("program").and_then(Value::as_str).unwrap_or("");
    let Some(argv) = args.get("args").and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|x| x.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()
    }) else {
        return fallback.to_owned();
    };
    let Some(argv) = argv else {
        return fallback.to_owned();
    };
    if prog != "cargo"
        || !matches!(
            argv.first().map(String::as_str),
            Some("test" | "build" | "check" | "clippy")
        )
    {
        return fallback.to_owned();
    }
    let sep = argv.iter().position(|a| a == "--");
    let (head, tail) = match sep {
        Some(i) => (&argv[..i], &argv[i + 1..]),
        None => (&argv[..], &[][..]),
    };
    let head: Vec<&str> = head
        .iter()
        .map(String::as_str)
        .filter(|a| {
            !matches!(*a, "--verbose" | "-v" | "-vv" | "--quiet" | "-q")
                && !matches!(*a, "--color=always" | "--color=never" | "--color=auto")
        })
        .collect();
    let tail: Vec<&str> = tail
        .iter()
        .map(String::as_str)
        .filter(|a| !matches!(*a, "--nocapture" | "--show-output"))
        .collect();
    let cwd = match args.get("cwd").and_then(Value::as_str) {
        None | Some("") | Some("./") => ".",
        Some(c) => c.trim_end_matches('/'),
    };
    let doc =
        serde_json::json!({ "v": 1, "program": "cargo", "head": head, "tail": tail, "cwd": cwd });
    format!(
        "norm:{}",
        nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(&doc))
    )
}

/// What the host tells the model when it refuses to accept a final answer because verification commands
/// failed and were never re-run successfully: exactly which commands, whether the problem is a mismatch
/// (a command of the same kind HAS passed with different arguments) or a failure still to fix, and which
/// checks already passed (so they are not re-run for nothing). Built only from command lines the model
/// itself issued, bounded in size.
pub fn unresolved_checks_message(unresolved: &[String], passed: &[String]) -> String {
    let kind = |c: &str| c.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let list = |v: &[String]| {
        v.iter()
            .take(6)
            .map(|c| format!("`{}`", c.chars().take(120).collect::<String>()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut out = format!(
        "Not finished: {} verification command{} failed earlier in this run and {} not passed since: {}.",
        unresolved.len(),
        if unresolved.len() == 1 { "" } else { "s" },
        if unresolved.len() == 1 { "has" } else { "have" },
        list(unresolved)
    );
    let mismatched: Vec<&String> = unresolved
        .iter()
        .filter(|u| passed.iter().any(|p| kind(p) == kind(u)))
        .collect();
    if !mismatched.is_empty() {
        out.push_str(" A command of the same kind has passed with DIFFERENT arguments, so this is a verification mismatch, not a new failure: it is only cleared by re-running the failed command itself (or the same command with only output flags such as --verbose or --nocapture changed).");
    } else {
        out.push_str(" None of them has passed yet: treat this as a failure to fix, then re-run that command.");
    }
    if !passed.is_empty() {
        out.push_str(&format!(
            " Already passing since your last change (do not re-run these): {}.",
            list(passed)
        ));
    }
    out.push_str(" If a failure was already there and is unrelated to your change, say so explicitly in your final answer with the evidence instead.");
    out
}

/// Sent when the model stops while verification commands are still failing.
pub const MSG_UNRESOLVED_CHECKS: &str = "Some verification commands failed and were never re-run successfully. Run them again after fixing the cause until they pass, or - if a failure was already there and is unrelated to the task - say so explicitly in your final answer with the evidence. Do not finish while they are unexplained.";

/// The plain-language reason of an `incomplete` run, from the receipts: an end after real changes
/// is not "nothing changed".
pub fn incomplete_note(applied_edits: u32, last_test: Option<&str>) -> String {
    if applied_edits == 0 {
        return INCOMPLETE_NOTE.to_owned();
    }
    let check = match last_test {
        Some("fail") => "the last check failed",
        Some("pass") => "the last check passed, but the work was not finished",
        _ => "no check has passed yet",
    };
    format!("The run stopped before the work was finished: {applied_edits} change(s) were made and are kept in the working copy, and {check}. The model's last message announced a next step instead of doing it. Send \"continue\" to resume from here.")
}

pub const INCOMPLETE_NOTE: &str = "The task asked for an implementation, but the model ended without changing any file and nothing was verified (its last message was a plan or narration). Nothing was lost: send \"continue\" to try again from here.";

#[cfg(test)]
mod tests {
    use super::*;

    const INCIDENT: &str = include_str!("../tests/fixtures/planning-loop-final-answer.txt");

    /// The model's actual closing message of the R-NATIVE-3 acceptance run 14 (15 KB of reasoning about
    /// making a tool call, no tool call): 41 edits, last check passed, 5 failed checks never re-run.
    const RUN14_TERMINAL: &str = include_str!("../tests/fixtures/run14-terminal-response.txt");

    #[test]
    fn the_actual_run14_terminal_response_was_accepted_as_fulfilled_by_the_text_only_decision() {
        assert!(RUN14_TERMINAL.len() > 10_000);
        // the existing detectors: the text IS plan-like, but the announcement cap (500 chars) and the
        // zero-edit scope of plan_like let it through
        assert!(plan_like(RUN14_TERMINAL));
        assert!(!announcement(RUN14_TERMINAL));
        assert_eq!(
            decide(true, 41, Some("pass"), RUN14_TERMINAL),
            Completion::Fulfilled
        );
        // with the run's receipts it is not fulfilled
        assert_eq!(
            decide_run(true, 41, Some("pass"), RUN14_TERMINAL, 5),
            Completion::FailingChecks
        );
        // and the failure of one check that was genuinely re-run (nothing unresolved) is unchanged
        assert_eq!(
            decide_run(true, 41, Some("pass"), "Done.", 0),
            Completion::Fulfilled
        );
    }

    #[test]
    fn the_failing_checks_note_is_plain_and_counts() {
        let one = failing_checks_note(1);
        assert!(
            one.contains("1 verification command failed and was never re-run successfully"),
            "{one}"
        );
        assert!(one.contains("blocked or unverified, not passed"), "{one}");
        let five = failing_checks_note(5);
        assert!(
            five.contains("5 verification commands failed and were never re-run"),
            "{five}"
        );
    }

    #[test]
    fn a_change_with_checks_still_failing_is_never_fulfilled_whatever_the_closing_text_says() {
        // run 14 of the R-NATIVE-3 acceptance: 41 edits, last check passed, 5 failed checks never re-run,
        // and a 15 KB closing narration that no length-capped gate looked at
        let long = "Now re-reading the files. I must make a tool call. ".repeat(300);
        assert_eq!(
            decide(true, 41, Some("pass"), &long),
            Completion::Fulfilled,
            "the text-only decision is blind to it"
        );
        assert_eq!(
            decide_run(true, 41, Some("pass"), &long, 5),
            Completion::FailingChecks
        );
        assert_eq!(
            decide_run(true, 41, Some("pass"), "Done; all checks pass.", 1),
            Completion::FailingChecks
        );
        // nothing unresolved: unchanged
        assert_eq!(
            decide_run(true, 41, Some("pass"), "Done; all checks pass.", 0),
            Completion::Fulfilled
        );
        // not an implementation task / no change: unchanged
        assert_eq!(
            decide_run(false, 0, None, "Review.", 3),
            Completion::Fulfilled
        );
        assert_eq!(
            decide_run(true, 0, Some("pass"), "Nothing to change.", 2),
            Completion::NoChangeVerified
        );
        assert_eq!(Completion::FailingChecks.as_str(), "failing-checks");
    }

    #[test]
    fn a_bare_continue_is_a_continuation_not_a_task() {
        for t in [
            "continue",
            "Continue.",
            "go on",
            "keep going please",
            "try again",
            "resume",
            "ok",
        ] {
            assert!(is_continuation(t), "{t}");
        }
        for t in [
            "Continue the migration of the parser to the new API and add tests for every module in the crate",
            "fix F1",
            "explain the bug",
        ] {
            assert!(!is_continuation(t), "{t}");
        }
    }

    #[test]
    fn implementation_requests_are_told_apart_from_questions_and_reviews() {
        for t in [
            "Implement checkpoint R-NATIVE-1 from the task file.",
            "Proceed with implementing R-NATIVE-1 now. Your previous response was a plan.",
            "Please fix the failing tests",
            "Can you add a regression test?",
            "Fix finding F1 from your previous review.",
            "Review the code and fix what you find",
            "Refactor the parser; do not change behaviour",
        ] {
            assert!(expects_change(t), "{t}");
        }
        for t in [
            "How would I implement retries here?",
            "Review this repository.",
            "Why does the parser reject empty input?",
            "Explain finding F2 in detail.",
            "What changed in the last run?",
            "Summarize what we changed for F1",
        ] {
            assert!(!expects_change(t), "{t}");
        }
    }

    #[test]
    fn the_observed_planning_loop_is_recognized_as_such() {
        assert!(plan_like(INCIDENT));
        assert!(text_tool_calls(
            "I will now call fs_edit({\"path\":\"a\"}) next."
        ));
        assert!(text_tool_calls("<tool_call>fs_read</tool_call>"));
        assert!(!text_tool_calls(
            "I changed `src/lib.rs` so add() adds; cargo test passes."
        ));
        assert!(!plan_like(
            "Added `catalog` to the bridge and the Rust RegistryTarget type. Tests: 12 pass (node), 4 pass (cargo)."
        ));
    }

    #[test]
    fn an_announcement_of_the_next_step_is_not_a_result() {
        assert!(announcement("Selection issuance is wired — now the bridge commands. Catalog, `target-info`, and `issue` with selection support."));
        assert!(announcement("Edits done, next I'll add the tests."));
        assert!(!announcement(
            "Added the catalog command and the Rust type. All tests pass (12 node, 4 cargo)."
        ));
        assert!(!announcement(
            "Fixed add() in src/lib.rs; cargo test passes."
        ));
        assert!(!announcement(""));
        assert!(!announcement(&"x".repeat(900)));
        // five edits, then an announcement and no passing check: incomplete; with a passing check it stands
        assert_eq!(
            decide(true, 5, None, "Wired — now the bridge commands."),
            Completion::Incomplete
        );
        // an earlier passing check does not finish work announced as still to do
        assert_eq!(
            decide(true, 5, Some("pass"), "Wired — now the bridge commands."),
            Completion::Incomplete
        );
        // found live (R-NATIVE-1 acceptance): results first, then an announcement of more work
        let live = "Contract tests pass (4/4) — now the new broker integration test. This needs real binaries, node, and openssl; attempting it.";
        assert!(announcement(live));
        let live3 = "broker unit tests: 53/53 · broker_a53: 22/22 — only the 3 sandbox-gated tests fail. Running the final JS suites and fmt for the report.";
        assert!(announcement(live3));
        assert!(announcement("Understood - now I will run the checks."));
        assert!(announcement(
            "Confirmed — running the full Rust suite plus the JS suites in one invocation for the final evidence."
        ));
        assert!(!announcement(
            "Fixed add(); everything passes. Nothing is left."
        ));
        assert_eq!(decide(true, 3, Some("pass"), live), Completion::Incomplete);
        // a closing report that ends on a result is not an announcement
        assert!(!announcement(
            "Contract tests pass (4/4); the broker test is done."
        ));
        assert!(!announcement("Fixed add(); cargo test passes."));
        assert_eq!(
            decide(
                true,
                3,
                Some("pass"),
                "Implemented and verified: cargo test passes (837 passed)."
            ),
            Completion::Fulfilled
        );
        assert_eq!(
            decide(
                true,
                5,
                None,
                "Added the catalog; unit tests were not run (no node tests available)."
            ),
            Completion::Fulfilled
        );
    }

    #[test]
    fn identical_progress_sentences_in_a_row_are_a_narration_loop() {
        let a =
            normalize_narration("Exploration is done — now I'll implement the catalog adapter.");
        let b =
            normalize_narration("Exploration is done - now I'll implement the catalog adapter!");
        assert_eq!(a, b);
        assert!(repeated_narration(&[a.clone(), a.clone(), a.clone()]));
        assert!(!repeated_narration(&[a.clone(), "x".into(), a.clone()]));
        assert!(!repeated_narration(&[a.clone(), a]));
    }

    #[test]
    fn only_unfulfilled_implementation_tasks_are_incomplete_and_valid_no_ops_survive() {
        // the incident: asked to implement, nothing changed, nothing verified, a plan
        assert_eq!(decide(true, 0, None, INCIDENT), Completion::Incomplete);
        assert_eq!(decide(true, 0, None, ""), Completion::Incomplete);
        // a normal coding task
        assert_eq!(
            decide(true, 3, Some("pass"), "Done."),
            Completion::Fulfilled
        );
        // valid no-ops: verified by a passing check, or a plain statement
        assert_eq!(
            decide(true, 0, Some("pass"), INCIDENT),
            Completion::NoChangeVerified
        );
        assert_eq!(
            decide(
                true,
                0,
                None,
                "The retry loop already backs off (src/net.rs:90-96); nothing to change."
            ),
            Completion::NoChangeReported
        );
        // not an implementation task: any answer is fine
        assert_eq!(decide(false, 0, None, INCIDENT), Completion::Fulfilled);
    }

    #[test]
    fn a_version_number_does_not_end_the_sentence_that_announces_the_next_step() {
        // the P0 benchmark's base arm, accepted as the final answer with item 10 never done
        assert!(announcement(
            "Item 9 is green (68 tests). Now the final item 10, version 0.5.0."
        ));
        assert!(announcement(
            "Tests pass. Next I'll bump the version to 1.2.3."
        ));
        // a finished report that mentions a version is still an ending
        assert!(!announcement("Released version 0.5.0. All tests pass."));
        assert!(!announcement(
            "All ten items are done; ledger 0.5.0 is complete."
        ));
    }
}
