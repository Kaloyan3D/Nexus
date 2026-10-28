//! A7.1: persistent, multi-turn conversations ("threads") over the autonomous coding loop.
//!
//! A *conversation* (thread) is a durable, project-associated discussion made of
//! *messages* (the user's requests, the assistant's answers, runtime notes) and *runs*
//! (each autonomous execution started by one request). One conversation supports any
//! number of consecutive runs; each run keeps its own record, working copy and receipts.
//!
//! The provider conversation is stateless, so continuity is a property of what the broker
//! puts into each run's first model turn - NOT of what the UI displays. Before a run starts
//! the broker reconstructs a bounded *context* from the conversation's durable record:
//! the earlier requests, the latest answers (older ones shortened), an index of findings
//! ("F1", "F2", ...) with what later runs did about them, and per run the RUNTIME's own
//! evidence (files changed, commands and verdicts, how it ended) plus how the working copy
//! relates to earlier runs. It never replays raw transcripts and it is deterministic.
//!
//! Storage (broker state dir, owner-only):
//!   `threads/<id>.json`  metadata, runs with their evidence digests, findings (atomic rewrite)
//!   `threads/<id>.log`   messages, one JSON object per line (append-only, fsync'd)
//!
//! Authority is unchanged: a conversation grants nothing. Every run is a normal `repo-code`
//! run with its own isolated copy, limits, consent and receipts. A read-only request is
//! enforced by the broker's proposal gate (writes are refused), not by the model's manners.

use crate::server::Broker;
use nexus_client::intent_client::{IntentRun, ToolActivity};
use nexus_contracts::intent::NexusIntentV1;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const THREAD_SCHEMA: u32 = 1;
/// Longest single stored message (answers are reports; the rest is cut with a marker).
pub const MAX_MESSAGE_BYTES: usize = 96 * 1024;
/// What the reconstructed context of earlier runs may occupy in the first model turn.
pub const CONTEXT_BUDGET_BYTES: usize = 48 * 1024;
const MAX_TITLE_CHARS: usize = 80;
const MAX_RECEIPTS: usize = 120;

type CmdResult = Result<Value, (&'static str, String)>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------------- model

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub seq: u64,
    /// `user` | `assistant` | `system`
    pub role: String,
    /// `request` | `answer` | `note`
    pub kind: String,
    pub run_id: Option<String>,
    pub at_ms: u64,
    pub text: String,
    #[serde(default)]
    pub truncated: bool,
}

/// One executed edit or command, as the runtime recorded it (never model text).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub tool: String,
    pub summary: String,
    /// `executed` | `refused` | `failed` | `cancelled`
    pub status: String,
    /// Commands only: `pass` / `fail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
}

/// What the runtime knows about a finished run, kept even when the run record's bounded
/// activity list has rolled over.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunDigest {
    /// Files this run edited/wrote/deleted successfully.
    pub files_touched: Vec<String>,
    /// Every file that differs from the project snapshot in the run's copy at its end.
    pub changed_total: Vec<String>,
    pub edits_applied: u32,
    pub receipts: Vec<Receipt>,
    /// `verified-passed` | `verified-failed` | `no-test-executed` | ...
    pub verification: String,
    pub change: String,
    pub last_test: Option<String>,
    pub turns: u32,
    pub tool_calls: u32,
    pub recoveries: u32,
    pub compactions: u32,
    pub stop_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub citations_verified: u32,
    pub citations_unverified: u32,
}

/// What the model was given from the conversation when a run started (the text itself is
/// reproducible from the stored record; the digest and sizes are the evidence it was sent).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub bytes: u64,
    pub sha256: String,
    /// Earlier runs of the conversation the context draws on.
    pub prior_runs: u32,
    pub findings: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRun {
    pub run_id: String,
    /// 1-based position in the conversation.
    pub n: u32,
    /// The user message that started it (absent on automatic continuations).
    pub user_seq: Option<u64>,
    pub assistant_seq: Option<u64>,
    /// `review` (read-only) | `edit`
    pub mode: String,
    pub read_only: bool,
    /// Why the mode is what it is (shown to the user).
    pub mode_reason: String,
    pub continuation_of: Option<String>,
    pub state: String,
    pub ended: bool,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub digest: Option<RunDigest>,
    /// Set when the run started after earlier runs: what it was given of them.
    #[serde(default)]
    pub context: Option<ContextInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// `F1`, `F2`, ...
    pub id: String,
    pub title: String,
    pub detail: String,
    pub run_id: String,
    /// The run (1-based) that edited code in response to a request naming this finding.
    pub addressed_in: Option<u32>,
    pub addressed_verification: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTarget {
    pub provider_id: String,
    pub logical_model_id: String,
    pub remote_model_id: String,
    pub route_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_limit_tokens: Option<u64>,
    /// Phase 2: the Engineering Mode the conversation was started under (absent = the default
    /// `engineering-v2`, exactly as every conversation before this field). A conversation keeps its
    /// engine: it is never silently migrated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub schema: u32,
    pub thread_id: String,
    pub client_id: String,
    pub project_id: String,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub archived: bool,
    /// Built from single-run records that predate conversations.
    pub legacy: bool,
    pub next_seq: u64,
    pub message_count: u64,
    pub last_preview: String,
    pub runs: Vec<ThreadRun>,
    pub findings: Vec<Finding>,
    /// R-NATIVE-2: the conversation's bound target identity (identity only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ThreadTarget>,
}

// ------------------------------------------------------------------------- store

pub fn valid_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.starts_with("thr_")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(p) = path.parent() {
        if let Ok(d) = std::fs::File::open(p) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

pub struct ThreadStore {
    dir: PathBuf,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl ThreadStore {
    pub fn open(state_dir: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        let dir = state_dir.join("threads");
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            dir,
            locks: Mutex::new(HashMap::new()),
        })
    }

    /// The mutex serializing every read-modify-write of ONE conversation. Two conversations
    /// never contend, so a slow send in one cannot stall or corrupt another.
    pub fn mutex(&self, id: &str) -> Arc<Mutex<()>> {
        let mut g = self.locks.lock().unwrap_or_else(|p| p.into_inner());
        g.entry(id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
    fn log_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.log"))
    }

    pub fn load(&self, id: &str) -> Option<Thread> {
        if !valid_thread_id(id) {
            return None;
        }
        let raw = std::fs::read(self.meta_path(id)).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    pub fn put(&self, t: &Thread) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(t).map_err(std::io::Error::other)?;
        write_atomic(&self.meta_path(&t.thread_id), &bytes)
    }

    pub fn ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(id) = name.strip_suffix(".json") {
                    if valid_thread_id(id) {
                        out.push(id.to_owned());
                    }
                }
            }
        }
        out
    }

    pub fn all(&self) -> Vec<Thread> {
        let mut v: Vec<Thread> = self.ids().iter().filter_map(|i| self.load(i)).collect();
        v.sort_by_key(|t| std::cmp::Reverse(t.updated_at_ms));
        v
    }

    /// Messages in order. A torn last line (crash mid-append) is ignored.
    pub fn messages(&self, id: &str) -> Vec<Message> {
        let Ok(raw) = std::fs::read_to_string(self.log_path(id)) else {
            return Vec::new();
        };
        let mut out: Vec<Message> = raw
            .lines()
            .filter_map(|l| serde_json::from_str::<Message>(l).ok())
            .collect();
        out.sort_by_key(|m| m.seq);
        out.dedup_by_key(|m| m.seq);
        out
    }

    pub fn append(&self, id: &str, m: &Message) -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut line = serde_json::to_string(m).map_err(std::io::Error::other)?;
        line.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.log_path(id))?;
        f.write_all(line.as_bytes())?;
        f.sync_data()
    }
}

fn clip(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_owned()
    } else {
        let mut o: String = s.chars().take(max_chars.saturating_sub(1)).collect();
        o.push('…');
        o
    }
}

/// Keep the head and the tail of a long text (a report's findings AND its conclusion).
fn head_tail(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n <= max_chars {
        return s.to_owned();
    }
    let head = max_chars * 3 / 4;
    let tail = max_chars.saturating_sub(head);
    let h: String = s.chars().take(head).collect();
    let t: String = s.chars().skip(n - tail).collect();
    format!(
        "{h}\n[… {} characters omitted to keep the context short …]\n{t}",
        n - head - tail
    )
}

fn bounded_message_text(s: &str) -> (String, bool) {
    if s.len() <= MAX_MESSAGE_BYTES {
        return (s.to_owned(), false);
    }
    let mut end = MAX_MESSAGE_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!(
            "{}\n[… cut at {} KiB …]",
            &s[..end],
            MAX_MESSAGE_BYTES / 1024
        ),
        true,
    )
}

// ------------------------------------------------------------------ request mode

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeDecision {
    pub read_only: bool,
    pub reason: &'static str,
}

fn tokens(clause: &str) -> Vec<String> {
    clause
        .to_lowercase()
        .replace('\u{2019}', "'")
        .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '-'))
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

const CHANGE_VERBS: &[&str] = &[
    "change",
    "changing",
    "edit",
    "editing",
    "modify",
    "modifying",
    "touch",
    "touching",
    "write",
    "writing",
    "alter",
    "altering",
    "update",
    "updating",
    "delete",
    "deleting",
    "create",
    "creating",
    "make",
    "making",
    "overwrite",
];
const OBJECTS: &[&str] = &[
    "file",
    "files",
    "code",
    "codebase",
    "source",
    "anything",
    "repo",
    "repository",
    "project",
    "changes",
    "edits",
    "modifications",
    "sources",
];
const EXCEPT: &[&str] = &["except", "besides", "apart", "outside", "unless", "other"];
/// "Do not modify the ORIGINAL repository" restates where changes go (Nexus never touches the
/// original); it is not an instruction to change nothing. Found live: it made an
/// "Implement checkpoint R-NATIVE-1" task read-only.
const PROTECTED_TARGET: &[&str] = &[
    "original",
    "upstream",
    "remote",
    "production",
    "prod",
    "live",
    "origin",
    "main",
    "master",
];
/// Verbs that make a request a request for CHANGES (used by the review-intent heuristic).
const REQUEST_CHANGE_VERBS: &[&str] = &[
    "fix",
    "implement",
    "add",
    "change",
    "edit",
    "modify",
    "write",
    "refactor",
    "remove",
    "delete",
    "update",
    "create",
    "rename",
    "apply",
    "patch",
    "make",
    "build",
    "rewrite",
    "replace",
    "migrate",
    "convert",
    "install",
    "introduce",
    "extract",
    "move",
    "improve",
    "optimize",
    "optimise",
    "resolve",
    "address",
    "correct",
    "adopt",
];
const REVIEW_STARTS: &[&str] = &[
    "review",
    "audit",
    "explain",
    "analyze",
    "analyse",
    "inspect",
    "investigate",
    "describe",
    "summarize",
    "summarise",
    "why",
    "what",
    "how",
    "where",
    "which",
    "list",
    "show",
    "walk",
    "tell",
    "look",
    "check",
    "assess",
    "evaluate",
    "examine",
    "is",
    "are",
    "does",
    "do",
    "can",
];

fn negated_change(clause: &[String]) -> bool {
    for i in 0..clause.len() {
        let t = clause[i].as_str();
        // where the negation phrase ends
        let after = match t {
            "don't" | "dont" | "never" | "without" | "avoid" => i + 1,
            "do" | "must" | "should" | "will" | "can" | "could"
                if clause.get(i + 1).map(String::as_str) == Some("not")
                    || clause.get(i + 1).map(String::as_str) == Some("never") =>
            {
                i + 2
            }
            "cannot" | "can't" | "mustn't" | "shouldn't" | "won't" => i + 1,
            "no" => {
                // "no changes", "no file changes", "no edits"
                let mut j = i + 1;
                if matches!(
                    clause.get(j).map(String::as_str),
                    Some("file" | "files" | "code")
                ) {
                    j += 1;
                }
                if matches!(
                    clause.get(j).map(String::as_str),
                    Some("changes" | "edits" | "modifications" | "change" | "edit" | "writes")
                ) {
                    let rest = &clause[j + 1..];
                    // "no changes to the API" is not "no file changes"
                    if rest.is_empty()
                        || rest.len() <= 2 && !rest.iter().any(|w| w == "to" || w == "in")
                        || rest.first().map(String::as_str) == Some("to")
                            && rest
                                .iter()
                                .skip(1)
                                .take(3)
                                .any(|w| OBJECTS.contains(&w.as_str()))
                    {
                        return !rest.iter().any(|w| EXCEPT.contains(&w.as_str()));
                    }
                }
                continue;
            }
            _ => continue,
        };
        let Some(verb) = clause.get(after) else {
            continue;
        };
        // "please", "make any" etc. between the negation and the verb are not skipped on purpose
        if !CHANGE_VERBS.contains(&verb.as_str()) {
            continue;
        }
        let rest = &clause[after + 1..];
        if rest
            .iter()
            .take(5)
            .any(|w| PROTECTED_TARGET.contains(&w.as_str()))
        {
            continue;
        }
        if rest.iter().any(|w| EXCEPT.contains(&w.as_str())) {
            continue;
        }
        let window: Vec<&String> = rest.iter().take(4).collect();
        // "don't touch .env files", "do not modify .git or ...": the generic
        // object is qualified by a SPECIFIC named target first, so the
        // negation covers that target only. A generic object reached only
        // through filler ("any files", "the code") is a global prohibition.
        const FILLER: &[&str] = &[
            "any", "anything", "the", "a", "an", "all", "please", "this", "that", "these", "those",
            "my", "your", "our", "their", "its", "no", "some",
        ];
        let obj = match window.iter().position(|w| OBJECTS.contains(&w.as_str())) {
            Some(0) => true,
            Some(j) => !rest[..j].iter().any(|w| !FILLER.contains(&w.as_str())),
            None => false,
        };
        let bare = rest.is_empty()
            || rest.iter().all(|w| {
                matches!(
                    w.as_str(),
                    "please" | "anything" | "any" | "at" | "all" | "to" | "it"
                )
            });
        if obj || bare {
            return true;
        }
    }
    false
}

/// Does the text carry an explicit instruction not to change anything?
pub fn explicit_read_only(text: &str) -> bool {
    let all = tokens(text);
    let has_change_verb = all
        .iter()
        .any(|t| REQUEST_CHANGE_VERBS.contains(&t.as_str()));
    // read-only phrases
    for i in 0..all.len() {
        let t = all[i].as_str();
        let phrase_end = match t {
            "read-only" | "readonly" => Some(i + 1),
            "read" if all.get(i + 1).map(String::as_str) == Some("only") => Some(i + 2),
            _ => None,
        };
        if let Some(end) = phrase_end {
            let next = all.get(end).map(String::as_str).unwrap_or("");
            let prev = if i > 0 { all[i - 1].as_str() } else { "" };
            let framed = matches!(
                next,
                "review"
                    | "audit"
                    | "analysis"
                    | "investigation"
                    | "task"
                    | "mode"
                    | "pass"
                    | "inspection"
                    | "request"
                    | "report"
                    | "look"
                    | "session"
                    | "run"
                    | "assessment"
            ) || matches!(
                prev,
                "be" | "stay"
                    | "keep"
                    | "remain"
                    | "is"
                    | "in"
                    | "as"
                    | "strictly"
                    | "purely"
                    | "a"
                    | "this"
                    | "it"
                    | "run"
                    | "do"
                    | "make"
            ) && !matches!(prev, "make");
            if !has_change_verb || framed {
                return true;
            }
        }
        if (t == "only" || t == "just")
            && matches!(
                all.get(i + 1).map(String::as_str),
                Some(
                    "review"
                        | "explain"
                        | "inspect"
                        | "analyze"
                        | "analyse"
                        | "audit"
                        | "look"
                        | "read"
                        | "investigate"
                )
            )
            && !has_change_verb
        {
            return true;
        }
        // "Review only", "explain only": the mirror image of the branch above
        if t == "only"
            && matches!(
                if i > 0 { all[i - 1].as_str() } else { "" },
                "review"
                    | "explain"
                    | "inspect"
                    | "analyze"
                    | "analyse"
                    | "audit"
                    | "look"
                    | "read"
                    | "investigate"
            )
            && !has_change_verb
        {
            return true;
        }
        if matches!(t, "review-only" | "explain-only") {
            return true;
        }
    }
    // negated change instructions, clause by clause
    for clause in clauses(text) {
        let toks = tokens(&clause);
        if negated_change(&toks) {
            return true;
        }
    }
    false
}

/// Split into clauses on sentence punctuation. A `.` only separates when it
/// ends a sentence (followed by whitespace or the end of the text): the dot
/// in `.git`, `src/lib.rs` or `1.5` is part of a name, and splitting there
/// would truncate "Do not modify .git ..." to a bare "Do not modify" and
/// misread a path-specific restriction as a global prohibition.
fn clauses(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, c) in chars.iter().enumerate() {
        let sep = match c {
            ';' | '!' | '?' | '\n' | ',' | '(' | ')' | ':' => true,
            '.' => chars.get(i + 1).is_none_or(|n| n.is_whitespace()),
            _ => false,
        };
        if sep {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(*c);
        }
    }
    out.push(cur);
    out
}

/// Decide whether a request may change files. Restrictions the user typed always win; the
/// automatic review heuristic only ever REMOVES write access, never grants it.
pub fn classify_mode(text: &str, requested: &str) -> ModeDecision {
    if explicit_read_only(text) {
        return ModeDecision {
            read_only: true,
            reason: "you asked not to change any files",
        };
    }
    match requested {
        "review" => ModeDecision {
            read_only: true,
            reason: "review mode was selected",
        },
        "edit" => ModeDecision {
            read_only: false,
            reason: "changes were allowed for this request",
        },
        _ => {
            let toks = tokens(text);
            let first = toks.first().map(String::as_str).unwrap_or("");
            let first = if matches!(first, "please" | "now" | "ok" | "okay" | "so" | "then") {
                toks.get(1).map(String::as_str).unwrap_or("")
            } else {
                first
            };
            let wants_change = toks
                .iter()
                .any(|t| REQUEST_CHANGE_VERBS.contains(&t.as_str()));
            if REVIEW_STARTS.contains(&first) && !wants_change {
                ModeDecision {
                    read_only: true,
                    reason: "this looks like a review or question; no files are changed",
                }
            } else {
                ModeDecision {
                    read_only: false,
                    reason: "changes are allowed in an isolated copy",
                }
            }
        }
    }
}

// ---------------------------------------------------------------------- findings

fn is_markup(c: char) -> bool {
    matches!(
        c,
        '#' | '>' | '-' | '*' | '|' | '_' | '`' | ' ' | '\t' | '•' | '–' | '—'
    )
}

/// `### F1 — Title`, `**F2.** Title`, `1. **F3**: Title`, `| F4 | High | Title |` -> (id, rest)
fn finding_head(line: &str) -> Option<(String, String)> {
    let mut t = line.trim().trim_start_matches(is_markup);
    // numbered list "3." / "3)"
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && matches!(t.as_bytes().get(digits), Some(b'.' | b')')) {
        t = t[digits + 1..].trim_start_matches(is_markup);
    }
    for pfx in ["finding ", "Finding ", "FINDING "] {
        if let Some(r) = t.strip_prefix(pfx) {
            t = r.trim_start_matches(is_markup);
            break;
        }
    }
    let b = t.as_bytes();
    if b.first() != Some(&b'F') {
        return None;
    }
    let d = b[1..].iter().take_while(|c| c.is_ascii_digit()).count();
    if d == 0 || d > 3 {
        return None;
    }
    if b.get(1 + d).is_some_and(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let n: u32 = t[1..1 + d].parse().ok()?;
    if n == 0 {
        return None;
    }
    let rest = t[1 + d..]
        .trim_start_matches(|c: char| {
            c != '`' && (is_markup(c) || matches!(c, ':' | '.' | ')' | ']' | '(' | '['))
        })
        .trim_end_matches(['*', '_', '|', ' ', '\t', '#'])
        .replace(" | ", " — ");
    Some((format!("F{n}"), rest))
}

/// Pull the numbered findings out of an answer (best effort, no model involved).
pub fn extract_findings(text: &str, run_id: &str) -> Vec<Finding> {
    let lines: Vec<&str> = text.lines().collect();
    let mut found: Vec<Finding> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some((id, title)) = finding_head(lines[i]) {
            let mut detail = String::new();
            let mut j = i + 1;
            while j < lines.len() && j < i + 14 && detail.len() < 900 {
                let l = lines[j];
                if finding_head(l).is_some() {
                    break;
                }
                if l.trim_start().starts_with('#') && !detail.trim().is_empty() {
                    break;
                }
                let tl = l.trim();
                if !tl.is_empty() {
                    if !detail.is_empty() {
                        detail.push(' ');
                    }
                    detail.push_str(tl);
                }
                j += 1;
            }
            let f = Finding {
                id: id.clone(),
                title: clip(&title, 200),
                detail: clip(&detail, 900),
                run_id: run_id.to_owned(),
                ..Default::default()
            };
            match found.iter_mut().find(|x| x.id == id) {
                Some(prev) => {
                    // the same id appears again (summary table + detailed section): keep the richer
                    if f.title.len() + f.detail.len() > prev.title.len() + prev.detail.len() {
                        *prev = f;
                    }
                }
                None => found.push(f),
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    found
}

/// Finding ids a request names ("fix F1 and F3", "finding f2").
pub fn mentioned_findings(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if (b[i] == b'F' || b[i] == b'f') && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
            let d = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if (1..=3).contains(&d) && !b.get(i + 1 + d).is_some_and(|c| c.is_ascii_alphanumeric())
            {
                if let Ok(n) = text[i + 1..i + 1 + d].parse::<u32>() {
                    let id = format!("F{n}");
                    if n > 0 && !out.contains(&id) {
                        out.push(id);
                    }
                }
                i += 1 + d;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A newer REVIEW that lists several findings replaces the older list ("F1" then means the
/// new F1); anything else only adds ids it introduces and never rewrites a known finding.
pub fn merge_findings(existing: &mut Vec<Finding>, new: Vec<Finding>, replaces: bool) {
    let report = replaces && new.len() >= 2;
    for f in new {
        match existing.iter_mut().find(|x| x.id == f.id) {
            None => existing.push(f),
            Some(old) if report && old.run_id != f.run_id => {
                let same = old.title.eq_ignore_ascii_case(&f.title);
                let keep = (old.addressed_in, old.addressed_verification.clone());
                *old = f;
                if same {
                    old.addressed_in = keep.0;
                    old.addressed_verification = keep.1;
                }
            }
            Some(_) => {}
        }
    }
    existing.sort_by_key(|f| f.id[1..].parse::<u32>().unwrap_or(u32::MAX));
}

// ----------------------------------------------------------------------- digest

fn last_token(summary: &str) -> String {
    summary
        .split_whitespace()
        .last()
        .unwrap_or("?")
        .trim_matches('"')
        .to_owned()
}

/// The runtime's evidence about a finished run, from its receipts.
pub fn digest_of(run: &IntentRun, activity: &[ToolActivity]) -> RunDigest {
    let mut d = RunDigest {
        turns: run.turn,
        tool_calls: run.tool_calls,
        recoveries: run.recoveries,
        compactions: run.context_compactions,
        stop_reason: run.stop_reason.clone(),
        error_code: run.error_code.clone(),
        error_message: run.error_message.clone().map(|m| clip(&m, 400)),
        citations_verified: run.citations_verified.len() as u32,
        citations_unverified: run.citations_unverified.len() as u32,
        last_test: run.last_test_verification.clone(),
        ..Default::default()
    };
    for a in activity {
        let edit = matches!(a.tool.as_str(), "fs_edit" | "fs_write");
        let cmd = a.tool == "proc_run";
        if !edit && !cmd {
            continue;
        }
        if edit && a.status == "executed" {
            let f = last_token(&a.args_summary);
            if !d.files_touched.contains(&f) {
                d.files_touched.push(f);
            }
            d.edits_applied += 1;
        }
        if d.receipts.len() < MAX_RECEIPTS {
            d.receipts.push(Receipt {
                tool: a.tool.clone(),
                summary: clip(&a.args_summary, 160),
                status: a.status.clone(),
                verdict: if cmd && a.status == "executed" {
                    a.verification.clone()
                } else {
                    None
                },
            });
        }
    }
    d.changed_total = run
        .changed_files
        .iter()
        .take(60)
        .map(|f| f.path.clone())
        .collect();
    if let Some(o) = nexus_client::intent_client::derive_coding_outcome(run) {
        d.verification = o.verification;
        d.change = o.change;
    }
    d
}

// --------------------------------------------------------------------- context

/// How the new run's working copy relates to the conversation's earlier work.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceFacts {
    /// `fresh` | `continued` | `rebased` | `fresh-by-choice`
    pub relation: String,
    pub from_run_n: Option<u32>,
    pub note: Option<String>,
    /// Files that differ from the project snapshot in the copy the run starts from.
    pub changed: Vec<String>,
}

struct Level {
    request_cap: usize,
    /// how many of the latest answers are kept (nearly) whole
    full_answers: usize,
    full_cap: usize,
    older_cap: usize,
    finding_detail: usize,
    /// runs older than this many are collapsed to one line
    keep_runs: usize,
}

const LEVELS: [Level; 6] = [
    Level {
        request_cap: 4000,
        full_answers: 2,
        full_cap: 32_000,
        older_cap: 3500,
        finding_detail: 600,
        keep_runs: 40,
    },
    Level {
        request_cap: 1500,
        full_answers: 1,
        full_cap: 32_000,
        older_cap: 1200,
        finding_detail: 400,
        keep_runs: 40,
    },
    Level {
        request_cap: 600,
        full_answers: 1,
        full_cap: 14_000,
        older_cap: 500,
        finding_detail: 300,
        keep_runs: 20,
    },
    Level {
        request_cap: 300,
        full_answers: 1,
        full_cap: 6_000,
        older_cap: 250,
        finding_detail: 200,
        keep_runs: 10,
    },
    Level {
        request_cap: 200,
        full_answers: 0,
        full_cap: 0,
        older_cap: 300,
        finding_detail: 160,
        keep_runs: 4,
    },
    Level {
        request_cap: 160,
        full_answers: 0,
        full_cap: 0,
        older_cap: 160,
        finding_detail: 0,
        keep_runs: 1,
    },
];

fn evidence_line(tr: &ThreadRun) -> String {
    let Some(d) = &tr.digest else {
        return format!(
            "Runtime record: the run is {} (no evidence digest was kept).",
            tr.state
        );
    };
    let mut parts: Vec<String> = Vec::new();
    if d.files_touched.is_empty() {
        parts.push("this run changed no file".into());
    } else {
        parts.push(format!("this run changed: {}", d.files_touched.join(", ")));
    }
    let cmds: Vec<String> = d
        .receipts
        .iter()
        .filter(|r| r.tool == "proc_run" && r.status == "executed")
        .map(|r| {
            format!(
                "`{}` -> {}",
                r.summary,
                r.verdict.as_deref().unwrap_or("no verdict")
            )
        })
        .collect();
    if !cmds.is_empty() {
        let keep = cmds.len().saturating_sub(6);
        parts.push(format!("commands run: {}", cmds[keep..].join("; ")));
    }
    if !d.verification.is_empty() {
        parts.push(format!("runtime-verified outcome: {}", d.verification));
    }
    let refused = d.receipts.iter().filter(|r| r.status == "refused").count();
    if refused > 0 {
        parts.push(format!("{refused} proposed operation(s) were refused"));
    }
    let mut end = if d.stop_reason.as_deref() == Some("no-implementation") {
        if d.files_touched.is_empty() {
            "ended: INCOMPLETE - the model answered with a plan and changed nothing; this request still has to be implemented".to_owned()
        } else {
            "ended: INCOMPLETE - the model stopped before finishing; the changes above are kept in the working copy and the request still has to be completed".to_owned()
        }
    } else {
        format!("ended: {}", tr.state)
    };
    if let Some(m) = d.error_message.as_deref().or(d.stop_reason.as_deref()) {
        end.push_str(&format!(" ({})", clip(m, 200)));
    }
    if tr.state == "uncertain" {
        end.push_str(" - an operation may or may not have been applied: inspect the files before relying on them");
    }
    parts.push(end);
    format!("Runtime record: {}.", parts.join("; "))
}

fn finding_status(f: &Finding) -> String {
    match (f.addressed_in, f.addressed_verification.as_deref()) {
        (Some(n), Some(v)) if !v.is_empty() => {
            format!("addressed in run {n}; runtime-verified outcome: {v}")
        }
        (Some(n), _) => format!("addressed in run {n}"),
        _ => "open".to_owned(),
    }
}

fn render(
    th: &Thread,
    msgs: &[Message],
    prior: &[&ThreadRun],
    ws: &WorkspaceFacts,
    lv: &Level,
    omit_oldest: usize,
) -> String {
    let by_seq = |s: Option<u64>| s.and_then(|s| msgs.iter().find(|m| m.seq == s));
    let mut s = String::new();
    s.push_str(
        "## Conversation context (Nexus's durable record)\n\
         This is NOT the first request of this conversation. Below is Nexus's own record of the earlier requests, your earlier answers and what the runtime verified in earlier runs. Treat it as your own memory: references such as \"F1\", \"the previous fix\" or \"the tests you ran\" point into it. Never ask the user to repeat or paste anything from it. Files may have changed since your answer: re-read a file before you edit it.\n\n",
    );
    // the findings come first: they are what the user's shorthand points at, and they are the
    // last thing any compaction may give up
    if !th.findings.is_empty() {
        s.push_str("### Findings index (the numbering the user refers to)\n");
        for f in &th.findings {
            s.push_str(&format!("- {} — {} [{}]", f.id, f.title, finding_status(f)));
            if lv.finding_detail > 0 && !f.detail.is_empty() {
                s.push_str(&format!(" — {}", clip(&f.detail, lv.finding_detail)));
            }
            s.push('\n');
        }
        s.push('\n');
    }
    s.push_str("### Working copy for this run\n");
    match ws.relation.as_str() {
        "continued" | "rebased" => {
            s.push_str(&format!(
                "It starts from the working copy of run {}, so every change listed below is already in it{}.\n",
                ws.from_run_n.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
                ws.note.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()
            ));
            if !ws.changed.is_empty() {
                let shown: Vec<&str> = ws.changed.iter().take(30).map(String::as_str).collect();
                s.push_str(&format!("Files that differ from the project's original: {}.\n", shown.join(", ")));
            }
        }
        "direct" => s.push_str("This run edits the user's project folder directly. Changes made by earlier runs of this conversation are already in those files (unless the user changed them since); read a file again before editing it.\n"),
        "fresh-by-choice" => s.push_str("The user chose to start from the project's CURRENT files: changes from earlier runs are NOT in this copy.\n"),
        _ => s.push_str("It is a fresh copy of the project's current files (no earlier changes are in it).\n"),
    }
    s.push('\n');
    let n_prior = prior.len();
    let visible = &prior[omit_oldest.min(n_prior)..];
    if omit_oldest > 0 {
        s.push_str(&format!(
            "({} oldest runs are not listed to keep this short; their findings are in the index above.)\n",
            omit_oldest.min(n_prior)
        ));
    }
    let collapsed = visible.len().saturating_sub(lv.keep_runs.max(1));
    if collapsed > 0 {
        s.push_str(&format!(
            "({collapsed} earlier runs are summarized in one line each.)\n"
        ));
    }
    for (idx, tr) in visible.iter().enumerate() {
        let user = by_seq(tr.user_seq);
        let ans = by_seq(tr.assistant_seq);
        let from_end = visible.len() - idx; // 1 = latest
        let compact_line = idx < collapsed;
        let mode = if tr.read_only {
            "read-only"
        } else {
            "may change files"
        };
        s.push_str(&format!("### Run {} ({mode})\n", tr.n));
        match user {
            Some(u) => s.push_str(&format!(
                "User request: {}\n",
                clip(
                    u.text.trim(),
                    if compact_line { 160 } else { lv.request_cap }
                )
            )),
            None => s.push_str("(started automatically: Nexus continued an interrupted run)\n"),
        }
        if compact_line {
            s.push_str(&format!("{}\n\n", evidence_line(tr)));
            continue;
        }
        let incomplete = tr
            .digest
            .as_ref()
            .is_some_and(|d| d.stop_reason.as_deref() == Some("no-implementation"));
        match ans {
            // a plan/ramble that changed nothing must not be fed back as "your answer": it
            // would only teach the model to repeat it
            Some(a) if incomplete => s.push_str(&format!(
                "Your answer then was only a plan or narration and changed nothing (opening, shortened): {}\n",
                clip(a.text.trim(), 300)
            )),
            Some(a) => {
                let cap = if from_end <= lv.full_answers {
                    lv.full_cap
                } else {
                    lv.older_cap
                };
                if cap > 0 && from_end <= lv.full_answers {
                    s.push_str("Your answer then:\n");
                    s.push_str(&head_tail(a.text.trim(), cap));
                    s.push('\n');
                } else {
                    s.push_str(&format!(
                        "Your answer then (shortened): {}\n",
                        clip(a.text.trim(), lv.older_cap)
                    ));
                }
            }
            None => s.push_str("Your answer then: (none was recorded)\n"),
        }
        for n in msgs
            .iter()
            .filter(|m| m.kind == "note" && m.run_id.as_deref() == Some(tr.run_id.as_str()))
        {
            s.push_str(&format!("Note: {}\n", clip(n.text.trim(), 300)));
        }
        s.push_str(&evidence_line(tr));
        s.push_str("\n\n");
    }
    s.push_str("## The user's new request\n");
    s
}

/// The context block for a run, or `None` when the run is the first of its conversation.
pub fn build_context(
    th: &Thread,
    msgs: &[Message],
    current_run_id: &str,
    ws: &WorkspaceFacts,
    budget: usize,
) -> Option<String> {
    let pos = th.runs.iter().position(|r| r.run_id == current_run_id)?;
    let prior: Vec<&ThreadRun> = th.runs[..pos].iter().collect();
    if prior.is_empty() {
        return None;
    }
    for lv in &LEVELS {
        let out = render(th, msgs, &prior, ws, lv, 0);
        if out.len() <= budget {
            return Some(out);
        }
    }
    // still too long: give up the OLDEST runs one by one (their findings stay in the index)
    for omit in 1..prior.len() {
        let out = render(th, msgs, &prior, ws, &LEVELS[4], omit);
        if out.len() <= budget {
            return Some(out);
        }
    }
    let mut out = render(
        th,
        msgs,
        &prior,
        ws,
        &LEVELS[5],
        prior.len().saturating_sub(1),
    );
    if out.len() > budget {
        let mut end = budget.saturating_sub(120);
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
        out.push_str("\n[… cut to fit the budget …]\n\n## The user's new request\n");
    }
    Some(out)
}

// ------------------------------------------------------------- broker integration

/// Facts the executor already holds when a run ends (the run record's activity list is
/// bounded, the loop's is not).
pub struct RunFacts {
    pub final_text: String,
    pub activity: Vec<ToolActivity>,
}

fn note_for(run: &IntentRun) -> Option<String> {
    if run.state == "completed" {
        return None;
    }
    let why = run
        .error_message
        .clone()
        .or_else(|| {
            run.stop_reason
                .as_ref()
                .map(|r| format!("it stopped at a limit ({r})"))
        })
        .unwrap_or_else(|| run.state.clone());
    Some(match run.state.as_str() {
        "cancelled" => "This run was cancelled before it finished. Work done so far is kept in the working copy.".to_owned(),
        "uncertain" => format!("This run ended with an uncertain outcome: {why}"),
        "limit-reached" if run.stop_reason.as_deref() == Some("no-implementation") => {
            run.completion_note
                .clone()
                .unwrap_or_else(|| crate::completion::INCOMPLETE_NOTE.to_owned())
        }
        "limit-reached" => format!("This run stopped at a policy limit; findings and changes so far are kept. ({why})"),
        _ => format!("This run ended as {}: {why}", run.state),
    })
}

fn push_message(
    b: &Broker,
    th: &mut Thread,
    role: &str,
    kind: &str,
    run_id: Option<&str>,
    text: &str,
) -> Option<u64> {
    let (text, truncated) = bounded_message_text(text);
    let m = Message {
        seq: th.next_seq,
        role: role.to_owned(),
        kind: kind.to_owned(),
        run_id: run_id.map(str::to_owned),
        at_ms: now_ms(),
        text,
        truncated,
    };
    b.threads.append(&th.thread_id, &m).ok()?;
    th.next_seq += 1;
    th.message_count += 1;
    th.updated_at_ms = m.at_ms;
    if kind != "request" || th.last_preview.is_empty() {
        th.last_preview = clip(
            m.text.lines().find(|l| !l.trim().is_empty()).unwrap_or(""),
            160,
        );
    }
    Some(m.seq)
}

/// Fold a finished run into its conversation: the assistant's answer, the runtime's
/// evidence digest, findings. Idempotent (an ended run is never folded twice).
pub fn sync_run(b: &Broker, run_id: &str, facts: Option<RunFacts>) {
    let Some(rec) = b.store.load(run_id) else {
        return;
    };
    let Some(tid) = rec.run.thread_id.clone() else {
        return;
    };
    if !rec.run.terminal && facts.is_none() {
        return;
    }
    // while the executor is alive it folds its own run, with the complete activity list and
    // the final text it holds; a reader that comes by earlier must not do it with less
    if facts.is_none()
        && b.cancel_flags
            .lock()
            .map(|g| g.contains_key(run_id))
            .unwrap_or(false)
    {
        return;
    }
    let m = b.threads.mutex(&tid);
    let _g = m.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut th) = b.threads.load(&tid) else {
        return;
    };
    let Some(idx) = th.runs.iter().position(|r| r.run_id == run_id) else {
        return;
    };
    if th.runs[idx].ended {
        return;
    }
    // the run record is final only once its terminal state is written; the executor's own
    // facts are final earlier, so wait for the record when it is still moving
    let run = if rec.run.terminal {
        rec.run.clone()
    } else {
        let mut r = rec.run.clone();
        r.terminal = true;
        r
    };
    let (text, activity) = match facts {
        Some(f) => (f.final_text, f.activity),
        None => (b.view(&rec).1, run.tool_activity.clone()),
    };
    let digest = digest_of(&run, &activity);
    let text = text.trim().to_owned();
    let mut assistant_seq = None;
    if !text.is_empty() {
        assistant_seq = push_message(b, &mut th, "assistant", "answer", Some(run_id), &text);
    }
    if let Some(n) = note_for(&run) {
        push_message(b, &mut th, "system", "note", Some(run_id), &n);
    }
    let n = th.runs[idx].n;
    let read_only = th.runs[idx].read_only;
    let request_text = th.runs[idx]
        .user_seq
        .and_then(|s| b.threads.messages(&tid).into_iter().find(|m| m.seq == s))
        .map(|m| m.text)
        .unwrap_or_default();
    if !text.is_empty() {
        let found = extract_findings(&text, run_id);
        // A new review renumbers; a follow-up that talks ABOUT existing findings ("which are
        // still open?") lists them again and must never overwrite what they were (found live).
        let renumbers = read_only && mentioned_findings(&request_text).is_empty();
        merge_findings(&mut th.findings, found, renumbers);
    }
    if !read_only && digest.edits_applied > 0 {
        for id in mentioned_findings(&request_text) {
            if let Some(f) = th.findings.iter_mut().find(|f| f.id == id) {
                f.addressed_in = Some(n);
                f.addressed_verification = Some(digest.verification.clone());
            }
        }
    }
    let tr = &mut th.runs[idx];
    tr.state = run.state.clone();
    tr.ended = true;
    tr.ended_at_ms = Some(now_ms());
    tr.assistant_seq = assistant_seq;
    tr.digest = Some(digest);
    th.updated_at_ms = now_ms();
    let _ = b.threads.put(&th);
}

/// Fold every run of a conversation that finished (or vanished) without being folded - after a
/// crash, or for records that predate the conversation layer.
pub fn reconcile(b: &Broker, tid: &str) {
    let Some(th) = b.threads.load(tid) else {
        return;
    };
    let pending: Vec<String> = th
        .runs
        .iter()
        .filter(|r| !r.ended)
        .map(|r| r.run_id.clone())
        .collect();
    for id in pending {
        match b.store.load(&id) {
            Some(rec) if rec.run.terminal => sync_run(b, &id, None),
            Some(_) => {}
            None => {
                let m = b.threads.mutex(tid);
                let _g = m.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(mut th) = b.threads.load(tid) {
                    if let Some(tr) = th.runs.iter_mut().find(|r| r.run_id == id) {
                        tr.ended = true;
                        tr.state = "lost".into();
                    }
                    let _ = b.threads.put(&th);
                }
            }
        }
    }
    // a repaired sequence counter (crash between a log append and the metadata write)
    let m = b.threads.mutex(tid);
    let _g = m.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(mut th) = b.threads.load(tid) {
        let max = b.threads.messages(tid).iter().map(|m| m.seq).max();
        if let Some(max) = max {
            if th.next_seq <= max {
                th.next_seq = max + 1;
                let _ = b.threads.put(&th);
            }
        }
    }
}

fn new_thread_id() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    format!("thr_{}", hex::encode(buf))
}

fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("Conversation");
    clip(line.trim(), MAX_TITLE_CHARS)
}

fn blank_thread(client: &str, project: &str, title: Option<&str>) -> Thread {
    let now = now_ms();
    Thread {
        schema: THREAD_SCHEMA,
        thread_id: new_thread_id(),
        client_id: client.to_owned(),
        project_id: project.to_owned(),
        title: title
            .map(|t| clip(t.trim(), MAX_TITLE_CHARS))
            .unwrap_or_default(),
        created_at_ms: now,
        updated_at_ms: now,
        next_seq: 1,
        ..Default::default()
    }
}

/// What a thread-linked run needs from its conversation when it is created.
#[derive(Debug, Clone, Default)]
pub struct ThreadLink {
    pub thread_id: String,
    pub read_only: bool,
    /// The earlier run whose working copy this run starts from.
    pub seed_from: Option<String>,
    /// `fresh-by-choice` when the user asked to ignore the conversation's changes.
    pub relation_hint: Option<String>,
    /// R-NATIVE-2: resolved target for this run (already refused pre-run).
    pub resolved: Option<crate::resolution::ResolvedTarget>,
}

fn owned_thread(b: &Broker, client: &str, tid: &str) -> Result<Thread, (&'static str, String)> {
    match b.threads.load(tid) {
        Some(t) if t.client_id == client => Ok(t),
        _ => Err(("not-found", "no such conversation".to_owned())),
    }
}

fn to_selection(t: &crate::resolution::ResolvedTarget) -> nexus_contracts::intent::ModelSelection {
    nexus_contracts::intent::ModelSelection {
        provider_id: t.provider_id.clone(),
        remote_model_id: t.remote_model_id.clone(),
        logical_model_id: Some(t.logical_model_id.clone()),
        route_id: Some(t.route_id.clone()),
        mode_id: None,
    }
}

/// R-NATIVE-2: parse the optional thread-send selection: `model` is
/// `provider/remote` (optionally `provider/remote/logical`), `route` is an
/// exact catalog `routeId` and wins over the model pair.
fn parse_thread_selection(
    params: &serde_json::Value,
) -> Result<Option<nexus_contracts::intent::ModelSelection>, (&'static str, String)> {
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let route = params
        .get("route")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let mode = params
        .get("modeId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if !mode.is_empty()
        && (mode.len() > 64
            || !mode
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
    {
        return Err(("bad-intent", "the engineering mode id is not valid".into()));
    }
    if model.is_empty() && route.is_empty() {
        if !mode.is_empty() {
            return Err((
                "bad-intent",
                "an engineering mode is chosen together with an explicit model selection".into(),
            ));
        }
        return Ok(None);
    }
    let mode_id = if mode.is_empty() { None } else { Some(mode) };
    if !route.is_empty() {
        if route.len() > 200 || model.len() > 400 {
            return Err(("bad-intent", "selection is too long".into()));
        }
        if !model.is_empty() {
            let parts: Vec<&str> = model.split('/').collect();
            if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
                return Err(("bad-intent", "model must be provider/model".into()));
            }
            return Ok(Some(nexus_contracts::intent::ModelSelection {
                provider_id: parts[0].to_owned(),
                remote_model_id: parts[1].to_owned(),
                logical_model_id: parts.get(2).map(|s| (*s).to_owned()),
                route_id: Some(route),
                mode_id: mode_id.clone(),
            }));
        }
        // Bare routeId: match by route alone.
        return Ok(Some(nexus_contracts::intent::ModelSelection {
            provider_id: String::new(),
            remote_model_id: String::new(),
            logical_model_id: None,
            route_id: Some(route),
            mode_id: mode_id.clone(),
        }));
    }
    let parts: Vec<&str> = model.split('/').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
        return Err(("bad-intent", "model must be provider/model".into()));
    }
    Ok(Some(nexus_contracts::intent::ModelSelection {
        provider_id: parts[0].to_owned(),
        remote_model_id: parts[1].to_owned(),
        logical_model_id: parts.get(2).map(|s| (*s).to_owned()),
        route_id: None,
        mode_id: mode_id.clone(),
    }))
}

/// The newest run of the conversation that has a retained working copy.
fn head_run(b: &Broker, th: &Thread) -> Option<(usize, IntentRun)> {
    for (i, tr) in th.runs.iter().enumerate().rev() {
        if let Some(rec) = b.store.load(&tr.run_id) {
            if rec.run.task_instance_id.is_some() && rec.run.worktree_commit.is_some() {
                return Some((i, rec.run));
            }
        }
    }
    None
}

/// A run of the conversation that is still being worked on: its record is not final, or its
/// executor is still alive and about to fold the answer into the conversation (a message sent
/// in that instant would otherwise be stored BEFORE the answer it follows).
fn has_active_run(b: &Broker, th: &Thread) -> Option<String> {
    th.runs.iter().find_map(|tr| {
        if tr.ended {
            return None;
        }
        let executor_alive = b
            .cancel_flags
            .lock()
            .map(|g| g.contains_key(&tr.run_id))
            .unwrap_or(false);
        match b.store.load(&tr.run_id) {
            Some(rec) if !rec.run.terminal || executor_alive => Some(tr.run_id.clone()),
            _ => None,
        }
    })
}

/// `thread-send`: one user message into a conversation (created on first use), starting one
/// autonomous run that continues from the conversation's workspace.
pub fn send(b: &Arc<Broker>, client: &str, params: &Value) -> CmdResult {
    if !b.cfg.interactive {
        return Err((
            "not-available",
            "conversations belong to the interactive profile".into(),
        ));
    }
    let s = |k: &str| {
        params
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned()
    };
    let project = s("projectId");
    let content = s("content");
    let key = s("idempotencyKey");
    let mode_req = match s("mode").as_str() {
        "review" => "review",
        "edit" => "edit",
        _ => "auto",
    };
    let fresh = s("workspace") == "fresh";
    if project.is_empty() {
        return Err(("bad-request", "projectId is required".into()));
    }
    if content.trim().is_empty() {
        return Err(("bad-intent", "the message is empty".into()));
    }
    // A retried send (same key) returns the run it already created - never a second one.
    if let Some(prev) = b.store.idem_lookup(client, &key) {
        if let Some(rec) = b.store.load(&prev) {
            if let Some(tid) = rec.run.thread_id.clone() {
                let (run, _) = b.view(&rec);
                return Ok(json!({ "threadId": tid, "run": run, "replay": true }));
            }
        }
    }
    if !crate::inspect::code_sources_for(&b.cfg, client).contains(&project) {
        return Err((
            "workspace-not-allowed",
            "that project is not available to this client".into(),
        ));
    }
    let new_thread = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .is_none_or(str::is_empty);
    let mut th = if new_thread {
        blank_thread(client, &project, None)
    } else {
        owned_thread(
            b,
            client,
            params
                .get("threadId")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        )?
    };
    if th.project_id != project {
        return Err((
            "project-mismatch",
            "this conversation belongs to another project; start a new conversation for that project".into(),
        ));
    }
    if th.archived {
        return Err(("thread-closed", "this conversation is archived".into()));
    }
    let tid = th.thread_id.clone();
    if !new_thread {
        // fold anything that finished since the user last looked (e.g. before a restart)
        reconcile(b, &tid);
    }
    let mtx = b.threads.mutex(&tid);
    let _g = mtx.lock().unwrap_or_else(|p| p.into_inner());
    if !new_thread {
        // re-read under the lock
        th = owned_thread(b, client, &tid)?;
    }
    if has_active_run(b, &th).is_some() {
        return Err((
            "thread-busy",
            "a run of this conversation is still in progress; stop it or wait for it to finish"
                .into(),
        ));
    }
    let decision = classify_mode(&content, mode_req);
    // R-NATIVE-2: optional selection; else the conversation's target.
    // Refused before any run exists; a switch is recorded as a note.
    let explicit = parse_thread_selection(params)?;
    let catalog = b.registry_targets().map_err(|(_, m)| ("internal", m))?;
    let conv_target: Option<crate::resolution::ResolvedTarget> =
        th.target
            .clone()
            .map(|t| crate::resolution::ResolvedTarget {
                provider_id: t.provider_id,
                logical_model_id: t.logical_model_id,
                remote_model_id: t.remote_model_id,
                route_id: t.route_id,
                connection_id: t.connection_id,
                context_limit_tokens: t.context_limit_tokens.unwrap_or(0),
                output_limit_tokens: t.output_limit_tokens.unwrap_or(0),
                billing_tier: String::new(),
            });
    let resolved = {
        // no selection and no conversation target: the saved default, not the first catalog entry
        let default_sel = if explicit.is_none() && conv_target.is_none() {
            b.default_selection()
        } else {
            None
        };
        crate::resolution::resolve_target(
            &catalog,
            explicit.as_ref().or(default_sel.as_ref()),
            conv_target.as_ref(),
        )
    }
    .map_err(|(c, m)| {
        let code: &'static str = match c.as_str() {
            "ambiguous-target" => "ambiguous-target",
            "model-not-allowed" => "model-not-allowed",
            _ => "model-not-available",
        };
        (code, m)
    })?;
    // Phase 2: the engine of this run. An explicit selection states it (absent = the default mode);
    // otherwise the conversation keeps the engine it started with.
    let chosen_mode: Option<String> = match &explicit {
        Some(e) => e.mode_id.clone(),
        None => th.target.as_ref().and_then(|t| t.mode_id.clone()),
    };
    let mode_switched =
        th.target.is_some() && th.target.as_ref().and_then(|t| t.mode_id.clone()) != chosen_mode;
    let switched = match (&explicit, &conv_target) {
        (Some(_), Some(c)) => !resolved.matches_selection(&to_selection(c)),
        (Some(_), None) => th.target.is_some(),
        (None, _) => false,
    };
    // where the new run's working copy comes from
    let head = head_run(b, &th);
    let (seed_from, relation_hint) = match (&head, fresh) {
        (_, true) => (None, Some("fresh-by-choice".to_owned())),
        (Some((_, h)), false) => (Some(h.run_id.clone()), None),
        (None, false) => (None, None),
    };
    let intent = NexusIntentV1 {
        schema_version: 1,
        request_id: format!("thr-{}", &tid[4..16]),
        idempotency_key: key.clone(),
        intent_type: nexus_contracts::intent::INTENT_REPO_CODE.to_owned(),
        content: content.clone(),
        model: Some(nexus_contracts::intent::ModelSelection {
            provider_id: resolved.provider_id.clone(),
            remote_model_id: resolved.remote_model_id.clone(),
            logical_model_id: Some(resolved.logical_model_id.clone()),
            route_id: Some(resolved.route_id.clone()),
            mode_id: chosen_mode.clone(),
        }),
        workspace_id: Some(project.clone()),
        limits: b
            .cfg
            .code_caps
            .with_user_limits(&b.cfg.state_dir)
            .effective()
            .to_intent_limits(nexus_client::intent_client::INTERACTIVE_CODE_LIMITS),
        response_mode: nexus_contracts::intent::ResponseMode::Stream,
        client_label: Some("nexus-conversation".to_owned()),
    };
    let link = ThreadLink {
        thread_id: tid.clone(),
        read_only: decision.read_only,
        seed_from,
        relation_hint,
        resolved: Some(resolved.clone()),
    };
    let out = b.submit_linked(
        client,
        &json!({ "intent": serde_json::to_value(&intent).unwrap_or_default() }),
        None,
        Some(link),
    )?;
    let run_id = out
        .pointer("/run/runId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if out.get("replay") == Some(&Value::Bool(true)) {
        return Ok(json!({ "threadId": tid, "run": out["run"], "replay": true }));
    }
    if th.title.is_empty() {
        th.title = title_from(&content);
    }
    th.target = Some(ThreadTarget {
        provider_id: resolved.provider_id.clone(),
        logical_model_id: resolved.logical_model_id.clone(),
        remote_model_id: resolved.remote_model_id.clone(),
        route_id: resolved.route_id.clone(),
        connection_id: resolved.connection_id.clone(),
        context_limit_tokens: Some(resolved.context_limit_tokens),
        output_limit_tokens: Some(resolved.output_limit_tokens),
        mode_id: chosen_mode.clone(),
    });
    let user_seq = push_message(b, &mut th, "user", "request", Some(&run_id), &content);
    if mode_switched {
        push_message(
            b,
            &mut th,
            "system",
            "note",
            Some(&run_id),
            &format!(
                "engine changed to {}",
                chosen_mode.as_deref().unwrap_or("engineering-v2")
            ),
        );
    }
    if switched {
        push_message(
            b,
            &mut th,
            "system",
            "note",
            Some(&run_id),
            &format!(
                "model changed to {}/{}",
                resolved.provider_id, resolved.remote_model_id
            ),
        );
    }
    th.runs.push(ThreadRun {
        run_id: run_id.clone(),
        n: th.runs.len() as u32 + 1,
        user_seq,
        mode: if decision.read_only { "review" } else { "edit" }.into(),
        read_only: decision.read_only,
        mode_reason: decision.reason.to_owned(),
        state: "received".into(),
        started_at_ms: now_ms(),
        ..Default::default()
    });
    b.threads
        .put(&th)
        .map_err(|e| ("internal", format!("cannot persist the conversation: {e}")))?;
    Ok(json!({
        "threadId": tid, "run": out["run"], "replay": false,
        "mode": { "readOnly": decision.read_only, "reason": decision.reason },
    }))
}

/// A run that continues an interrupted one joins the same conversation. `false` when a newer
/// request already superseded the interrupted run (it must not be continued then).
pub fn may_continue(b: &Broker, thread_id: &str, old_run: &str) -> bool {
    let Some(th) = b.threads.load(thread_id) else {
        return true;
    };
    th.runs.last().is_none_or(|r| r.run_id == old_run) && has_active_run(b, &th).is_none()
}

pub fn attach_continuation(b: &Broker, thread_id: &str, new_run: &str, old_run: &str) {
    let m = b.threads.mutex(thread_id);
    let _g = m.lock().unwrap_or_else(|p| p.into_inner());
    let Some(mut th) = b.threads.load(thread_id) else {
        return;
    };
    if th.runs.iter().any(|r| r.run_id == new_run) {
        return;
    }
    let (ro, mode, reason) = th
        .runs
        .iter()
        .find(|r| r.run_id == old_run)
        .map(|r| (r.read_only, r.mode.clone(), r.mode_reason.clone()))
        .unwrap_or((false, "edit".into(), String::new()));
    push_message(
        b,
        &mut th,
        "system",
        "note",
        Some(new_run),
        "Nexus continued the interrupted run in a new run that starts from its work.",
    );
    th.runs.push(ThreadRun {
        run_id: new_run.to_owned(),
        n: th.runs.len() as u32 + 1,
        mode,
        read_only: ro,
        mode_reason: reason,
        continuation_of: Some(old_run.to_owned()),
        state: "received".into(),
        started_at_ms: now_ms(),
        ..Default::default()
    });
    let _ = b.threads.put(&th);
}

/// The context may use at most what the first message has left after the harness text and the
/// request (`reserve` bytes): the transport refuses a single message above its bound.
pub fn fit_budget(configured: usize, reserve: usize) -> usize {
    let room = nexus_model::request::MAX_MESSAGE_CHARS.saturating_sub(reserve);
    configured.min(room).max(1024)
}

/// 1-based position of a run in its conversation.
pub fn run_number(b: &Broker, thread_id: &str, run_id: &str) -> Option<u32> {
    b.threads
        .load(thread_id)?
        .runs
        .iter()
        .find(|r| r.run_id == run_id)
        .map(|r| r.n)
}

/// The context block and workspace facts for a run about to start (called by the executor).
/// For a bare "continue": did the request it continues ask for an implementation? The most recent
/// user request of the conversation that is not itself a continuation decides.
pub fn continued_request_expects_change(b: &Broker, run_id: &str) -> bool {
    let Some(tid) = b.store.load(run_id).and_then(|r| r.run.thread_id) else {
        return false;
    };
    b.threads
        .messages(&tid)
        .iter()
        .rev()
        .filter(|m| m.role == "user" && m.kind == "request")
        .find(|m| !crate::completion::is_continuation(&m.text))
        .is_some_and(|m| crate::completion::expects_change(&m.text))
}

pub fn context_for_run(b: &Broker, run_id: &str, reserve: usize) -> Option<String> {
    let rec = b.store.load(run_id)?;
    let tid = rec.run.thread_id.clone()?;
    // a send in progress holds the conversation's lock until its message is stored
    let m = b.threads.mutex(&tid);
    let _g = m.lock().unwrap_or_else(|p| p.into_inner());
    let mut th = b.threads.load(&tid)?;
    let msgs = b.threads.messages(&tid);
    let from_n = rec
        .run
        .seed_from
        .as_ref()
        .and_then(|id| th.runs.iter().find(|r| &r.run_id == id))
        .map(|r| r.n);
    let changed = rec
        .run
        .seed_from
        .as_ref()
        .and_then(|id| b.store.load(id))
        .map(|r| {
            r.run
                .changed_files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ws = WorkspaceFacts {
        relation: rec
            .run
            .workspace_relation
            .clone()
            .unwrap_or_else(|| "fresh".into()),
        from_run_n: from_n,
        note: rec.run.workspace_note.clone(),
        changed,
    };
    // the conversation's share of the context budget: a quarter, never more than the fixed cap
    let configured = b
        .cfg
        .context_budget_bytes
        .map(|c| (c / 4).clamp(2048, CONTEXT_BUDGET_BYTES))
        .unwrap_or(CONTEXT_BUDGET_BYTES);
    let budget = fit_budget(configured, reserve);
    let text = build_context(&th, &msgs, run_id, &ws, budget)?;
    let prior_runs = th.runs.iter().take_while(|r| r.run_id != run_id).count() as u32;
    let findings = th.findings.len() as u32;
    if let Some(tr) = th.runs.iter_mut().find(|r| r.run_id == run_id) {
        use sha2::{Digest, Sha256};
        tr.context = Some(ContextInfo {
            bytes: text.len() as u64,
            sha256: hex::encode(Sha256::digest(text.as_bytes())),
            prior_runs,
            findings,
        });
        let _ = b.threads.put(&th);
    }
    Some(text)
}

/// R-NATIVE-3: conversation bound target as identities only (no connection
/// reference, no credential material, no path). Absent when unbound.
fn bound_target_json(t: Option<&ThreadTarget>) -> Option<Value> {
    t.map(|t| {
        let mut v = json!({
            "providerId": t.provider_id, "remoteModelId": t.remote_model_id,
            "logicalModelId": t.logical_model_id, "routeId": t.route_id,
        });
        // absent for the default mode: the wire shape of every earlier conversation is unchanged
        if let Some(m) = &t.mode_id {
            v["modeId"] = json!(m);
        }
        v
    })
}

fn thread_summary(b: &Broker, th: &Thread) -> Value {
    let active = has_active_run(b, th);
    let last_state = th
        .runs
        .last()
        .map(|r| {
            if r.digest.as_ref().and_then(|d| d.stop_reason.as_deref()) == Some("no-implementation")
            {
                "incomplete".to_owned()
            } else {
                r.state.clone()
            }
        })
        .unwrap_or_default();
    let mut v = json!({
        "threadId": th.thread_id, "projectId": th.project_id, "title": th.title,
        "createdAtMs": th.created_at_ms, "updatedAtMs": th.updated_at_ms, "archived": th.archived,
        "legacy": th.legacy, "runCount": th.runs.len(), "messageCount": th.message_count,
        "lastPreview": th.last_preview, "lastState": last_state,
        "active": active.is_some(), "activeRunId": active, "findingCount": th.findings.len(),
    });
    // R-NATIVE-3: conversation bound target as identities only (no connection
    // reference, no credential material, no path). Absent when unbound.
    if let Some(t) = bound_target_json(th.target.as_ref()) {
        v["target"] = t;
    }
    v
}

pub fn list(b: &Broker, client: &str, params: &Value) -> CmdResult {
    let project = params
        .get("projectId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let archived = params
        .get("includeArchived")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = Vec::new();
    for th in b.threads.all() {
        if th.client_id != client || (th.archived && !archived) {
            continue;
        }
        if project.is_some_and(|p| p != th.project_id) {
            continue;
        }
        if th.runs.iter().any(|r| !r.ended) {
            reconcile(b, &th.thread_id);
        }
        let th = b.threads.load(&th.thread_id).unwrap_or(th);
        out.push(thread_summary(b, &th));
    }
    Ok(json!({ "threads": out }))
}

pub fn get(b: &Broker, client: &str, params: &Value) -> CmdResult {
    let tid = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    owned_thread(b, client, tid)?;
    reconcile(b, tid);
    let th = owned_thread(b, client, tid)?;
    let after = params.get("afterSeq").and_then(|v| v.as_u64()).unwrap_or(0);
    let messages: Vec<Message> = b
        .threads
        .messages(tid)
        .into_iter()
        .filter(|m| m.seq > after)
        .collect();
    let n_runs = th.runs.len();
    let runs: Vec<Value> = th
        .runs
        .iter()
        .enumerate()
        .map(|(i, tr)| {
            let run = b.store.load(&tr.run_id).map(|rec| {
                let mut r = b.view_light(&rec);
                // older runs keep their digest (in `tr`); the full activity list is for the latest few
                if n_runs - i > 6 {
                    r.tool_activity.clear();
                }
                r
            });
            let mut v = serde_json::to_value(tr).unwrap_or_default();
            v["run"] = serde_json::to_value(run).unwrap_or(Value::Null);
            v
        })
        .collect();
    let head = head_run(b, &th).map(|(i, r)| {
        json!({ "runId": r.run_id, "n": th.runs[i].n, "changedFiles": r.changed_files.len() })
    });
    Ok(json!({
        "thread": thread_summary(b, &th), "messages": messages, "runs": runs,
        "findings": th.findings, "head": head,
    }))
}

pub fn create(b: &Broker, client: &str, params: &Value) -> CmdResult {
    if !b.cfg.interactive {
        return Err((
            "not-available",
            "conversations belong to the interactive profile".into(),
        ));
    }
    let project = params
        .get("projectId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !crate::inspect::code_sources_for(&b.cfg, client)
        .iter()
        .any(|p| p == project)
    {
        return Err((
            "workspace-not-allowed",
            "that project is not available to this client".into(),
        ));
    }
    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty());
    let th = blank_thread(client, project, title);
    b.threads
        .put(&th)
        .map_err(|e| ("internal", format!("cannot persist the conversation: {e}")))?;
    Ok(json!({ "thread": thread_summary(b, &th) }))
}

pub fn update(b: &Broker, client: &str, params: &Value) -> CmdResult {
    let tid = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    owned_thread(b, client, tid)?;
    let m = b.threads.mutex(tid);
    let _g = m.lock().unwrap_or_else(|p| p.into_inner());
    let mut th = owned_thread(b, client, tid)?;
    if let Some(t) = params
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        th.title = clip(t.trim(), MAX_TITLE_CHARS);
    }
    if let Some(a) = params.get("archived").and_then(|v| v.as_bool()) {
        if a && has_active_run(b, &th).is_some() {
            return Err((
                "thread-busy",
                "stop the running task before archiving".into(),
            ));
        }
        th.archived = a;
    }
    b.threads
        .put(&th)
        .map_err(|e| ("internal", format!("cannot persist the conversation: {e}")))?;
    Ok(json!({ "thread": thread_summary(b, &th) }))
}

/// Single-run records that predate conversations become one-run conversations (a chain of
/// continuations becomes one conversation). Deterministic ids make this idempotent; the
/// original run records are only annotated with their conversation id.
pub fn migrate_legacy(b: &Broker) {
    if !b.cfg.interactive {
        return;
    }
    use sha2::{Digest, Sha256};
    let all = b.store.all();
    let by_id: HashMap<&str, &crate::store::RunRecord> =
        all.iter().map(|r| (r.run.run_id.as_str(), r)).collect();
    let root_of = |start: &crate::store::RunRecord| -> String {
        let mut cur = start.run.run_id.clone();
        for _ in 0..64 {
            match by_id
                .get(cur.as_str())
                .and_then(|r| r.run.continuation_of.clone())
            {
                Some(p) if by_id.contains_key(p.as_str()) => cur = p,
                _ => break,
            }
        }
        cur
    };
    let mut groups: HashMap<String, Vec<&crate::store::RunRecord>> = HashMap::new();
    for r in &all {
        if r.run.thread_id.is_some()
            || r.run.intent_type != nexus_contracts::intent::INTENT_REPO_CODE
            || !r.run.terminal
            || r.run.workspace_id.is_none()
        {
            continue;
        }
        groups.entry(root_of(r)).or_default().push(r);
    }
    for (root, mut runs) in groups {
        runs.sort_by_key(|r| r.run.created_at_ms);
        let digest = hex::encode(Sha256::digest(format!("legacy:{root}").as_bytes()));
        let tid = format!("thr_{}", &digest[..32]);
        let m = b.threads.mutex(&tid);
        let _g = m.lock().unwrap_or_else(|p| p.into_inner());
        let mut th = b.threads.load(&tid).unwrap_or_else(|| {
            let first = &runs[0].run;
            let mut t = blank_thread(
                &first.client_id,
                first.workspace_id.as_deref().unwrap_or(""),
                None,
            );
            t.thread_id = tid.clone();
            t.created_at_ms = first.created_at_ms;
            t.legacy = true;
            t
        });
        for rec in &runs {
            if th.runs.iter().any(|r| r.run_id == rec.run.run_id) {
                continue;
            }
            let is_cont = rec.run.continuation_of.is_some();
            let mut user_seq = None;
            if !is_cont {
                let text = rec
                    .prompt
                    .clone()
                    .or_else(|| rec.run.prompt_preview.clone())
                    .unwrap_or_else(|| "(the task text of this earlier run was not kept)".into());
                if th.title.is_empty() {
                    th.title = title_from(&text);
                }
                user_seq =
                    push_message(b, &mut th, "user", "request", Some(&rec.run.run_id), &text);
            }
            th.runs.push(ThreadRun {
                run_id: rec.run.run_id.clone(),
                n: th.runs.len() as u32 + 1,
                user_seq,
                mode: "edit".into(),
                mode_reason: "recorded before conversations existed".into(),
                continuation_of: rec.run.continuation_of.clone(),
                state: rec.run.state.clone(),
                started_at_ms: rec.run.created_at_ms,
                ..Default::default()
            });
            th.updated_at_ms = th.updated_at_ms.max(rec.run.updated_at_ms);
        }
        if b.threads.put(&th).is_ok() {
            for rec in &runs {
                let t = tid.clone();
                b.annotate(&rec.run.run_id, move |r| r.thread_id = Some(t));
            }
        }
    }
}

/// Runs whose record points at a conversation that does not list them (a crash between the run
/// record and the conversation write) are added back, with their task text from the record.
pub fn repair_orphans(b: &Broker) {
    for rec in b.store.all() {
        let Some(tid) = rec.run.thread_id.clone() else {
            continue;
        };
        let m = b.threads.mutex(&tid);
        let _g = m.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut th) = b.threads.load(&tid) else {
            continue;
        };
        if th.runs.iter().any(|r| r.run_id == rec.run.run_id) {
            continue;
        }
        let is_cont = rec.run.continuation_of.is_some();
        let mut user_seq = None;
        if !is_cont {
            let text = rec
                .prompt
                .clone()
                .unwrap_or_else(|| "(task text not kept)".into());
            user_seq = push_message(b, &mut th, "user", "request", Some(&rec.run.run_id), &text);
        }
        th.runs.push(ThreadRun {
            run_id: rec.run.run_id.clone(),
            n: th.runs.len() as u32 + 1,
            user_seq,
            mode: if rec.run.read_only { "review" } else { "edit" }.into(),
            read_only: rec.run.read_only,
            mode_reason: "restored after an interruption".into(),
            continuation_of: rec.run.continuation_of.clone(),
            state: rec.run.state.clone(),
            started_at_ms: rec.run.created_at_ms,
            ..Default::default()
        });
        let _ = b.threads.put(&th);
    }
}

/// Startup: repair, migrate, then fold every finished-but-unfolded run.
pub fn startup(b: &Broker) {
    repair_orphans(b);
    migrate_legacy(b);
    for id in b.threads.ids() {
        reconcile(b, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_read_only_instructions_are_recognized_without_catching_ordinary_constraints() {
        for t in [
            "Now explain exactly why F2 is a problem. Don't change any files.",
            "Review this repository. This is a read-only task.",
            "Do not edit anything, just tell me.",
            "Inspect F3 but don\u{2019}t modify the code",
            "Analyze it without changing anything",
            "No changes, please.",
            "read only review of the auth module",
            "Do not make any changes to the files",
            "You must not touch any file",
            "just review the diff",
            "Do not modify files, only report.",
        ] {
            assert!(explicit_read_only(t), "{t}");
        }
        for t in [
            "Fix finding F1 and add regression tests.",
            "Fix F1 but don't change the public API.",
            "Add a test, don't touch the database schema",
            "Refactor the parser; do not change behaviour",
            "Make the field read-only in the form",
            "Don't edit the tests, fix the implementation",
            "Fix it. No changes to the API please",
            "Don't change any file except src/lib.rs",
            "Implement F2 without breaking the CLI",
            "Do not modify the original repository, commit, push or deploy.",
            "Implement checkpoint R-NATIVE-1.\n\nWork autonomously in the isolated workspace.\n\nDo not modify the original repository, commit, push or deploy.\n\nDeliver a reviewable patch.",
            "Don't change the production database or the live config",
            // path-specific restrictions are not global prohibitions: the
            // leading dot of `.git` must not truncate the clause into a
            // bare "Do not modify" (found live, see the regression below)
            "Do not modify .git or access files outside the project.",
            "Do not modify .git",
            "Don't touch .env files",
            "Do not modify .git/config or anything under .git/hooks",
            "Write the code, but do not modify .git in any way.",
        ] {
            assert!(!explicit_read_only(t), "{t}");
        }
    }

    /// The exact failing shape from live use: a request to BUILD a Python
    /// application, with a protected-path restriction, sent with changes
    /// allowed. It must classify writable under both `edit` ("Make changes")
    /// and `auto`, while genuine read-only instructions stay read-only.
    #[test]
    fn a_python_application_request_with_a_git_restriction_is_writable() {
        const PROMPT: &str = "Build a Python application that tracks expenses from the command line, with a SQLite database, unit tests and a README.\n\nDo not modify .git or access files outside the project.";
        assert!(
            !explicit_read_only(PROMPT),
            "path restriction misread as global"
        );
        assert!(
            !classify_mode(PROMPT, "edit").read_only,
            "Make changes must be writable"
        );
        assert!(
            !classify_mode(PROMPT, "auto").read_only,
            "Auto must be writable"
        );
        // explicit global prohibitions still win over the mode selection
        assert!(explicit_read_only("Do not modify any files"));
        assert!(classify_mode("Do not modify any files", "edit").read_only);
        assert!(explicit_read_only("Review only"));
        assert!(classify_mode("Review only", "edit").read_only);
        assert!(classify_mode("Review only. Do not change anything.", "auto").read_only);
    }

    #[test]
    fn the_mode_only_ever_loses_permissions_automatically() {
        // the user's selection decides, the text can only restrict further
        assert!(classify_mode("Fix F1", "review").read_only);
        assert!(!classify_mode("Fix F1", "edit").read_only);
        assert!(classify_mode("Fix F1. Don't change any files", "edit").read_only);
        // automatic: a plain question or review is read-only, anything with a change verb is not
        assert!(classify_mode("Review this repository.", "auto").read_only);
        assert!(classify_mode("Why does the parser reject empty input?", "auto").read_only);
        assert!(!classify_mode("Fix finding F1 and add regression tests.", "auto").read_only);
        assert!(!classify_mode("Review the code and fix what you find", "auto").read_only);
        assert!(!classify_mode("Implement a retry loop", "auto").read_only);
        assert!(!classify_mode("Ok, go ahead", "auto").read_only);
    }

    const REPORT: &str = "# Review\n\nSummary text.\n\n## Findings\n\n### F1 — Unchecked index in parser\nThe parser indexes `buf[i+1]` without a bounds check (src/parse.rs:41-48). Panics on truncated input.\n\n### F2: Retry loop never backs off\nsrc/net.rs:90 retries in a tight loop.\n\n**F3.** Docs are stale\nREADME mentions a removed flag.\n\n| ID | Sev | Title |\n| F1 | High | Unchecked index in parser |\n\n1. **F4** Missing tests for `merge`\n";

    #[test]
    fn findings_are_extracted_with_their_detail_and_referenced_by_number() {
        let f = extract_findings(REPORT, "run_1");
        let ids: Vec<&str> = f.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["F1", "F2", "F3", "F4"]);
        assert_eq!(f[0].title, "Unchecked index in parser");
        assert!(f[0].detail.contains("src/parse.rs:41-48"), "{:?}", f[0]);
        assert_eq!(f[1].title, "Retry loop never backs off");
        assert!(f[1].detail.contains("src/net.rs:90"));
        assert_eq!(f[2].title, "Docs are stale");
        assert_eq!(f[3].title, "Missing tests for `merge`");
        let t = extract_findings("### F9 — `mortgage` bypasses the turn check\nx", "r");
        assert_eq!(t[0].title, "`mortgage` bypasses the turn check");
        assert_eq!(
            mentioned_findings("Fix finding F1 and f3, not F10x or xF2"),
            ["F1", "F3"]
        );
    }

    #[test]
    fn a_new_review_replaces_the_numbering_but_a_follow_up_never_rewrites_a_known_finding() {
        let mut have = extract_findings(REPORT, "run_1");
        have[0].addressed_in = Some(2);
        // an explanation that mentions F2 again does not rewrite it
        let again = vec![Finding {
            id: "F2".into(),
            title: "Something else".into(),
            run_id: "run_3".into(),
            ..Default::default()
        }];
        merge_findings(&mut have, again, true);
        assert_eq!(have[1].title, "Retry loop never backs off");
        // a new review with several findings replaces the list; an unchanged title keeps its status
        let review = vec![
            Finding {
                id: "F1".into(),
                title: "Unchecked index in parser".into(),
                run_id: "run_4".into(),
                ..Default::default()
            },
            Finding {
                id: "F2".into(),
                title: "New problem".into(),
                run_id: "run_4".into(),
                ..Default::default()
            },
        ];
        merge_findings(&mut have, review, true);
        assert_eq!(have[0].addressed_in, Some(2));
        assert_eq!(have[1].title, "New problem");
    }

    fn sample_thread(n_runs: usize, answer_len: usize) -> (Thread, Vec<Message>) {
        let mut th = blank_thread("uid:1", "proj", None);
        let mut msgs = Vec::new();
        for i in 1..=n_runs {
            let u = Message {
                seq: (i * 2 - 1) as u64,
                role: "user".into(),
                kind: "request".into(),
                run_id: Some(format!("run_{i}")),
                text: format!("request number {i}: please look at module {i}"),
                ..Default::default()
            };
            let body = if i == 1 {
                format!(
                    "{REPORT}\n{}",
                    "Detailed analysis line. ".repeat(answer_len / 24)
                )
            } else {
                format!("answer {i} {}", "x".repeat(answer_len))
            };
            let a = Message {
                seq: (i * 2) as u64,
                role: "assistant".into(),
                kind: "answer".into(),
                run_id: Some(format!("run_{i}")),
                text: body,
                ..Default::default()
            };
            th.runs.push(ThreadRun {
                run_id: format!("run_{i}"),
                n: i as u32,
                user_seq: Some(u.seq),
                assistant_seq: Some(a.seq),
                mode: "edit".into(),
                state: "completed".into(),
                ended: true,
                digest: Some(RunDigest {
                    verification: "verified-passed".into(),
                    files_touched: vec![format!("src/m{i}.rs")],
                    ..Default::default()
                }),
                ..Default::default()
            });
            msgs.push(u);
            msgs.push(a);
        }
        th.runs.push(ThreadRun {
            run_id: "run_new".into(),
            n: n_runs as u32 + 1,
            ..Default::default()
        });
        th.findings = extract_findings(REPORT, "run_1");
        (th, msgs)
    }

    #[test]
    fn the_context_carries_the_requests_answers_findings_and_runtime_evidence_but_not_the_new_request(
    ) {
        let (th, msgs) = sample_thread(2, 400);
        let ws = WorkspaceFacts {
            relation: "continued".into(),
            from_run_n: Some(2),
            changed: vec!["src/m2.rs".into()],
            ..Default::default()
        };
        let c = build_context(&th, &msgs, "run_new", &ws, CONTEXT_BUDGET_BYTES).expect("context");
        assert!(c.contains("request number 1"), "{c}");
        assert!(
            c.contains("F1 — Unchecked index in parser"),
            "findings index"
        );
        assert!(c.contains("src/parse.rs:41-48"), "the report body is kept");
        assert!(c.contains("runtime-verified outcome: verified-passed"));
        assert!(c.contains("starts from the working copy of run 2"));
        assert!(c.ends_with("## The user's new request\n"));
        // the first run of a conversation has no context
        assert!(build_context(&th, &msgs, "run_1", &ws, CONTEXT_BUDGET_BYTES).is_none());
    }

    #[test]
    fn compaction_keeps_requirements_findings_and_verified_results_inside_the_budget() {
        let (th, msgs) = sample_thread(30, 20_000);
        let ws = WorkspaceFacts::default();
        for budget in [48 * 1024, 24 * 1024, 12 * 1024, 6 * 1024] {
            let c = build_context(&th, &msgs, "run_new", &ws, budget).expect("context");
            assert!(c.len() <= budget, "{} > {budget}", c.len());
            assert!(
                c.contains("Findings index"),
                "findings always survive ({budget})"
            );
            assert!(c.contains("F2 — Retry loop never backs off"), "{budget}");
            assert!(
                c.contains("request number 30") || budget < 12 * 1024,
                "the newest request survives ({budget})"
            );
        }
        // the latest answer is kept whole when it fits
        let (th, msgs) = sample_thread(3, 3000);
        let c = build_context(
            &th,
            &msgs,
            "run_new",
            &WorkspaceFacts::default(),
            CONTEXT_BUDGET_BYTES,
        )
        .unwrap();
        assert!(c.contains(&"x".repeat(3000)));
    }

    #[test]
    fn the_context_always_leaves_the_first_message_inside_the_transport_bound() {
        let max = nexus_model::request::MAX_MESSAGE_CHARS;
        // typical: ~5 KB of harness text and a short request leave ~26 KB, not the configured 48 KB
        let b = fit_budget(CONTEXT_BUDGET_BYTES, 5_000 + 600);
        assert!(b + 5_600 <= max && b > 20_000, "{b}");
        // a long request leaves less; the context shrinks, it never pushes the message over
        let b = fit_budget(CONTEXT_BUDGET_BYTES, 5_000 + 16_000);
        assert!(b + 21_000 <= max, "{b}");
        // never zero, never above the configured size
        assert_eq!(fit_budget(2_048, max), 1_024);
        assert_eq!(fit_budget(4_000, 100), 4_000);
    }

    #[test]
    fn the_digest_comes_from_receipts_and_keeps_commands_with_their_verdicts() {
        let mut run = IntentRun {
            intent_type: "repo-code".into(),
            ..Default::default()
        };
        let act = |tool: &str, sum: &str, status: &str, ver: Option<&str>| ToolActivity {
            tool: tool.into(),
            args_summary: sum.into(),
            status: status.into(),
            verification: ver.map(str::to_owned),
            ..Default::default()
        };
        let a = vec![
            act("fs_read", "src/a.rs", "executed", None),
            act("fs_edit", "edit src/a.rs", "executed", None),
            act("fs_write", "create tests/a_test.rs", "executed", None),
            act("fs_edit", "edit src/b.rs", "refused", None),
            act("proc_run", "cargo test", "executed", Some("pass")),
        ];
        run.tool_activity = a.clone();
        let d = digest_of(&run, &a);
        assert_eq!(d.files_touched, ["src/a.rs", "tests/a_test.rs"]);
        assert_eq!(d.edits_applied, 2);
        assert_eq!(d.receipts.len(), 4);
        assert_eq!(d.receipts.last().unwrap().verdict.as_deref(), Some("pass"));
    }

    /// The wire shape of the bound target is the golden file the Desktop types against
    /// (`apps/nexus-desktop/src/test/contract/thread-target.json`).
    #[test]
    fn the_bound_target_wire_shape_is_the_one_the_desktop_contract_expects() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../apps/nexus-desktop/src/test/contract/thread-target.json"
        ))
        .unwrap();
        let t = ThreadTarget {
            provider_id: "acme".into(),
            logical_model_id: "acme/large".into(),
            remote_model_id: "acme-large-1".into(),
            route_id: "acme/large".into(),
            connection_id: Some("conn-acme".into()),
            context_limit_tokens: Some(200_000),
            output_limit_tokens: Some(8_192),
            mode_id: None,
        };
        assert_eq!(bound_target_json(Some(&t)).unwrap(), golden);
    }

    #[test]
    fn the_bound_target_is_identities_only_and_absent_when_unbound() {
        // Unbound conversation: no target key at all.
        assert!(bound_target_json(None).is_none());
        // Bound conversation: exactly the four identity keys, even when the
        // stored target also carries connection and limit metadata.
        let t = ThreadTarget {
            provider_id: "acme".into(),
            logical_model_id: "acme/large".into(),
            remote_model_id: "acme-large-1".into(),
            route_id: "acme/large".into(),
            connection_id: Some("conn-acme".into()),
            context_limit_tokens: Some(200_000),
            output_limit_tokens: Some(8_192),
            mode_id: None,
        };
        let v = bound_target_json(Some(&t)).expect("bound target renders");
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["logicalModelId", "providerId", "remoteModelId", "routeId"]
        );
        assert_eq!(v["providerId"], "acme");
        assert_eq!(v["remoteModelId"], "acme-large-1");
        assert_eq!(v["logicalModelId"], "acme/large");
        assert_eq!(v["routeId"], "acme/large");
        let flat = v.to_string();
        assert!(!flat.contains("conn-acme"), "{flat}");
        assert!(!flat.contains("connection"), "{flat}");
        assert!(!flat.contains("credential"), "{flat}");
    }

    fn target_with_mode(mode: Option<&str>) -> ThreadTarget {
        ThreadTarget {
            provider_id: "acme".into(),
            logical_model_id: "acme/large".into(),
            remote_model_id: "acme-large-1".into(),
            route_id: "acme/large".into(),
            connection_id: None,
            context_limit_tokens: None,
            output_limit_tokens: None,
            mode_id: mode.map(str::to_owned),
        }
    }

    #[test]
    fn the_engine_mode_appears_on_the_wire_only_when_the_conversation_has_one() {
        let v =
            bound_target_json(Some(&target_with_mode(Some("engineering-v2-adaptive")))).unwrap();
        assert_eq!(v["modeId"], "engineering-v2-adaptive");
        assert!(bound_target_json(Some(&target_with_mode(None)))
            .unwrap()
            .get("modeId")
            .is_none());
        // a stored target written before engine binding existed still loads, with no mode
        let old: ThreadTarget = serde_json::from_value(serde_json::json!({
            "providerId": "a", "logicalModelId": "a/b", "remoteModelId": "b", "routeId": "a/b"
        }))
        .or_else(|_| {
            serde_json::from_value(serde_json::json!({
                "provider_id": "a", "logical_model_id": "a/b", "remote_model_id": "b", "route_id": "a/b",
                "connection_id": null, "context_limit_tokens": null, "output_limit_tokens": null
            }))
        })
        .unwrap();
        assert!(old.mode_id.is_none());
    }

    #[test]
    fn a_thread_selection_carries_a_valid_engine_mode_and_refuses_the_rest() {
        let ok = parse_thread_selection(&serde_json::json!({
            "model": "p/remote", "route": "p/muse-adaptive", "modeId": "engineering-v2-adaptive"
        }))
        .unwrap()
        .unwrap();
        assert_eq!(ok.mode_id.as_deref(), Some("engineering-v2-adaptive"));
        assert_eq!(ok.route_id.as_deref(), Some("p/muse-adaptive"));
        // no mode: unchanged request shape, no mode
        let plain =
            parse_thread_selection(&serde_json::json!({ "model": "p/remote", "route": "r" }))
                .unwrap()
                .unwrap();
        assert!(plain.mode_id.is_none());
        // a mode alone, or an invalid one, is refused rather than guessed at
        assert!(parse_thread_selection(
            &serde_json::json!({ "modeId": "engineering-v2-adaptive" })
        )
        .is_err());
        assert!(parse_thread_selection(
            &serde_json::json!({ "model": "p/m", "modeId": "bad mode!" })
        )
        .is_err());
        assert!(parse_thread_selection(
            &serde_json::json!({ "model": "p/m", "modeId": "x".repeat(65) })
        )
        .is_err());
        assert!(parse_thread_selection(&serde_json::json!({}))
            .unwrap()
            .is_none());
    }
}
