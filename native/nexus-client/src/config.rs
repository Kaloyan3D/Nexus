//! Client configuration resolution (A2.4 Phase 2).
//!
//! The client never holds daemon capabilities, issuance keys, or provider
//! credentials. It resolves only public paths: the daemon socket, the
//! Controller ledger, and display preferences. Socket permission policy
//! (A2.1 owner-only DataRoot, explicit --socket-group sharing) is reported
//! but never weakened here.

use crate::error::{ClientError, ExitCode};
use std::path::PathBuf;

/// Resolved client configuration (public paths only, no secrets).
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Daemon socket path (explicit --socket or well-known default).
    pub socket_path: PathBuf,
    /// Controller ledger directory (tasks.json + attempts.jsonl), if known.
    pub ledger_dir: Option<PathBuf>,
    /// JSON output flag.
    pub json: bool,
}

/// Well-known default socket path under the default DataRoot.
/// The daemon owns path selection; the client only mirrors the default.
pub fn default_socket_path() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".nexus").join("nexusd.sock");
        }
    }
    PathBuf::from("/tmp/nexus-nexusd.sock")
}

/// Well-known default ledger directory (repository-adjacent Controller state).
pub fn default_ledger_dir() -> Option<PathBuf> {
    std::env::var("NEXUS_LEDGER_DIR").ok().map(PathBuf::from)
}

impl ClientConfig {
    pub fn resolve(
        socket: Option<PathBuf>,
        ledger: Option<PathBuf>,
        json: bool,
    ) -> Result<Self, ClientError> {
        let socket_path = socket
            .or_else(|| std::env::var("NEXUS_SOCKET").ok().map(PathBuf::from))
            .unwrap_or_else(default_socket_path);
        if socket_path.as_os_str().is_empty() {
            return Err(ClientError::new(
                "bad-usage",
                ExitCode::Usage,
                "socket path must not be empty",
            ));
        }
        let ledger_dir = ledger.or_else(default_ledger_dir);
        Ok(Self {
            socket_path,
            ledger_dir,
            json,
        })
    }

    /// Redacted summary for `config show` (paths only, never secrets).
    pub fn summary_json(&self) -> serde_json::Value {
        serde_json::json!({
            "clientApiVersion": crate::version::CLIENT_API_VERSION,
            "ipcProtocol": crate::version::IPC_PROTOCOL_VERSION,
            "socketPath": self.socket_path.display().to_string(),
            "ledgerDir": self.ledger_dir.as_ref().map(|p| p.display().to_string()),
            "json": self.json,
            "dispatchEnabled": false,
            "liveReady": false,
        })
    }
}
