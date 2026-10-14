//! Nexus Native Client API v1 (A2.4 Phase 2).
//!
//! Versioned, scoped contract shared by the native CLI and the future GUI.
//! Read-only operations speak the authenticated daemon IPC; task metadata
//! comes from read-only ledger JSON; mock execution runs in an explicitly
//! isolated throwaway store. The client never opens SQLite, never holds
//! issuance keys or provider credentials, and never weakens the daemon
//! socket permissions. Live execution stays blocked.

pub mod api;
pub mod config;
pub mod conversation;
pub mod error;
pub mod mock;
pub mod streaming;
pub mod transport;
pub mod version;

pub use api::{
    attempt_status, cancel, digest, health, journal, journal_for_task, models, readiness, receipt,
    status, task_show, tasks, verify,
};
pub use config::{
    default_ledger_dir, default_sessions_root, default_socket_path, default_transcript_dir,
    ClientConfig,
};
pub use conversation::{
    conversation, list_mock_conversations, model_io, run_mock_recorded, ConversationView,
    MockConversationSummary, ModelIoView, NO_HISTORY_MESSAGE,
};
pub use error::{ClientError, ExitCode};
pub use mock::{
    live_blockers, run_mock, run_mock_streaming, MockCheck, MockProgress, MockRunReport,
    MockStreamItem,
};
pub use nexus_transcript as transcript;
pub use streaming::{poll_journal, ClientEvent};
pub use version::{CLIENT_API_VERSION, CLIENT_API_VERSION_STR, IPC_PROTOCOL_VERSION};
