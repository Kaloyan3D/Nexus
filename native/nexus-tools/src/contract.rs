//! Versioned native tool contract: typed arguments, budgets, descriptors.

use crate::result::{ToolError, ToolErrorCode};
use nexus_contracts::{canonical_json, sha256_hex};
use serde::{Deserialize, Serialize};

pub const TOOL_CONTRACT_VERSION: u32 = 1;
/// Version of each A3.1 tool (all three ship at v1).
pub const TOOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolId {
    #[serde(rename = "fs.list")]
    FsList,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.search")]
    FsSearch,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "fs.edit")]
    FsEdit,
    #[serde(rename = "proc.run")]
    ProcRun,
}

impl ToolId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FsList => "fs.list",
            Self::FsRead => "fs.read",
            Self::FsSearch => "fs.search",
            Self::FsWrite => "fs.write",
            Self::FsEdit => "fs.edit",
            Self::ProcRun => "proc.run",
        }
    }
    /// True for tools that mutate the workspace (need a write scope).
    pub fn is_mutating(self) -> bool {
        matches!(self, Self::FsWrite | Self::FsEdit)
    }
    /// True for sandboxed subprocess execution (needs a process scope).
    pub fn is_process(self) -> bool {
        matches!(self, Self::ProcRun)
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "fs.list" => Some(Self::FsList),
            "fs.read" => Some(Self::FsRead),
            "fs.search" => Some(Self::FsSearch),
            "fs.write" => Some(Self::FsWrite),
            "fs.edit" => Some(Self::FsEdit),
            "proc.run" => Some(Self::ProcRun),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ListArgs {
    #[serde(default = "dot")]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadArgs {
    pub path: String,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub max_lines: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    #[serde(default = "dot")]
    pub path: String,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub max_matches: Option<u32>,
}

/// `fs.write`: create or replace a UTF-8 text file. Never implicit:
/// `create` requires absence; `replace` requires the exact pre-image hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
    /// `create` | `replace`
    pub mode: String,
    /// Required for `replace`: sha256 hex of the current file bytes.
    #[serde(default)]
    pub expected_sha256: Option<String>,
    /// Optional permission bits for `create` (octal string, <= 0777).
    #[serde(default)]
    pub file_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditOp {
    pub old_text: String,
    pub new_text: String,
}

/// `fs.edit`: ordered exact-content replacements on an existing file,
/// guarded by the pre-image hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditArgs {
    pub path: String,
    pub expected_sha256: String,
    pub edits: Vec<EditOp>,
}

/// `proc.run`: run one policy-approved command in the sandbox. There is no
/// shell string: `program` is a *logical name* resolved by the command
/// policy and `args` is the exact argument vector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessArgs {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Workspace-relative working directory inside the snapshot.
    #[serde(default = "dot")]
    pub cwd: String,
}

pub const MAX_EDITS: usize = 16;
pub const MAX_EDIT_TEXT: usize = 64 * 1024;

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn dot() -> String {
    ".".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolArgs {
    List(ListArgs),
    Read(ReadArgs),
    Search(SearchArgs),
    Write(WriteArgs),
    Edit(EditArgs),
    Proc(ProcessArgs),
}

impl ToolArgs {
    pub fn tool_id(&self) -> ToolId {
        match self {
            Self::List(_) => ToolId::FsList,
            Self::Read(_) => ToolId::FsRead,
            Self::Search(_) => ToolId::FsSearch,
            Self::Write(_) => ToolId::FsWrite,
            Self::Edit(_) => ToolId::FsEdit,
            Self::Proc(_) => ToolId::ProcRun,
        }
    }

    /// Typed parse + tool-specific validation of untrusted JSON.
    pub fn parse(tool: ToolId, raw: &serde_json::Value) -> Result<Self, ToolError> {
        let bad = |e: serde_json::Error| {
            ToolError::new(
                ToolErrorCode::InvalidArguments,
                ["arguments rejected: ", &e.to_string()].concat(),
            )
        };
        let parsed = match tool {
            ToolId::FsList => Self::List(serde_json::from_value(raw.clone()).map_err(bad)?),
            ToolId::FsRead => Self::Read(serde_json::from_value(raw.clone()).map_err(bad)?),
            ToolId::FsSearch => Self::Search(serde_json::from_value(raw.clone()).map_err(bad)?),
            ToolId::FsWrite => Self::Write(serde_json::from_value(raw.clone()).map_err(bad)?),
            ToolId::FsEdit => Self::Edit(serde_json::from_value(raw.clone()).map_err(bad)?),
            ToolId::ProcRun => Self::Proc(serde_json::from_value(raw.clone()).map_err(bad)?),
        };
        parsed.validate()?;
        Ok(parsed)
    }

    fn validate(&self) -> Result<(), ToolError> {
        let inv = |m: &str| Err(ToolError::new(ToolErrorCode::InvalidArguments, m));
        match self {
            Self::List(_) => Ok(()),
            Self::Read(a) => {
                if a.start_line == Some(0) {
                    return inv("startLine is 1-based");
                }
                if a.max_lines == Some(0) {
                    return inv("maxLines must be positive");
                }
                Ok(())
            }
            Self::Write(a) => {
                match a.mode.as_str() {
                    "create" => {
                        if a.expected_sha256.is_some() {
                            return inv("create must not carry expectedSha256");
                        }
                    }
                    "replace" => match &a.expected_sha256 {
                        Some(h) if is_sha256_hex(h) => {}
                        _ => return inv("replace requires a 64-hex expectedSha256"),
                    },
                    _ => return inv("mode must be 'create' or 'replace'"),
                }
                if a.content.contains('\0') {
                    return inv("content must be text (no NUL)");
                }
                if let Some(m) = &a.file_mode {
                    match u32::from_str_radix(m, 8) {
                        Ok(v) if v <= 0o777 && v != 0 => {}
                        _ => return inv("fileMode must be octal permission bits (<= 0777)"),
                    }
                    if a.mode != "create" {
                        return inv("fileMode applies only to create (replace preserves mode)");
                    }
                }
                Ok(())
            }
            Self::Proc(a) => {
                if a.program.is_empty() || a.program.len() > 64 {
                    return inv("program must be a known command name (1..=64 bytes)");
                }
                if a.args.len() > 64 {
                    return inv("at most 64 arguments");
                }
                for x in &a.args {
                    if x.len() > 4096
                        || x.contains('\0')
                        || x.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
                    {
                        return inv("arguments must be plain text (no NUL/control characters, <= 4096 bytes)");
                    }
                }
                Ok(())
            }
            Self::Edit(a) => {
                if !is_sha256_hex(&a.expected_sha256) {
                    return inv("expectedSha256 must be 64 lowercase hex");
                }
                if a.edits.is_empty() || a.edits.len() > MAX_EDITS {
                    return inv("edits must contain 1..=16 operations");
                }
                for e in &a.edits {
                    if e.old_text.is_empty() {
                        return inv("oldText must not be empty");
                    }
                    if e.old_text.len() > MAX_EDIT_TEXT || e.new_text.len() > MAX_EDIT_TEXT {
                        return inv("edit text exceeds 64 KiB");
                    }
                    if e.old_text.contains('\0') || e.new_text.contains('\0') {
                        return inv("edit text must not contain NUL");
                    }
                }
                Ok(())
            }
            Self::Search(a) => {
                if a.query.is_empty() {
                    return inv("query must not be empty");
                }
                if a.query.len() > 256 {
                    return inv("query exceeds 256 bytes");
                }
                if a.query.contains('\0') {
                    return inv("query must not contain NUL");
                }
                if a.max_matches == Some(0) {
                    return inv("maxMatches must be positive");
                }
                Ok(())
            }
        }
    }

    /// Canonical, order-independent digest of the typed arguments.
    pub fn digest(&self) -> String {
        let v = match self {
            Self::List(a) => serde_json::to_value(a),
            Self::Read(a) => serde_json::to_value(a),
            Self::Search(a) => serde_json::to_value(a),
            Self::Write(a) => serde_json::to_value(a),
            Self::Edit(a) => serde_json::to_value(a),
            Self::Proc(a) => serde_json::to_value(a),
        }
        .unwrap_or(serde_json::Value::Null);
        sha256_hex(&canonical_json(&serde_json::json!({
            "tool": self.tool_id().as_str(),
            "args": v,
        })))
    }

    /// Redacted argument metadata for the journal: never the search query
    /// text (it may itself be a secret), only its length and digest.
    pub fn journal_meta(&self) -> serde_json::Value {
        match self {
            Self::List(a) => serde_json::json!({ "path": a.path }),
            Self::Read(a) => serde_json::json!({
                "path": a.path, "startLine": a.start_line, "maxLines": a.max_lines,
            }),
            // Content and edit text are never journaled; only structure.
            Self::Write(a) => serde_json::json!({
                "path": a.path, "mode": a.mode, "contentBytes": a.content.len(),
                "expectedSha256": a.expected_sha256,
            }),
            Self::Edit(a) => serde_json::json!({
                "path": a.path, "expectedSha256": a.expected_sha256, "edits": a.edits.len(),
            }),
            // The argv itself is journaled after redaction by the process
            // layer; here only structure + digest of the argument vector.
            Self::Proc(a) => serde_json::json!({
                "program": a.program, "argc": a.args.len(), "cwd": a.cwd,
            }),
            Self::Search(a) => serde_json::json!({
                "path": a.path,
                "queryLen": a.query.len(),
                "caseInsensitive": a.case_insensitive,
                "maxMatches": a.max_matches,
            }),
        }
    }
}

/// Resource budgets. Requested values are clamped to hard ceilings; the
/// clamped value's digest is what the Kernel seals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ToolBudgets {
    pub max_file_bytes: u64,
    pub max_output_bytes: u64,
    pub max_entries: u32,
    pub max_dir_entries_scan: u32,
    pub max_matches: u32,
    pub max_dirs: u32,
    pub max_files: u32,
    pub max_scan_bytes: u64,
    pub max_depth: u32,
    pub max_line_bytes: u32,
    pub deadline_ms: u64,
    /// Maximum bytes of content a write/edit may publish.
    pub max_write_bytes: u64,
    // ---- A3.4 sandboxed process budgets --------------------------------
    pub proc_wall_ms: u64,
    pub proc_cpu_secs: u64,
    pub proc_memory_bytes: u64,
    pub proc_max_procs: u64,
    /// Per-stream captured output cap (stdout and stderr each).
    pub proc_output_bytes: u64,
    pub proc_scratch_bytes: u64,
    pub stage_max_files: u64,
    pub stage_max_bytes: u64,
}

impl Default for ToolBudgets {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            max_output_bytes: 64 * 1024,
            max_entries: 1000,
            max_dir_entries_scan: 10_000,
            max_matches: 100,
            max_dirs: 500,
            max_files: 2000,
            max_scan_bytes: 16 * 1024 * 1024,
            max_depth: 16,
            max_line_bytes: 4096,
            deadline_ms: 10_000,
            max_write_bytes: 256 * 1024,
            proc_wall_ms: 120_000,
            proc_cpu_secs: 120,
            proc_memory_bytes: 2 * 1024 * 1024 * 1024,
            proc_max_procs: 256,
            proc_output_bytes: 256 * 1024,
            proc_scratch_bytes: 512 * 1024 * 1024,
            stage_max_files: 20_000,
            stage_max_bytes: 256 * 1024 * 1024,
        }
    }
}

impl ToolBudgets {
    /// Absolute ceilings no request or grant can exceed.
    pub fn ceiling() -> Self {
        Self {
            max_file_bytes: 8 * 1024 * 1024,
            max_output_bytes: 1024 * 1024,
            max_entries: 10_000,
            max_dir_entries_scan: 50_000,
            max_matches: 1000,
            max_dirs: 5000,
            max_files: 20_000,
            max_scan_bytes: 256 * 1024 * 1024,
            max_depth: 32,
            max_line_bytes: 16 * 1024,
            deadline_ms: 60_000,
            max_write_bytes: 4 * 1024 * 1024,
            proc_wall_ms: 900_000,
            proc_cpu_secs: 900,
            proc_memory_bytes: 8 * 1024 * 1024 * 1024,
            proc_max_procs: 1024,
            proc_output_bytes: 2 * 1024 * 1024,
            proc_scratch_bytes: 2 * 1024 * 1024 * 1024,
            stage_max_files: 100_000,
            stage_max_bytes: 1024 * 1024 * 1024,
        }
    }

    pub fn clamped(&self) -> Self {
        let c = Self::ceiling();
        let at_least_one = |v: u64| v.max(1);
        Self {
            max_file_bytes: at_least_one(self.max_file_bytes).min(c.max_file_bytes),
            max_output_bytes: at_least_one(self.max_output_bytes).min(c.max_output_bytes),
            max_entries: at_least_one(self.max_entries as u64).min(c.max_entries as u64) as u32,
            max_dir_entries_scan: at_least_one(self.max_dir_entries_scan as u64)
                .min(c.max_dir_entries_scan as u64) as u32,
            max_matches: at_least_one(self.max_matches as u64).min(c.max_matches as u64) as u32,
            max_dirs: at_least_one(self.max_dirs as u64).min(c.max_dirs as u64) as u32,
            max_files: at_least_one(self.max_files as u64).min(c.max_files as u64) as u32,
            max_scan_bytes: at_least_one(self.max_scan_bytes).min(c.max_scan_bytes),
            max_depth: at_least_one(self.max_depth as u64).min(c.max_depth as u64) as u32,
            max_line_bytes: at_least_one(self.max_line_bytes as u64).min(c.max_line_bytes as u64)
                as u32,
            deadline_ms: at_least_one(self.deadline_ms).min(c.deadline_ms),
            max_write_bytes: at_least_one(self.max_write_bytes).min(c.max_write_bytes),
            proc_wall_ms: at_least_one(self.proc_wall_ms).min(c.proc_wall_ms),
            proc_cpu_secs: at_least_one(self.proc_cpu_secs).min(c.proc_cpu_secs),
            proc_memory_bytes: at_least_one(self.proc_memory_bytes).min(c.proc_memory_bytes),
            proc_max_procs: at_least_one(self.proc_max_procs).min(c.proc_max_procs),
            proc_output_bytes: at_least_one(self.proc_output_bytes).min(c.proc_output_bytes),
            proc_scratch_bytes: at_least_one(self.proc_scratch_bytes).min(c.proc_scratch_bytes),
            stage_max_files: at_least_one(self.stage_max_files).min(c.stage_max_files),
            stage_max_bytes: at_least_one(self.stage_max_bytes).min(c.stage_max_bytes),
        }
    }

    pub fn digest(&self) -> String {
        let v = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        sha256_hex(&canonical_json(&v))
    }
}

/// One tool-execution request as it arrives from an issuer. Untrusted
/// until bound to a Kernel-sealed grant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ToolRequestV1 {
    pub schema_version: u32,
    pub request_id: String,
    pub cancellation_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub tool_id: String,
    pub tool_version: u32,
    pub args: serde_json::Value,
    pub budgets: ToolBudgets,
    // NOTE (A3.2): there is deliberately no workspace root here. The root
    // comes only from the Kernel-sealed Controller workspace binding.
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: &'static str,
    pub version: u32,
    pub summary: &'static str,
    pub read_only: bool,
    /// True when execution needs an independently approved write scope.
    pub requires_write_scope: bool,
    pub arguments: Vec<ArgDescriptor>,
    pub defaults: ToolBudgets,
    pub ceilings: ToolBudgets,
    pub notes: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgDescriptor {
    pub name: &'static str,
    pub kind: &'static str,
    pub required: bool,
    pub description: &'static str,
}

fn arg(name: &'static str, kind: &'static str, required: bool, d: &'static str) -> ArgDescriptor {
    ArgDescriptor {
        name,
        kind,
        required,
        description: d,
    }
}

pub fn descriptor_for(id: ToolId) -> ToolDescriptor {
    let common = vec![
        "Paths are workspace-relative; absolute paths, '..', backslashes and encoded separators are refused.",
        "Symlinks are never followed. Special files, hidden files (except a small allowlist) and credential files are refused.",
        "Execution requires a Kernel-sealed grant; this tool never self-authorizes.",
    ];
    let (summary, arguments) = match id {
        ToolId::FsList => (
            "List a directory's entries in deterministic byte order.",
            vec![arg("path", "string", false, "directory, default '.'")],
        ),
        ToolId::FsRead => (
            "Read lines of a regular UTF-8 text file.",
            vec![
                arg("path", "string", true, "file path"),
                arg("startLine", "u32", false, "1-based first line"),
                arg("maxLines", "u32", false, "maximum lines returned"),
            ],
        ),
        ToolId::FsSearch => (
            "Literal substring search across permitted text files.",
            vec![
                arg("query", "string", true, "literal text, 1..=256 bytes"),
                arg("path", "string", false, "file or directory, default '.'"),
                arg("caseInsensitive", "bool", false, "case-insensitive match"),
                arg("maxMatches", "u32", false, "cap on returned matches"),
            ],
        ),
        ToolId::FsWrite => (
            "Create or replace a UTF-8 text file atomically, with explicit pre-image checks.",
            vec![
                arg(
                    "path",
                    "string",
                    true,
                    "file path; parent directory must exist",
                ),
                arg(
                    "content",
                    "string",
                    true,
                    "new content, bounded by maxWriteBytes",
                ),
                arg(
                    "mode",
                    "string",
                    true,
                    "'create' (must not exist) or 'replace'",
                ),
                arg(
                    "expectedSha256",
                    "string",
                    false,
                    "required for replace: sha256 of current bytes",
                ),
                arg(
                    "fileMode",
                    "string",
                    false,
                    "create only: octal permission bits",
                ),
            ],
        ),
        ToolId::FsEdit => (
            "Apply ordered exact-text edits to an existing file, guarded by its sha256.",
            vec![
                arg("path", "string", true, "file path"),
                arg(
                    "expectedSha256",
                    "string",
                    true,
                    "sha256 of the current file bytes",
                ),
                arg(
                    "edits",
                    "array",
                    true,
                    "1..=16 {oldText,newText}; each oldText must match exactly once",
                ),
            ],
        ),
        ToolId::ProcRun => (
            "Run a policy-approved command (cargo check/test/build/fmt, npm test, npm run build, tsc --noEmit) in an isolated sandbox over a read-only snapshot. No shell, no network.",
            vec![
                arg("program", "string", true, "logical command name: cargo | npm | tsc"),
                arg("args", "array", false, "exact argv (validated by the command policy)"),
                arg("cwd", "string", false, "snapshot-relative working directory, default '.'"),
            ],
        ),
    };
    ToolDescriptor {
        id: id.as_str(),
        version: TOOL_VERSION,
        summary,
        read_only: !id.is_mutating() && !id.is_process(),
        requires_write_scope: id.is_mutating() || id.is_process(),
        arguments,
        defaults: ToolBudgets::default(),
        ceilings: ToolBudgets::ceiling(),
        notes: common,
    }
}

pub fn descriptors() -> Vec<ToolDescriptor> {
    [
        ToolId::FsList,
        ToolId::FsRead,
        ToolId::FsSearch,
        ToolId::FsWrite,
        ToolId::FsEdit,
        ToolId::ProcRun,
    ]
    .into_iter()
    .map(descriptor_for)
    .collect()
}
