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
}

impl BrokerConfig {
    pub fn bridge_path(&self) -> PathBuf {
        self.repo_root
            .join("config")
            .join("registry")
            .join("native-intent-bridge.cjs")
    }
}
