//! `nexusd`: persistent Nexus Native Kernel daemon (A1.3, shadow-only).
//!
//! One daemon owns one DataRoot: it hosts a single persistent [`Kernel`]
//! instance and exposes a versioned Unix-socket IPC surface. There is no
//! model runtime, no tool runtime, no dispatch, no network, and no exec
//! capability anywhere in this crate.

pub mod auth;
pub mod protocol;
pub mod server;

pub use auth::IssuerAuth;
pub use protocol::IPC_PROTOCOL_VERSION;
pub use server::{Daemon, Lifecycle, TrustMode};

use std::path::{Path, PathBuf};

/// Directory layout owned by one daemon incarnation, derived from `--db`:
/// `<db-parent>/daemon.lock` (exclusive lifetime lock),
/// `<db-parent>/nexus.sock` (default socket), `<db-parent>/issuer.cap`
/// (default capability path in shadow-test mode).
#[derive(Debug, Clone)]
pub struct DaemonLayout {
    pub db: PathBuf,
    pub witness: Option<PathBuf>,
    pub dir: PathBuf,
    pub daemon_lock: PathBuf,
    pub socket: PathBuf,
    pub cap: PathBuf,
}

impl DaemonLayout {
    pub fn derive(
        db: &Path,
        witness: Option<&Path>,
        socket: Option<&Path>,
        cap: Option<&Path>,
    ) -> Self {
        let dir = match db.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };
        Self {
            db: db.to_path_buf(),
            witness: witness.map(|p| p.to_path_buf()),
            dir: dir.clone(),
            daemon_lock: dir.join("daemon.lock"),
            socket: socket
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| dir.join("nexus.sock")),
            cap: cap
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| dir.join("issuer.cap")),
        }
    }
}

/// Single source of truth for the daemon-owned-store guard lives in
/// `nexus_kernel` (this crate depends on it, never the reverse): re-export
/// here so daemon code and tests share the exact same check as the CLI.
pub use nexus_kernel::{daemon_lock_path_for, ensure_no_live_daemon};
