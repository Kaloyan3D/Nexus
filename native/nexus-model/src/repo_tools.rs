//! Model-visible read-only tool catalog for `repo-inspect` (A5.5).
//!
//! The catalog is a FIXED, versioned constant of this crate. A caller cannot
//! add, remove or reshape a tool: the OpenCode Go adapter builds the `tools`
//! array from here and from nowhere else, and the Controller maps a proposed
//! call back through [`tool_id_for`], which knows exactly three names.
//!
//! Provider function names must match `^[A-Za-z0-9_-]+$`, so the wire names
//! use underscores (`fs_list`); they map 1:1 onto the Kernel tool ids
//! (`fs.list`). Argument names are the native tool contract's own
//! (`startLine`, `maxLines`, `caseInsensitive`, `maxMatches`), so a model
//! proposal is validated by the very same strict parser the native tools use
//! (`deny_unknown_fields`). There is no write, edit, process or shell tool.

use serde_json::{json, Value};

/// Version of the model-visible catalog. Bump on any schema change.
pub const REPO_TOOLS_VERSION: u32 = 1;

/// Largest line count the model may request in one `fs_read`.
pub const MODEL_MAX_READ_LINES: u32 = 400;
/// Largest match count the model may request in one `fs_search`.
pub const MODEL_MAX_SEARCH_MATCHES: u32 = 50;

/// One catalog entry: provider-visible name and Kernel tool id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoTool {
    pub model_name: &'static str,
    pub tool_id: &'static str,
}

pub const CATALOG: [RepoTool; 3] = [
    RepoTool {
        model_name: "fs_list",
        tool_id: "fs.list",
    },
    RepoTool {
        model_name: "fs_read",
        tool_id: "fs.read",
    },
    RepoTool {
        model_name: "fs_search",
        tool_id: "fs.search",
    },
];

/// `repo-code` additions (A5.6). Offered ONLY under the `RepoCodeV1` profile;
/// the `repo-inspect` catalog above is unchanged and stays read-only.
pub const CODE_EXTRA: [RepoTool; 3] = [
    RepoTool {
        model_name: "fs_write",
        tool_id: "fs.write",
    },
    RepoTool {
        model_name: "fs_edit",
        tool_id: "fs.edit",
    },
    RepoTool {
        model_name: "proc_run",
        tool_id: "proc.run",
    },
];

/// Largest `content` the model may propose in one `fs_write`.
pub const MODEL_MAX_WRITE_CHARS: usize = 32 * 1024;
/// Largest number of edit operations in one `fs_edit`.
pub const MODEL_MAX_EDITS: usize = 8;
/// Commands the model may name (the sandbox command policy still decides).
pub const MODEL_PROGRAMS: [&str; 3] = ["cargo", "npm", "tsc"];

/// Map a provider-proposed tool name to its Kernel tool id for `profile`.
pub fn tool_id_for_profile(
    profile: crate::request::ToolProfile,
    model_name: &str,
) -> Option<&'static str> {
    use crate::request::ToolProfile as P;
    match profile {
        P::RepoInspectV1 => tool_id_for(model_name),
        P::RepoCodeV1 => tool_id_for(model_name).or_else(|| {
            CODE_EXTRA
                .iter()
                .find(|t| t.model_name == model_name)
                .map(|t| t.tool_id)
        }),
    }
}

/// Map a provider-proposed tool name to its Kernel tool id. Anything that is
/// not one of the three catalog names (including a Kernel id such as
/// `fs.write`, `proc.run`, or a daemon operation) is `None`.
pub fn tool_id_for(model_name: &str) -> Option<&'static str> {
    CATALOG
        .iter()
        .find(|t| t.model_name == model_name)
        .map(|t| t.tool_id)
}

/// The exact `tools` array sent to the provider.
pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "fs_list",
            "description": "List the entries of a directory inside the inspected repository. Paths are relative to the repository root (\".\" is the root). Read-only; hidden, VCS and credential paths are not listed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory relative to the repository root. Default \".\"."}
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "fs_read",
            "description": "Read a bounded range of lines from one UTF-8 text file inside the repository. Output is line-numbered. Binary, oversized, hidden, VCS and credential files are refused.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File relative to the repository root."},
                    "startLine": {"type": "integer", "minimum": 1, "description": "1-based first line. Default 1."},
                    "maxLines": {"type": "integer", "minimum": 1, "maximum": MODEL_MAX_READ_LINES, "description": "Maximum number of lines to return."}
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "fs_search",
            "description": "Search file contents under a path for a literal string. Returns bounded matches with file and line numbers. Hidden, VCS, build and credential paths are skipped.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": 256, "description": "Literal text to find."},
                    "path": {"type": "string", "description": "Directory or file relative to the repository root. Default \".\"."},
                    "caseInsensitive": {"type": "boolean", "description": "Default false."},
                    "maxMatches": {"type": "integer", "minimum": 1, "maximum": MODEL_MAX_SEARCH_MATCHES, "description": "Maximum number of matches to return."}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
    ]
}

/// The exact `tools` array for one profile.
pub fn definitions_for(profile: crate::request::ToolProfile) -> Vec<Value> {
    let mut v = definitions();
    if matches!(profile, crate::request::ToolProfile::RepoCodeV1) {
        v.extend(code_definitions());
    }
    v
}

fn code_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "fs_write",
            "description": "Create a new UTF-8 text file or replace an existing one inside the isolated working copy. Every write needs independent human approval before it runs; you will be told if it is denied. `replace` needs the `fileSha256` that fs_read returned for that file. Protected, hidden, credential and VCS paths are refused.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File relative to the repository root."},
                    "content": {"type": "string", "maxLength": MODEL_MAX_WRITE_CHARS, "description": "Complete new file content."},
                    "mode": {"type": "string", "enum": ["create", "replace"]},
                    "expectedSha256": {"type": "string", "description": "fileSha256 of the file as you last read it (replace only; filled in for you if omitted)."}
                },
                "required": ["path", "content", "mode"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "fs_edit",
            "description": "Apply exact-text replacements to an existing file. Each oldText must occur exactly once. Needs independent human approval. Prefer this over fs_write for small changes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File relative to the repository root."},
                    "expectedSha256": {"type": "string", "description": "fileSha256 of the file as you last read it (filled in for you if omitted)."},
                    "edits": {
                        "type": "array", "minItems": 1, "maxItems": MODEL_MAX_EDITS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "oldText": {"type": "string", "minLength": 1},
                                "newText": {"type": "string"}
                            },
                            "required": ["oldText", "newText"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["path", "edits"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "proc_run",
            "description": "Run an approved build or test command in an offline sandbox over a read-only snapshot of the working copy (no network, no writes persist). Only `cargo check|test|build|fmt --check` (with --offline), `npm test`, `npm run build` and `tsc --noEmit` exist. Needs independent human approval. Output is bounded.",
            "parameters": {
                "type": "object",
                "properties": {
                    "program": {"type": "string", "enum": MODEL_PROGRAMS},
                    "args": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
                    "cwd": {"type": "string", "description": "Directory relative to the repository root. Default \".\"."}
                },
                "required": ["program", "args"],
                "additionalProperties": false
            }
        }),
    ]
}

/// Digest of the exact catalog bytes for one profile.
pub fn catalog_digest_for(profile: crate::request::ToolProfile) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(&Value::Array(
        definitions_for(profile),
    )))
}

/// Digest of the exact catalog bytes (recorded with every run so a changed
/// schema is visible in the evidence).
pub fn catalog_digest() -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(&Value::Array(
        definitions(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_three_read_tools_and_no_mutating_or_process_names() {
        assert_eq!(definitions().len(), 3);
        for d in definitions() {
            let n = d["name"].as_str().unwrap();
            assert!(tool_id_for(n).is_some(), "{n}");
            assert!(n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
            assert_eq!(d["parameters"]["additionalProperties"], json!(false));
        }
        for bad in [
            "fs.list",
            "fs.read",
            "fs.search",
            "fs_write",
            "fs_edit",
            "proc_run",
            "fs.write",
            "fs.edit",
            "proc.run",
            "shell",
            "bash",
            "exec",
            "daemon",
            "FS_LIST",
            "fs_list ",
            "",
            "fs_read\0",
        ] {
            assert!(tool_id_for(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn code_catalog_adds_exactly_write_edit_and_run_and_inspect_stays_read_only() {
        use crate::request::ToolProfile as P;
        assert_eq!(definitions_for(P::RepoInspectV1), definitions());
        let code = definitions_for(P::RepoCodeV1);
        let names: Vec<&str> = code.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "fs_list",
                "fs_read",
                "fs_search",
                "fs_write",
                "fs_edit",
                "proc_run"
            ]
        );
        for d in &code {
            assert_eq!(d["parameters"]["additionalProperties"], json!(false));
        }
        for n in ["fs_write", "fs_edit", "proc_run"] {
            assert!(
                tool_id_for_profile(P::RepoInspectV1, n).is_none(),
                "{n} must not exist for inspect"
            );
            assert!(tool_id_for_profile(P::RepoCodeV1, n).is_some(), "{n}");
        }
        for bad in [
            "fs.write",
            "proc.run",
            "bash",
            "shell",
            "git",
            "git_commit",
            "fs_delete",
            "fs_move",
            "fs_chmod",
        ] {
            assert!(tool_id_for_profile(P::RepoCodeV1, bad).is_none(), "{bad}");
        }
        assert_ne!(
            catalog_digest_for(P::RepoCodeV1),
            catalog_digest_for(P::RepoInspectV1)
        );
        assert_eq!(catalog_digest_for(P::RepoInspectV1), catalog_digest());
    }

    #[test]
    fn catalog_digest_is_stable_and_versioned() {
        assert_eq!(REPO_TOOLS_VERSION, 1);
        assert_eq!(catalog_digest(), catalog_digest());
        assert_eq!(catalog_digest().len(), 64);
    }
}
