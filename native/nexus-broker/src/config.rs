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

/// Limits an OPERATOR chose for repo-code runs (A6.1.3, `--code-cap-*`). The default is none: Nexus has no
/// built-in ceiling on turns, tool calls, edits, written bytes, commands or elapsed time. A cap exists only
/// because a person or operator asked for one (cost control); the broker applies it to every run, whatever
/// the client sent, and the user's own limits (Settings) can only tighten it further.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeCaps {
    pub max_turns: Option<u32>,
    pub max_tool_calls: Option<u32>,
    pub max_runtime_secs: Option<u64>,
}

/// File inside the broker state directory with the limits the USER chose in Settings (never required).
pub const USER_LIMITS_FILE: &str = "user-limits.json";

impl CodeCaps {
    /// These caps tightened by the user's own limits file, if any.
    pub fn with_user_limits(&self, state_dir: &std::path::Path) -> CodeCaps {
        let mut out = self.clone();
        let Some(v) = std::fs::read_to_string(state_dir.join(USER_LIMITS_FILE))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        else {
            return out;
        };
        let tighter = |cur: Option<u64>, key: &str| -> Option<u64> {
            match (cur, v.get(key).and_then(|x| x.as_u64()).filter(|n| *n >= 1)) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (None, b) => b,
                (a, None) => a,
            }
        };
        out.max_turns = tighter(self.max_turns.map(u64::from), "maxTurns")
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX));
        out.max_tool_calls = tighter(self.max_tool_calls.map(u64::from), "maxToolCalls")
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX));
        out.max_runtime_secs = tighter(self.max_runtime_secs, "maxRuntimeSecs");
        out
    }

    /// A cap must be a positive number; there is no maximum to stay under.
    pub fn validate(&self) -> Result<(), String> {
        let chk = |name: &str, v: Option<u64>| match v {
            Some(0) => Err(format!("{name} must be at least 1")),
            _ => Ok(()),
        };
        chk("turns", self.max_turns.map(u64::from))?;
        chk("tool calls", self.max_tool_calls.map(u64::from))?;
        chk("runtime seconds", self.max_runtime_secs)
    }

    /// The limits a run will actually get: exactly the caps, nothing more.
    pub fn effective(&self) -> nexus_client::intent_client::UserLimits {
        nexus_client::intent_client::UserLimits {
            max_turns: self.max_turns,
            max_tool_calls: self.max_tool_calls,
            max_runtime_secs: self.max_runtime_secs,
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
    /// A6.1.4 interactive profile: per-run provider authorization is issued by the
    /// broker from a one-time user consent instead of an operator-created record.
    pub interactive: bool,
    /// A6.1.4: directory for Nexus-owned project snapshots; enables opening projects
    /// from the Desktop (needs `project_registry` and the interactive profile).
    pub project_snapshots: Option<PathBuf>,
    /// A6.1.4: override of the conversation budget (bytes) before older steps are
    /// compacted. `None` = the built-in default. Tests and tuning only.
    pub context_budget_bytes: Option<usize>,
    /// EM-04A RequestBudgetV1: ceiling (bytes) of one serialized provider request, measured on
    /// the exact wire bytes. `None` (the default and every production configuration) = no
    /// request budget: requests are byte-identical to EM-03. Tests and the future mode-level
    /// activation (EM-04B) only.
    pub request_budget_bytes: Option<usize>,
    /// Verification Engine shadow evidence recorder. `true` in production; `false` only lets a
    /// differential test (or an operator) prove the recorder changes nothing.
    pub verification_shadow: bool,
    /// Verification feedback to the same model at the final-response boundary (Phase 05).
    /// `Observe` (the default) only records what would have been eligible; `Active` delivers it.
    /// Broker-owned: nothing the model, a tool or an Engineering Mode says can change it.
    pub verification_feedback: crate::verification::feedback::FeedbackPolicy,
}

impl BrokerConfig {
    /// The registry alone (permissions management needs no snapshots): interactive profile with a project
    /// registry. Never used to open or snapshot a folder.
    pub fn registry_env(&self) -> Option<crate::projects::Env<'_>> {
        let (dir, trust) = self.project_registry.as_ref()?;
        if !self.interactive {
            return None;
        }
        Some(crate::projects::Env {
            registry_dir: dir,
            trust,
            snapshots_dir: self.project_snapshots.as_deref().unwrap_or(&self.state_dir),
            forbidden: Vec::new(),
        })
    }

    /// Project onboarding environment, when this broker can open projects.
    pub fn project_env(&self) -> Option<crate::projects::Env<'_>> {
        let (dir, trust) = self.project_registry.as_ref()?;
        let snaps = self.project_snapshots.as_ref()?;
        if !self.interactive {
            return None;
        }
        let mut forbidden = vec![self.state_dir.clone(), snaps.clone()];
        forbidden.extend(
            [&self.registry_data_root, &self.transcript_dir, dir]
                .into_iter()
                .cloned(),
        );
        for f in forbidden.iter_mut() {
            if let Ok(c) = std::fs::canonicalize(&*f) {
                *f = c;
            }
        }
        Some(crate::projects::Env {
            registry_dir: dir,
            trust,
            snapshots_dir: snaps,
            forbidden,
        })
    }

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
