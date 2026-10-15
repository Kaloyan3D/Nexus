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
}

impl ToolId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FsList => "fs.list",
            Self::FsRead => "fs.read",
            Self::FsSearch => "fs.search",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "fs.list" => Some(Self::FsList),
            "fs.read" => Some(Self::FsRead),
            "fs.search" => Some(Self::FsSearch),
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

fn dot() -> String {
    ".".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolArgs {
    List(ListArgs),
    Read(ReadArgs),
    Search(SearchArgs),
}

impl ToolArgs {
    pub fn tool_id(&self) -> ToolId {
        match self {
            Self::List(_) => ToolId::FsList,
            Self::Read(_) => ToolId::FsRead,
            Self::Search(_) => ToolId::FsSearch,
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
            Self::Search(a) => serde_json::json!({
                "path": a.path,
                "queryLen": a.query.len(),
                "queryDigest": sha256_hex(&a.query),
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
    /// Authorized workspace root, supplied by the trusted issuer. Never
    /// taken from model output.
    pub workspace_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: &'static str,
    pub version: u32,
    pub summary: &'static str,
    pub read_only: bool,
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
    };
    ToolDescriptor {
        id: id.as_str(),
        version: TOOL_VERSION,
        summary,
        read_only: true,
        arguments,
        defaults: ToolBudgets::default(),
        ceilings: ToolBudgets::ceiling(),
        notes: common,
    }
}

pub fn descriptors() -> Vec<ToolDescriptor> {
    [ToolId::FsList, ToolId::FsRead, ToolId::FsSearch]
        .into_iter()
        .map(descriptor_for)
        .collect()
}
