//! Versioned verification-evidence contracts (Verification Engine, Phase 01).
//!
//! One [`EvidenceRecord`] describes one tool call the Core observed, using only the Kernel's
//! execution receipt and the broker's own outcome of the call. Three questions are kept apart and
//! never collapsed into one flag:
//!
//! 1. did the PROCESS run and how did it end ([`ProcessObservation`]),
//! 2. was it a RECOGNIZED check and did that check's process exit cleanly ([`CheckAssessment`]),
//! 3. are the user's REQUIREMENTS satisfied: never decided here. No type in this module can
//!    express it, so evidence can never be mistaken for correctness.
//!
//! Missing metadata stays `None` / `Unknown`; nothing is defaulted to success. A record carries no
//! command line, no argument text, no process output and no file content: only digests, exit
//! facts and bounded identifiers.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Schema version of [`EvidenceRecord`] as written now. A reader meeting a higher version must
/// not interpret it. Version 2 (Phase 03) adds `target`, `boundary` and the check `scope`;
/// version 1 records stay readable and simply carry no target identity.
pub const SCHEMA_VERSION: u32 = 2;
/// Oldest schema version this build still reads.
pub const MIN_SCHEMA_VERSION: u32 = 1;
/// Version of the recognition rules in [`classify_command`]; recorded with every command so an old
/// record is never re-read under newer rules.
pub const CLASSIFIER_VERSION: u32 = 1;

const MAX_PATH: usize = 512;

/// What the broker knows about how the call ended (its own `ToolActivity.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionState {
    /// The Kernel executed the operation and returned a receipt.
    Executed,
    /// The operation was attempted and the tool reported an error (no success claim).
    ToolFailed,
    /// Refused before execution (policy, approval, invalid arguments). Nothing ran.
    Refused,
    /// The run was cancelled around this call.
    Cancelled,
    /// The effect is unknown (lost answer from the tool runtime).
    Uncertain,
    /// The status was not one this version understands.
    Unknown,
}

impl ExecutionState {
    pub fn from_status(status: &str, error_code: Option<&str>) -> Self {
        match status {
            "executed" => Self::Executed,
            "refused" => Self::Refused,
            "cancelled" => Self::Cancelled,
            "uncertain" => Self::Uncertain,
            "failed" if error_code.is_some_and(|c| c.contains("cancel")) => Self::Cancelled,
            "failed" => Self::ToolFailed,
            _ => Self::Unknown,
        }
    }
}

/// What kind of operation the record describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservationKind {
    /// A process the Kernel was asked to run (`proc_run`).
    Command,
    /// A file change (`fs_write` / `fs_edit`).
    FileMutation,
    /// A background-job control call (`job_*`). Recorded only for its receipt and the fact that
    /// from here on something other than the mediated tools may write the workspace.
    BackgroundJob,
    /// The run's end: the daemon's final change set, used as a cross-check of the receipts
    /// (Phase 03). Not a tool call.
    RunBoundary,
}

/// Where the facts in the record come from. Model text is never a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// `kernel-receipt` (an execution id and journal sequence from the Kernel are present) or
    /// `broker-outcome` (the broker's own record of a call that has no Kernel receipt).
    pub source: String,
    /// The Kernel's backend for a command (`host` or sandboxed), when it said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Version of the recorder that wrote the record.
    pub recorder: u32,
    pub observed_at_ms: u64,
}

/// Reference to the authoritative execution receipt.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal_seq: Option<i64>,
    /// Digest of the exact arguments (never the arguments).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
}

/// How a process ended, as the Kernel reported it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessObservation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// The Kernel's own verdict (`pass` | `fail` | `unverified`). This is a statement about the
    /// exit status only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel_verdict: Option<String>,
    /// `applied` | `unsupported` | `not-applicable`, when the Kernel said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipefail: Option<String>,
}

/// Whether the command is a known verification check. Conservative by construction: anything the
/// classifier cannot prove is a single plain check command is `Indeterminate`, never `Recognized`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Recognition {
    /// A direct invocation of a known check (`cargo test`, `pytest`, ...), `family` names it.
    Recognized { family: String },
    /// Possibly a check, but the command's exit status cannot be attributed to it
    /// (shell composition such as `|| true`, `;`, pipes, redirections, or a flag that stops the
    /// check from running).
    Indeterminate { reason: String },
    /// Not a known check command.
    NotRecognized,
}

/// What can be said about a check. Deliberately has no "passed" / "satisfied" member:
/// `ProcessExitedZero` means that process exited 0 with the Kernel's pass verdict, nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CheckOutcome {
    /// The command is not a recognized check, or did not run to completion.
    NotApplicable,
    /// A recognized check's process exited 0 and the Kernel's verdict was `pass`.
    ProcessExitedZero,
    /// A recognized check's process ended unsuccessfully.
    ProcessFailed,
    /// Recognized or possibly a check, but its result proves nothing about the check.
    Inconclusive { reason: String },
    /// The receipt did not carry enough to say.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Invocation {
    /// The program named by the command ran as the process.
    Direct,
    /// A shell ran the (single) command: its exit status 126 / 127 mean "found but not
    /// executable" / "not found", reported by the shell about the inner command.
    Shell,
    /// A shell ran the check piped only through `head` / `tail` (output truncation, which cannot
    /// fail). The exit status is the check's ONLY under the Kernel's `pipefail`, so a result is
    /// trusted only when the Kernel reports `pipefail: applied`.
    ShellPipeline,
}

/// Which parts of the workspace a check's result depends on. Never declared by the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CheckScope {
    /// Conservative upper bound: the whole workspace. Used for every recognized check, whatever
    /// its filters or working directory (a test's dependencies are not known from its command).
    Workspace,
    /// The check's dependencies cannot be bounded (for example it points outside the workspace).
    Unknown { reason: String },
}

impl Default for CheckScope {
    fn default() -> Self {
        Self::Unknown {
            reason: "not-recorded".into(),
        }
    }
}

/// Scope of a recognized check command. Only structure the Core can verify is used:
/// an argument that is an absolute path or climbs out of the workspace makes the scope unknown.
/// Nothing here can narrow below the workspace; a narrower scope would need a verifiable
/// dependency declaration, which does not exist yet.
pub fn derive_scope(args: &Value) -> CheckScope {
    let escapes = |s: &str| {
        let v = s.rsplit('=').next().unwrap_or(s);
        v.starts_with('/') || v.starts_with('~') || v.split('/').any(|c| c == "..")
    };
    let mut words: Vec<&str> = Vec::new();
    if let Some(c) = args.get("cwd").and_then(Value::as_str) {
        words.push(c);
    }
    if let Some(a) = args.get("args").and_then(Value::as_array) {
        for x in a {
            match x.as_str() {
                Some(t) => words.push(t),
                None => {
                    return CheckScope::Unknown {
                        reason: "non-text-arguments".into(),
                    }
                }
            }
        }
    }
    // a `sh -c "<script>"` is judged by the words of its script
    let script: Vec<String> = words
        .iter()
        .flat_map(|w| w.split_whitespace().map(str::to_owned).collect::<Vec<_>>())
        .collect();
    if script.iter().any(|w| escapes(w)) {
        return CheckScope::Unknown {
            reason: "reaches-outside-workspace".into(),
        };
    }
    CheckScope::Workspace
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckAssessment {
    pub classifier: u32,
    /// What the dependencies of the result are. Absent in version 1 records (read as unknown).
    #[serde(default)]
    pub scope: CheckScope,
    /// Check identity: the family and the exact-argument digest of what was executed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// How the Core started it: directly, or through `sh -c` (then 126/127 are the SHELL speaking).
    /// Absent in older records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation: Option<Invocation>,
    pub recognition: Recognition,
    pub outcome: CheckOutcome,
}

/// File-change evidence from the Kernel's write receipt.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationObservation {
    /// `create` | `modify` | `delete` as the Kernel reported; absent when it did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// Workspace-relative path as the Kernel reported it (bounded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_sha256: Option<String>,
}

/// The legacy classification next to the new one, recorded for diagnostics only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowComparison {
    /// `inspect::is_verification_command` for this command.
    pub legacy_is_check: bool,
    /// The new recognizer calls it a check (`Recognized`).
    pub evidence_is_check: bool,
    /// `legacy-broader` | `evidence-broader` when they differ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRecord {
    pub schema_version: u32,
    /// Stable identity: a function of (run, call index, Kernel execution id) only.
    pub evidence_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_instance_id: Option<String>,
    pub call_index: u32,
    pub turn: u32,
    /// Model-visible tool name.
    pub tool: String,
    pub kind: ObservationKind,
    pub execution: ExecutionState,
    pub provenance: Provenance,
    pub receipt: ReceiptRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<CheckAssessment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mutation: Option<MutationObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<ShadowComparison>,
    /// What this observation was made against (Phase 03). Absent in version 1 records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<super::target::VerificationTargetV1>,
    /// Present only on the `RunBoundary` record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundaryObservation>,
}

/// The daemon's end-of-run change set compared with what the receipts predicted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryObservation {
    /// The cross-check of the daemon's change set against the receipts could be performed.
    pub cross_check: bool,
    /// Why not, when it could not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_digest: Option<String>,
    pub changed_paths: u32,
    /// Paths changed in the workspace that no mutation receipt accounts for.
    pub unreceipted_paths: u32,
    /// Whether the content of every receipted file was independently confirmed at run end.
    /// Path membership alone cannot see an outside write to an already-receipted path.
    #[serde(default)]
    pub attestation: super::attest::Attestation,
}

impl EvidenceRecord {
    /// True only for an operation the Kernel ran and receipted (a failed command is evidence of
    /// the failure). A refused, cancelled or uncertain call is a record of what happened, never
    /// evidence of an effect or a result.
    pub fn is_execution_evidence(&self) -> bool {
        matches!(
            self.execution,
            ExecutionState::Executed | ExecutionState::ToolFailed
        ) && self.receipt.execution_id.is_some()
    }

    /// A recognized check whose own process exited 0 under the Kernel's pass verdict.
    /// Still not proof that requirements are met, nor that the check covered the change.
    pub fn is_check_process_exit_zero(&self) -> bool {
        self.is_execution_evidence()
            && matches!(
                &self.check,
                Some(CheckAssessment {
                    recognition: Recognition::Recognized { .. },
                    outcome: CheckOutcome::ProcessExitedZero,
                    ..
                })
            )
    }
}

pub fn evidence_id(run_id: &str, call_index: u32, execution_id: Option<&str>) -> String {
    let mut h = Sha256::new();
    h.update(b"nexus.verification.evidence.v1\0");
    h.update(run_id.as_bytes());
    h.update([0u8]);
    h.update(call_index.to_be_bytes());
    h.update([0u8]);
    h.update(execution_id.unwrap_or("").as_bytes());
    format!("ev_{}", hex::encode(h.finalize()))
}

/// Facts taken from a confirmed tool result, captured where the broker has just received the
/// Kernel's answer. Holds no argument text and no output.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReceiptFacts {
    pub invocation: Option<Invocation>,
    /// Identity of the CHECK itself (working directory + the command words), independent of how its
    /// output was truncated: rerunning it with another `| head -n N` is the same check.
    pub check_digest: Option<String>,
    pub scope: Option<CheckScope>,
    pub process: Option<ProcessObservation>,
    pub backend: Option<String>,
    pub recognition: Option<Recognition>,
    pub legacy_is_check: Option<bool>,
    pub mutation: Option<MutationObservation>,
}

impl ReceiptFacts {
    /// `args` are the validated arguments of the proposal; `output` is the Kernel result's `output`.
    pub fn from_result(
        tool: &str,
        args: &Value,
        output: Option<&Value>,
        legacy_is_check: Option<bool>,
    ) -> Self {
        let out = output.filter(|o| !o.is_null());
        let s = |k: &str| {
            out.and_then(|o| o.get(k))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        match tool {
            "proc_run" => Self {
                process: out.map(|o| ProcessObservation {
                    exit_code: o.get("exitCode").and_then(Value::as_i64),
                    signal: o.get("signal").and_then(Value::as_str).map(str::to_owned),
                    kernel_verdict: s("verification"),
                    pipefail: s("pipefail"),
                }),
                backend: s("backend"),
                recognition: Some(classify_command(args)),
                scope: Some(derive_scope(args)),
                invocation: Some(invocation_of(args)),
                check_digest: check_digest(args),
                legacy_is_check,
                mutation: None,
            },
            "fs_write" | "fs_edit" => Self {
                mutation: out.map(|_| MutationObservation {
                    operation: s("operation"),
                    path: s("path").map(|p| p.chars().take(MAX_PATH).collect()),
                    pre_sha256: s("preSha256"),
                    post_sha256: s("postSha256"),
                }),
                ..Default::default()
            },
            _ => Self::default(),
        }
    }
}

/// Programs run directly: (program, leading arguments that make it a check).
const DIRECT_CHECKS: &[(&str, &[&str], &str)] = &[
    ("cargo", &["test"], "cargo-test"),
    ("cargo", &["check"], "cargo-check"),
    ("cargo", &["clippy"], "cargo-clippy"),
    ("cargo", &["build"], "cargo-build"),
    ("npm", &["test"], "npm-test"),
    ("npm", &["run", "test"], "npm-test"),
    ("npm", &["run", "build"], "npm-build"),
    ("npm", &["run", "lint"], "npm-lint"),
    ("npm", &["run", "typecheck"], "npm-typecheck"),
    ("pnpm", &["test"], "pnpm-test"),
    ("pnpm", &["run", "test"], "pnpm-test"),
    ("yarn", &["test"], "yarn-test"),
    ("pytest", &[], "pytest"),
    ("python", &["-m", "pytest"], "pytest"),
    ("python3", &["-m", "pytest"], "pytest"),
    ("python", &["-m", "unittest"], "unittest"),
    ("python3", &["-m", "unittest"], "unittest"),
    ("go", &["test"], "go-test"),
    ("go", &["vet"], "go-vet"),
    ("dotnet", &["test"], "dotnet-test"),
    ("dotnet", &["build"], "dotnet-build"),
    ("npx", &["vitest"], "vitest"),
    ("npx", &["jest"], "jest"),
    ("npx", &["tsc"], "tsc"),
    // Node's built-in runner. Found by the first live provider run: the model ran `node --test`
    // directly and the legacy classifier saw a check the Core did not.
    ("node", &["--test"], "node-test"),
];

/// Arguments that stop a check from running the checked code, or make its exit status uninformative.
const WEAKENING_FLAGS: &[&str] = &[
    "--no-run",
    "--help",
    "-h",
    "--version",
    "-V",
    "--list",
    "--collect-only",
    "--co",
    "--dry-run",
    "--listTests",
    "--passWithNoTests",
    "--pass-with-no-tests",
    "--exit-zero",
    "--bail=0",
];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash"];
/// Any of these in a `-c` script means the exit status may not be the check's.
const SHELL_META: &[char] = &[
    '|', '&', ';', '<', '>', '$', '`', '(', ')', '\n', '\\', '\'', '"', '*', '?', '!', '{', '}',
];

/// Recognize a check command conservatively. Direct invocations only; a shell script is accepted
/// only when it is one plain command with no composition, quoting, expansion or redirection.
/// Everything the old `is_verification_command` accepts beyond this (pipelines, `cd x && ...`,
/// `... || true`) is `Indeterminate`: the exit status of such a script is not the check's.
pub fn classify_command(args: &Value) -> Recognition {
    let prog = args.get("program").and_then(Value::as_str).unwrap_or("");
    let Some(argv) = args.get("args").and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|x| x.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()
    }) else {
        return Recognition::NotRecognized;
    };
    let Some(argv) = argv else {
        return Recognition::Indeterminate {
            reason: "non-text-arguments".into(),
        };
    };
    let prog = prog.rsplit('/').next().unwrap_or(prog);
    if SHELLS.contains(&prog) {
        let script = match argv.as_slice() {
            [flag, script] if flag == "-c" || flag == "-lc" => script,
            _ => return Recognition::NotRecognized,
        };
        if let Some(sc) = parse_shell_check(script) {
            let Some((p, rest)) = sc.words.split_first() else {
                return Recognition::NotRecognized;
            };
            return classify_direct(p, rest);
        }
        return if crate::inspect::is_verification_command(args) {
            Recognition::Indeterminate {
                reason: "shell-composition".into(),
            }
        } else {
            Recognition::NotRecognized
        };
    }
    classify_direct(prog, &argv)
}

fn classify_direct(prog: &str, argv: &[String]) -> Recognition {
    let prog = prog.rsplit('/').next().unwrap_or(prog);
    for (p, lead, family) in DIRECT_CHECKS {
        if prog == *p && argv.len() >= lead.len() && argv.iter().zip(*lead).all(|(a, l)| a == l) {
            // the check's own arguments, before any `--` passthrough
            if argv.iter().any(|a| WEAKENING_FLAGS.contains(&a.as_str())) {
                return Recognition::Indeterminate {
                    reason: "flag-prevents-check".into(),
                };
            }
            return Recognition::Recognized {
                family: (*family).into(),
            };
        }
    }
    Recognition::NotRecognized
}

/// Combine recognition with the process facts into a [`CheckAssessment`]. Only a command that ran
/// to a Kernel verdict can be anything but inconclusive/unknown.
pub fn assess(
    execution: ExecutionState,
    recognition: Option<Recognition>,
    process: Option<&ProcessObservation>,
    scope: Option<CheckScope>,
    args_digest: Option<&str>,
    invocation: Option<Invocation>,
    check_digest: Option<&str>,
) -> Option<CheckAssessment> {
    let recognition = recognition?;
    let outcome = if !matches!(
        execution,
        ExecutionState::Executed | ExecutionState::ToolFailed
    ) {
        CheckOutcome::NotApplicable
    } else {
        match (&recognition, process) {
            (Recognition::NotRecognized, _) => CheckOutcome::NotApplicable,
            (Recognition::Indeterminate { reason }, _) => CheckOutcome::Inconclusive {
                reason: reason.clone(),
            },
            (Recognition::Recognized { .. }, None) => CheckOutcome::Unknown,
            (Recognition::Recognized { .. }, Some(p))
                if invocation == Some(Invocation::ShellPipeline)
                    && p.pipefail.as_deref() != Some("applied") =>
            {
                CheckOutcome::Inconclusive {
                    reason: "pipeline-status-not-attributable".into(),
                }
            }
            (Recognition::Recognized { .. }, Some(p)) => match p.kernel_verdict.as_deref() {
                Some("pass") if p.exit_code == Some(0) && execution == ExecutionState::Executed => {
                    CheckOutcome::ProcessExitedZero
                }
                Some("fail") => CheckOutcome::ProcessFailed,
                Some("unverified") => CheckOutcome::Inconclusive {
                    reason: "exit-status-unattributable".into(),
                },
                _ => CheckOutcome::Unknown,
            },
        }
    };
    let identity = match &recognition {
        Recognition::Recognized { family } => Some(format!(
            "{family}:{}",
            check_digest.or(args_digest).unwrap_or("-")
        )),
        _ => None,
    };
    Some(CheckAssessment {
        classifier: CLASSIFIER_VERSION,
        scope: scope.unwrap_or_default(),
        identity,
        invocation,
        recognition,
        outcome,
    })
}

/// A shell script that is ONE command, optionally with its stderr merged (`2>&1`) and its output
/// truncated through `head` / `tail`. Nothing else: no `||`, `&&`, `;`, other pipes (`grep` and `tee`
/// can change or fail the status), redirects, quoting, expansion or environment prefixes.
pub struct ShellCheck {
    pub words: Vec<String>,
    pub pipeline: bool,
}

fn is_filter_arg(prev: Option<&str>, w: &str) -> bool {
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    match w {
        "-n" | "-c" => true,
        _ if digits(w) => matches!(prev, Some("-n" | "-c")),
        _ => {
            let r = w.strip_prefix('-').unwrap_or("");
            digits(r) || (r.len() > 1 && matches!(&r[..1], "n" | "c") && digits(&r[1..]))
        }
    }
}

pub fn parse_shell_check(script: &str) -> Option<ShellCheck> {
    // the only metacharacters allowed are the pipe and the standalone `2>&1`
    let spaced = script.replace('|', " | ");
    let words: Vec<&str> = spaced.split_whitespace().filter(|w| *w != "2>&1").collect();
    let rest = words
        .iter()
        .filter(|w| **w != "|")
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    if rest.contains(SHELL_META) || words.iter().any(|w| *w != "|" && w.contains('=')) {
        return None;
    }
    let mut segs: Vec<Vec<&str>> = vec![vec![]];
    for w in &words {
        if *w == "|" {
            segs.push(vec![]);
        } else {
            segs.last_mut().unwrap().push(w);
        }
    }
    if segs.iter().any(|s| s.is_empty()) {
        return None;
    }
    for filt in &segs[1..] {
        if !matches!(filt[0], "head" | "tail") {
            return None;
        }
        let mut prev: Option<&str> = None;
        for w in &filt[1..] {
            if !is_filter_arg(prev, w) {
                return None;
            }
            prev = Some(w);
        }
    }
    Some(ShellCheck {
        words: segs[0].iter().map(|s| (*s).to_owned()).collect(),
        pipeline: segs.len() > 1,
    })
}

fn program_of(args: &Value) -> &str {
    let p = args.get("program").and_then(Value::as_str).unwrap_or("");
    p.rsplit('/').next().unwrap_or(p)
}

fn shell_script(args: &Value) -> Option<String> {
    if !SHELLS.contains(&program_of(args)) {
        return None;
    }
    let a = args.get("args")?.as_array()?;
    match a.as_slice() {
        [flag, script] if matches!(flag.as_str(), Some("-c" | "-lc")) => {
            script.as_str().map(str::to_owned)
        }
        _ => None,
    }
}

pub fn invocation_of(args: &Value) -> Invocation {
    match shell_script(args) {
        None => Invocation::Direct,
        Some(s) => match parse_shell_check(&s) {
            Some(c) if c.pipeline => Invocation::ShellPipeline,
            _ => Invocation::Shell,
        },
    }
}

/// Digest of the check ITSELF: working directory plus the command words. A directly started check and
/// the same check run through a shell (with its output truncated or not) are the same check.
pub fn check_digest(args: &Value) -> Option<String> {
    let words: Vec<String> = match shell_script(args) {
        Some(s) => parse_shell_check(&s)?.words,
        None => {
            let mut w = vec![program_of(args).to_owned()];
            for x in args.get("args")?.as_array()? {
                w.push(x.as_str()?.to_owned());
            }
            w
        }
    };
    let cwd = match args.get("cwd").and_then(Value::as_str) {
        None | Some("") | Some("./") | Some(".") => ".",
        Some(c) => c.trim_end_matches('/'),
    };
    let mut h = Sha256::new();
    h.update(b"nexus.verification.check.v1\0");
    h.update(cwd.as_bytes());
    for w in &words {
        h.update([0]);
        h.update(w.as_bytes());
    }
    Some(hex::encode(h.finalize()))
}
