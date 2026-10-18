//! Broker configuration (paths and limits only; never secret values).

use nexus_client::{TransportFactory, TransportLimits};
use std::path::PathBuf;

/// An operator-approved, read-only repository workspace (A5.5). The client
/// only ever names the `id`; the path never crosses the client protocol.
#[derive(Clone, Debug)]
pub struct WorkspaceSpec {
    pub id: String,
    /// Canonical absolute root (validated at broker start).
    pub root: PathBuf,
    /// Peer UIDs allowed to select it. Empty = every UID the broker allows.
    pub allowed_uids: Vec<u32>,
    /// repo-code only (A6.1): the exact 40-hex commit the source must be at.
    /// The daemon refuses to hand out a working copy of any other commit.
    pub pinned_commit: Option<String>,
    /// repo-code only (A6.1): path prefixes (`dir/`) or exact files the model may
    /// propose writes to. Empty = whole project. Enforced before any approval.
    pub write_allow: Vec<String>,
}

/// Operator-selected LOWER bounds for repo-code runs (A6.1.3). Each cap can only
/// tighten the fixed Desktop maximums (12 turns, 30 tool calls, 5 edits,
/// 5 commands, 30 minutes); `validate` refuses anything that would raise one.
/// The cap is applied by the broker to every run, whatever the client sent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeCaps {
    pub max_turns: Option<u32>,
    pub max_tool_calls: Option<u32>,
    pub max_edits: Option<u32>,
    pub max_tests: Option<u32>,
    pub max_runtime_secs: Option<u64>,
}

impl CodeCaps {
    pub fn validate(&self) -> Result<(), String> {
        use nexus_client::intent_client::DESKTOP_CODE_LIMITS as M;
        let chk = |name: &str, v: Option<u64>, max: u64| match v {
            Some(0) => Err(format!("{name} must be at least 1")),
            Some(n) if n > max => Err(format!(
                "{name} {n} exceeds the fixed maximum {max}; operators can only lower limits"
            )),
            _ => Ok(()),
        };
        chk("turns", self.max_turns.map(u64::from), M.max_turns.into())?;
        chk(
            "tool calls",
            self.max_tool_calls.map(u64::from),
            M.max_tool_calls.into(),
        )?;
        chk("edits", self.max_edits.map(u64::from), M.max_edits.into())?;
        chk(
            "commands",
            self.max_tests.map(u64::from),
            M.max_tests.into(),
        )?;
        chk("runtime seconds", self.max_runtime_secs, M.max_runtime_secs)
    }

    /// The limits a run will actually get: the fixed maximums lowered by the caps.
    pub fn effective(&self) -> nexus_client::intent_client::DesktopCodeLimits {
        use nexus_client::intent_client::DESKTOP_CODE_LIMITS as M;
        nexus_client::intent_client::DesktopCodeLimits {
            max_turns: self.max_turns.map_or(M.max_turns, |c| c.min(M.max_turns)),
            max_tool_calls: self
                .max_tool_calls
                .map_or(M.max_tool_calls, |c| c.min(M.max_tool_calls)),
            max_edits: self.max_edits.map_or(M.max_edits, |c| c.min(M.max_edits)),
            max_tests: self.max_tests.map_or(M.max_tests, |c| c.min(M.max_tests)),
            max_runtime_secs: self
                .max_runtime_secs
                .map_or(M.max_runtime_secs, |c| c.min(M.max_runtime_secs)),
            ..M
        }
    }
}

#[derive(Clone)]
pub struct BrokerConfig {
    /// Durable broker state (0700): run records, idempotency index, lock.
    pub state_dir: PathBuf,
    /// Client-facing socket.
    pub socket_path: PathBuf,
    /// Optional group that may connect (socket mode 0660); otherwise 0600.
    pub socket_group: Option<u32>,
    /// Peer UIDs allowed to use the broker. Empty means "only my own euid".
    pub allowed_uids: Vec<u32>,
    pub daemon_socket: PathBuf,
    /// Issuer capability file. Read by this process only.
    pub cap_path: PathBuf,
    /// Protected provider credential file. Read by this process only.
    pub credentials_path: PathBuf,
    pub transcript_dir: PathBuf,
    /// Repository root holding `config/registry/native-intent-bridge.cjs`.
    pub repo_root: PathBuf,
    /// Registry data root (the real Registry configuration).
    pub registry_data_root: PathBuf,
    /// Dedicated intent ledger workspace (never a real Controller ledger).
    pub ledger_workspace: PathBuf,
    pub node: String,
    /// Extra owner UIDs accepted by the code-trust checks (empty in
    /// production). Only the `test-fixtures` binary can set it; it exists for
    /// user namespaces where host root appears as the overflow uid.
    pub extra_trusted_owner_uids: Vec<u32>,
    /// Maximum simultaneously active (non-terminal) runs.
    pub max_active: usize,
    /// Maximum submissions per client per rolling minute.
    pub rate_per_minute: usize,
    pub limits: TransportLimits,
    /// Optional extra allowlist of `provider/model`. Empty = whatever the
    /// Registry issues. A non-empty list can only NARROW the Registry.
    pub allow_models: Vec<(String, String)>,
    /// Test seam only (offline TLS fixtures). Always `None` in the binary.
    pub transport: Option<TransportFactory>,
    /// Operator-approved repo-inspect workspaces (A5.5). Empty = repo-inspect
    /// is unavailable.
    pub workspaces: Vec<WorkspaceSpec>,
    /// Operator-approved CODING sources (A5.6): repositories the agent may
    /// work on, always through an isolated working copy and never in place.
    /// Distinct from `workspaces`: inspect rights never imply code rights.
    pub code_sources: Vec<WorkspaceSpec>,
    /// How long an approval request stays decidable (A6.1.1). `None` = the
    /// 5-minute default, which is also the maximum: this can only be SHORTENED.
    pub approval_ttl_ms: Option<i64>,
    /// A6.1.3: operator project registry (directory + trusted owner uids). The
    /// broker only READS it, afresh for every listing and every new run, so an
    /// operator change reaches new runs without a restart while a run that has
    /// already started keeps the identity, pin and write scope it started with.
    /// Mutually exclusive with `code_sources` (a registry-managed daemon refuses
    /// caller-supplied paths).
    pub project_registry: Option<(PathBuf, nexus_tools::registry::Trust)>,
    /// A6.1.3: operator-selected lower limits for repo-code runs.
    pub code_caps: CodeCaps,
}

impl BrokerConfig {
    /// The coding sources usable right now: the static single-source list or the
    /// registry's projects. An unreadable/untrusted registry yields none (fail closed).
    pub fn effective_code_sources(&self) -> Vec<WorkspaceSpec> {
        let mut out = self.code_sources.clone();
        if let Some((dir, trust)) = &self.project_registry {
            match nexus_tools::registry::load(dir, trust) {
                Ok(f) => {
                    for p in f.projects {
                        if out.iter().any(|w| w.id == p.id) {
                            continue;
                        }
                        out.push(WorkspaceSpec {
                            id: p.id,
                            root: PathBuf::from(p.source_path),
                            allowed_uids: p.allowed_uids,
                            pinned_commit: Some(p.pinned_commit),
                            write_allow: p.write_allow,
                        });
                    }
                }
                Err(e) => eprintln!("nexus-broker: project registry refused: {e}"),
            }
        }
        out
    }

    pub fn bridge_path(&self) -> PathBuf {
        self.repo_root
            .join("config")
            .join("registry")
            .join("native-intent-bridge.cjs")
    }
}
