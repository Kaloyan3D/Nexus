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
    /// Controller run directory (`<workspace>/.ai-harness/runs`): attempt journals.
    pub runs_dir: Option<PathBuf>,
    /// Historical DSH session log root (read-only).
    pub sessions_root: Option<PathBuf>,
    /// Native transcript store directory (backend-owned, append-only).
    pub transcript_dir: PathBuf,
}

fn data_home() -> Option<PathBuf> {
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.is_empty() {
            return Some(PathBuf::from(x));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".local").join("share"))
}

/// Default historical session root: `<data>/nexus/data/sessions`.
pub fn default_sessions_root() -> Option<PathBuf> {
    std::env::var("NEXUS_DSH_SESSIONS_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| data_home().map(|d| d.join("nexus").join("data").join("sessions")))
}

/// Default native transcript directory: `<data>/nexus/native/transcripts`.
pub fn default_transcript_dir() -> PathBuf {
    std::env::var("NEXUS_TRANSCRIPT_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| data_home().map(|d| d.join("nexus").join("native").join("transcripts")))
        .unwrap_or_else(|| PathBuf::from("/tmp/nexus-native-transcripts"))
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
        let runs_dir = std::env::var("NEXUS_RUNS_DIR")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                ledger_dir
                    .as_ref()
                    .and_then(|l| l.parent().map(|p| p.join("runs")))
            });
        Ok(Self {
            socket_path,
            ledger_dir,
            json,
            runs_dir,
            sessions_root: default_sessions_root(),
            transcript_dir: default_transcript_dir(),
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
