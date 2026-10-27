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
pub const MODEL_MAX_READ_LINES: u32 = 800;
/// Largest match count the model may request in one `fs_search`.
pub const MODEL_MAX_SEARCH_MATCHES: u32 = 100;

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
pub const MODEL_MAX_WRITE_CHARS: usize = 96 * 1024;
/// Largest number of edit operations in one `fs_edit`.
pub const MODEL_MAX_EDITS: usize = 16;
/// Programs the STRICT profile may name. The workbench (Workspace-authorized) profile has no
/// name allowlist since M6A: `program` is a free string there, validated syntactically by the
/// broker and resolved by the daemon's command policy inside the sandbox.
pub const MODEL_PROGRAMS: [&str; 13] = [
    "cargo", "npm", "npx", "pnpm", "yarn", "node", "tsc", "python3", "pip", "go", "dotnet", "sh",
    "make",
];

/// Map a provider-proposed tool name to its Kernel tool id for `profile`.
pub fn tool_id_for_profile(
    profile: crate::request::ToolProfile,
    model_name: &str,
) -> Option<&'static str> {
    use crate::request::ToolProfile as P;
    match profile {
        P::RepoInspectV1 => tool_id_for(model_name),
        // the signals tool is broker-handled control-plane input: it has no Kernel tool id
        P::RepoCodeV1 | P::RepoCodeMuseSignalsV1 => tool_id_for(model_name).or_else(|| {
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
    use crate::request::ToolProfile as P;
    let mut v = definitions();
    if matches!(profile, P::RepoCodeV1 | P::RepoCodeMuseSignalsV1) {
        v.extend(code_definitions());
    }
    if profile == P::RepoCodeMuseSignalsV1 {
        v.push(muse_signals_definition());
    }
    v
}

/// EM-04B: the historical Muse reasoning-signals tool (`config/Muse-ReasoningSignals.cjs`,
/// `defineReasoningSignalTool`), in the Native definition shape: the same name, description and
/// nine event fields, closed with `additionalProperties: false`. There is deliberately no effort,
/// counter, identity or provider field. A test compares it byte for byte with the definition the
/// CommonJS module produces.
pub const MUSE_SIGNALS_TOOL: &str = "muse_update_reasoning_state";

/// The canonical cognitive phases (historical Governor order).
pub const MUSE_PHASES: [&str; 7] = [
    "discover",
    "diagnose",
    "design",
    "implement",
    "verify",
    "recover",
    "review",
];

pub fn muse_signals_definition() -> Value {
    let description = [
        "Report a structured reasoning-state change for the current Muse engineering task.",
        "Call when the trajectory meaningfully changes cognitive phase or when strong evidence is established:",
        "starting investigation (discover), resolving root cause (diagnose), choosing a technical approach (design),",
        "executing an established solution (implement), checking a result (verify), responding to an unexpected",
        "failure (recover), or critically inspecting a candidate result (review).",
        "Also report a confirmed root cause, a confirmed solution, a ruled-out hypothesis, a failed implementation",
        "attempt, or conflicting observations.",
        "Report implement before beginning established implementation work, verify before checking a candidate",
        "implementation, and recover when an unexpected failure turns the task into failure investigation.",
        "Do not call before every ordinary read, edit, or test -- only on meaningful transitions.",
        "Fields are events, not settings: recordHypothesisFailure and recordImplementationFailure each record ONE",
        "event (Nexus counts them). You cannot select reasoning effort and there is no effort field; Nexus validates",
        "every signal and allocates compute from the resulting state.",
    ]
    .join(" ");
    let flag = |d: &str| json!({"type": "boolean", "description": d});
    json!({
        "type": "function",
        "name": MUSE_SIGNALS_TOOL,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "phase": {
                    "type": "string",
                    "enum": MUSE_PHASES,
                    "description": "New cognitive phase: discover, diagnose, design, implement, verify, recover, or review.",
                },
                "markRootCauseEstablished": flag("The root cause is confirmed. Event: true records it and opens a fresh diagnosis window; omit or false for no change."),
                "invalidateRootCause": flag("Later evidence disproved the diagnosis. Event: true clears both the root cause and the solution; omit or false for no change."),
                "markSolutionEstablished": flag("The technical solution is confirmed. Event: true records it and opens a fresh implementation window; omit or false for no change."),
                "invalidateSolution": flag("Implementation evidence disproved the chosen approach (diagnosis still holds). Event: true clears the solution only; omit or false for no change."),
                "recordHypothesisFailure": flag("One ruled-out hypothesis. Event: true records exactly one failure; Nexus counts."),
                "recordImplementationFailure": flag("One failed implementation attempt. Event: true records exactly one failure; Nexus counts."),
                "conflictingEvidence": flag("Observations genuinely conflict. Event: true records it; omit or false for no change."),
                "resolveConflictingEvidence": flag("New evidence reconciled the conflict. Event: true clears it; omit or false for no change."),
            },
            "additionalProperties": false,
        },
    })
}

fn code_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "fs_write",
            "description": "Create a new UTF-8 text file, replace an existing one, or delete one inside the isolated working copy. `replace` and `delete` need the `fileSha256` that fs_read returned for that file (filled in for you if you read it earlier). `delete` takes no content. Credential, VCS, CI and generated-directory paths are refused.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File relative to the repository root."},
                    "content": {"type": "string", "maxLength": MODEL_MAX_WRITE_CHARS, "description": "Complete new file content (omit for delete)."},
                    "mode": {"type": "string", "enum": ["create", "replace", "delete"]},
                    "expectedSha256": {"type": "string", "description": "fileSha256 of the file as you last read it (replace only; filled in for you if omitted)."}
                },
                "required": ["path", "mode"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "fs_edit",
            "description": "Apply exact-text replacements to an existing file. Each oldText must occur exactly once. Runs under the approval policy in force. Prefer this over fs_write for small changes.",
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
            "description": "Run a development command in an isolated sandbox over a throw-away copy of the working copy. No network except dependency installation (`npm ci`/`npm install`, `pip install`, `go mod download`, `dotnet restore`, `cargo fetch`, when the project permits installs; installed dependencies stay available later). Run installs (npm ci, cargo fetch) DIRECTLY as their own command, never inside `sh -c` (no network there). Files a command writes (build output, caches) are discarded; change files with fs_write/fs_edit. Name ANY installed program (cargo, rustc, git, bash, node, python3, npm, go, make, formatters, linters, test runners) or a project-local executable by relative path (./node_modules/.bin/<tool>, scripts/<script>); an uninstalled program fails with an explanation. Use `sh -c \"<script>\"` or `bash -c \"<script>\"` for pipelines and && chains (a pipeline fails if any stage fails; one cut off by `head` is `unverified`). A failing command is information: read its output, fix the cause and run it again. Output is bounded.",
            "parameters": {
                "type": "object",
                "properties": {
                    "program": {"type": "string", "description": "Installed program name, or workspace-relative path to a project-local executable."},
                    "args": {"type": "array", "items": {"type": "string"}, "maxItems": 64},
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

/// EM-04C1: digest of the exact bytes of an arbitrary `tools` array (the digest a request's
/// catalog would have).
pub fn catalog_digest_of(definitions: &[Value]) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(&Value::Array(
        definitions.to_vec(),
    )))
}

/// EM-04C1: the frozen identity of each catalog. A catalog is a product of this crate's code
/// alone; these constants pin what each profile offered at EM-04C1 so that ANY edit of a profile's
/// tools (a description, a parameter, one more tool) is caught by a test and by the run-start
/// guard (`verify_catalog`) instead of silently reaching a provider. `RepoCodeV1` is the
/// production `muse-v0` catalog and must never change here; the signals catalog is the future Muse
/// engine's and has its own, distinct identity. The two code catalogs changed exactly once, in
/// M6A: `proc_run`'s `program` went from a 13-name enum to a free string so any installed
/// program (or project-local path) can be named — an intentional, classified provider-schema
/// difference, not parity drift. `RepoInspectV1` is byte-identical to before.
pub const REPO_INSPECT_V1_CATALOG_DIGEST: &str =
    "b06d9c9f542b2e3fcc3d2a289f89c2ea201ff9b4ffec4af7d327ba62b4592ff6";
pub const REPO_CODE_V1_CATALOG_DIGEST: &str =
    "e464de5c5a534aac38c7c50d36a7c1c081bf3d4584f825a8e617be9c24ae0c4c";
pub const REPO_CODE_MUSE_SIGNALS_V1_CATALOG_DIGEST: &str =
    "7c7c9bc17ad4f849840c4d733d98126234dbfba075e7adf6c95775b4c81d28e8";

/// The frozen digest of `profile`'s catalog.
pub fn frozen_catalog_digest(profile: crate::request::ToolProfile) -> &'static str {
    use crate::request::ToolProfile as P;
    match profile {
        P::RepoInspectV1 => REPO_INSPECT_V1_CATALOG_DIGEST,
        P::RepoCodeV1 => REPO_CODE_V1_CATALOG_DIGEST,
        P::RepoCodeMuseSignalsV1 => REPO_CODE_MUSE_SIGNALS_V1_CATALOG_DIGEST,
    }
}

/// Whether `definitions` are exactly the frozen catalog of `profile`.
pub fn catalog_matches(profile: crate::request::ToolProfile, definitions: &[Value]) -> bool {
    catalog_digest_of(definitions) == frozen_catalog_digest(profile)
}

/// Whether this build offers exactly the frozen catalog for `profile`.
pub fn verify_catalog(profile: crate::request::ToolProfile) -> bool {
    catalog_matches(profile, &definitions_for(profile))
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
    #[test]
    fn the_command_tool_tells_the_model_that_installs_must_run_directly() {
        // found live (R-NATIVE-3 run 14): `npm install` inside `sh -c` has no network, the model tried it
        // once, gave up, and never ran the frontend checks
        let defs = definitions_for(crate::request::ToolProfile::RepoCodeV1);
        let d = defs
            .iter()
            .find(|d| d["name"] == "proc_run")
            .expect("proc_run is offered")["description"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(d.contains("DIRECTLY"), "{d}");
        assert!(d.contains("inside `sh -c`"), "{d}");
        assert!(d.contains("cargo fetch"), "{d}");
        assert!(d.contains("npm ci"), "{d}");
        // every byte of this text is sent with EVERY request (a614's request-size limit has little headroom)
        assert!(
            d.len() < 2200,
            "the command tool description grew to {} bytes",
            d.len()
        );
        assert!(d.contains("`unverified`"), "{d}");
    }

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
    fn the_experimental_signals_catalog_only_adds_the_signals_tool_and_code_is_unchanged() {
        use crate::request::ToolProfile as P;
        let code = definitions_for(P::RepoCodeV1);
        let sig = definitions_for(P::RepoCodeMuseSignalsV1);
        assert_eq!(
            sig[..code.len()],
            code[..],
            "RepoCodeV1 is a byte-identical prefix"
        );
        assert_eq!(sig.len(), code.len() + 1);
        assert_eq!(sig[code.len()]["name"], MUSE_SIGNALS_TOOL);
        // no effort/counter/identity field is offered
        let props = sig[code.len()]["parameters"]["properties"]
            .as_object()
            .unwrap();
        assert_eq!(props.len(), 9);
        for k in props.keys() {
            assert!(!k.to_ascii_lowercase().contains("effort"), "{k}");
        }
        // broker-handled: no Kernel tool id
        assert!(tool_id_for_profile(P::RepoCodeMuseSignalsV1, MUSE_SIGNALS_TOOL).is_none());
        assert_eq!(
            tool_id_for_profile(P::RepoCodeMuseSignalsV1, "fs_write"),
            tool_id_for_profile(P::RepoCodeV1, "fs_write")
        );
        // the exact measured wire bytes (EM-04A reserve: 2,881 + separator)
        assert_eq!(
            nexus_contracts::canonical_json(&muse_signals_definition()).len(),
            2_881
        );
        assert_eq!(
            nexus_contracts::canonical_json(&Value::Array(sig.clone())).len(),
            nexus_contracts::canonical_json(&Value::Array(code)).len() + 2_882
        );
    }

    /// The three catalogs have DISTINCT, frozen identities. The first two are what the baseline
    /// build (`49026e8`, before EM-04C1) offered, byte for byte; the signals catalog is the future
    /// Muse engine's and can never be mistaken for `muse-v0`'s.
    #[test]
    fn each_catalog_has_its_own_frozen_identity() {
        use crate::request::ToolProfile as P;
        assert_eq!(
            REPO_INSPECT_V1_CATALOG_DIGEST,
            "b06d9c9f542b2e3fcc3d2a289f89c2ea201ff9b4ffec4af7d327ba62b4592ff6"
        );
        assert_eq!(
            REPO_CODE_V1_CATALOG_DIGEST,
            "e464de5c5a534aac38c7c50d36a7c1c081bf3d4584f825a8e617be9c24ae0c4c"
        );
        assert_eq!(
            REPO_CODE_MUSE_SIGNALS_V1_CATALOG_DIGEST,
            "7c7c9bc17ad4f849840c4d733d98126234dbfba075e7adf6c95775b4c81d28e8"
        );
        let all = [P::RepoInspectV1, P::RepoCodeV1, P::RepoCodeMuseSignalsV1];
        for p in all {
            assert_eq!(catalog_digest_for(p), frozen_catalog_digest(p), "{p:?}");
            assert!(verify_catalog(p), "{p:?}");
        }
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(frozen_catalog_digest(*a), frozen_catalog_digest(*b));
            }
        }
    }

    /// Any edit of a catalog - a description, a parameter, an added or removed tool, a reordering,
    /// or the signals tool smuggled into the production catalog - changes its digest and is caught.
    #[test]
    fn a_mismatched_catalog_is_detected() {
        use crate::request::ToolProfile as P;
        let code = definitions_for(P::RepoCodeV1);
        let sig = definitions_for(P::RepoCodeMuseSignalsV1);
        // the production catalog offered with the signals tool, and the signals catalog without it
        assert!(!catalog_matches(P::RepoCodeV1, &sig));
        assert!(!catalog_matches(P::RepoCodeMuseSignalsV1, &code));
        // cross-profile
        assert!(!catalog_matches(P::RepoInspectV1, &code));
        assert!(!catalog_matches(
            P::RepoCodeV1,
            &definitions_for(P::RepoInspectV1)
        ));
        // one character of one description
        let mut edited = code.clone();
        let d = edited[0]["description"].as_str().unwrap().to_owned();
        edited[0]["description"] = Value::String(format!("{d} "));
        assert!(!catalog_matches(P::RepoCodeV1, &edited));
        // a parameter widened
        let mut widened = code.clone();
        widened[1]["parameters"]["additionalProperties"] = Value::Bool(true);
        assert!(!catalog_matches(P::RepoCodeV1, &widened));
        // reordered
        let mut swapped = code.clone();
        swapped.swap(0, 1);
        assert!(!catalog_matches(P::RepoCodeV1, &swapped));
        // an extra or a missing tool
        let mut extra = code.clone();
        extra.push(muse_signals_definition());
        assert!(!catalog_matches(P::RepoCodeV1, &extra));
        assert!(!catalog_matches(P::RepoCodeV1, &code[..code.len() - 1]));
        // and the real ones match
        assert!(catalog_matches(P::RepoCodeV1, &code));
        assert!(catalog_matches(P::RepoCodeMuseSignalsV1, &sig));
    }

    /// The signals tool is a tool of exactly one profile; the production profiles refuse its name.
    #[test]
    fn the_signals_tool_belongs_to_one_catalog_only() {
        use crate::request::ToolProfile as P;
        let names = |p: P| -> Vec<String> {
            definitions_for(p)
                .iter()
                .map(|d| d["name"].as_str().unwrap().to_owned())
                .collect()
        };
        assert!(!names(P::RepoInspectV1).contains(&MUSE_SIGNALS_TOOL.to_owned()));
        assert!(!names(P::RepoCodeV1).contains(&MUSE_SIGNALS_TOOL.to_owned()));
        assert!(names(P::RepoCodeMuseSignalsV1).contains(&MUSE_SIGNALS_TOOL.to_owned()));
        for p in [P::RepoInspectV1, P::RepoCodeV1, P::RepoCodeMuseSignalsV1] {
            assert!(tool_id_for_profile(p, MUSE_SIGNALS_TOOL).is_none(), "{p:?}");
        }
    }

    #[test]
    fn catalog_digest_is_stable_and_versioned() {
        assert_eq!(REPO_TOOLS_VERSION, 1);
        assert_eq!(catalog_digest(), catalog_digest());
        assert_eq!(catalog_digest().len(), 64);
    }
}

// -------------------------------------------------------------------------------------------
// M7D agent job tools (catalog addition, versioned separately). The V1 catalogs above are
// frozen and byte-identical; these four tools are the background-job surface for engines that
// adopt them. They are broker-handled (no Kernel tool id): the broker's JobManager runs the
// job under the project's frozen standing grant. `proc_run` is unchanged and stays synchronous.

pub const JOB_TOOLS: [&str; 4] = ["job_start", "job_status", "job_logs", "job_stop"];

/// The four job tool definitions (same envelope shape as the repository tools).
pub fn job_tool_definitions() -> serde_json::Value {
    let proc = |name: &str, description: &str, props: serde_json::Value, required: &[&str]| {
        serde_json::json!({
            "type": "function", "name": name, "description": description, "strict": true,
            "parameters": {"type": "object", "properties": props, "required": required, "additionalProperties": false}
        })
    };
    serde_json::json!([
        proc("job_start",
            "Start a long-running background job (development server, watcher) in the project and return immediately with its job id. The job runs sandboxed in the real project folder under the project's permission; only development ports the user authorized for this project can be exposed on their loopback. Dependency installs are foreground proc_run commands, not jobs.",
            serde_json::json!({
                "program": {"type": "string", "description": "Installed program name, or workspace-relative path to a project-local executable."},
                "args": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string"},
                "exposePorts": {"type": "array", "items": {"type": "integer"}, "description": "Sandbox ports to expose on the user's loopback; each must be authorized in the project permission."}
            }), &["program", "args", "cwd", "exposePorts"]),
        proc("job_status",
            "Report a background job's state (running, exited, stopped, failed, interrupted), exit code and exposed loopback URLs. `interrupted` means Nexus restarted and the job did not survive; it is never reported as running or completed.",
            serde_json::json!({"jobId": {"type": "string"}}), &["jobId"]),
        proc("job_logs",
            "Read the bounded tail of a background job's combined output.",
            serde_json::json!({"jobId": {"type": "string"}, "maxBytes": {"type": "integer"}}), &["jobId", "maxBytes"]),
        proc("job_stop",
            "Stop a background job and its whole process tree, removing any loopback exposure.",
            serde_json::json!({"jobId": {"type": "string"}}), &["jobId"]),
    ])
}

/// Frozen digest of the job-tool addition (any edit is a new version, never a silent change).
pub const JOB_TOOLS_V1_DIGEST: &str =
    "289b1d8fbd15dcce8f5461e7274a669d13e21956581db14988ea91b0646ad077";

pub fn job_tools_digest() -> String {
    let defs = job_tool_definitions();
    let arr: Vec<Value> = defs.as_array().cloned().unwrap_or_default();
    catalog_digest_of(&arr)
}

#[cfg(test)]
mod job_tools_tests {
    use super::*;

    #[test]
    fn the_job_tools_are_versioned_and_the_v1_catalogs_are_untouched() {
        assert_eq!(job_tools_digest(), JOB_TOOLS_V1_DIGEST);
        // the frozen V1 identities did not move when the job tools were added
        assert_eq!(
            frozen_catalog_digest(crate::request::ToolProfile::RepoCodeV1),
            REPO_CODE_V1_CATALOG_DIGEST
        );
        let defs = job_tool_definitions();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, JOB_TOOLS);
        // small and well-defined: every parameter is a plain scalar or list of scalars
        for d in defs.as_array().unwrap() {
            assert!(d["description"].as_str().unwrap().len() < 700);
        }
    }
}
