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
pub mod desktop_contract;
pub mod error;
pub mod intent_client;
pub use nexus_contracts::intent as intent_contract;
pub mod issuer;
pub mod mock;
pub mod model_run;
pub mod streaming;
pub mod transport;
pub mod version;

pub use api::{
    approvals, attempt_status, cancel, digest, health, integrity, journal, journal_for_task,
    models, readiness, receipt, status, task_show, tasks, tool_events, tool_events_folded,
    tool_events_for_task, verify, ApprovalRecord, ApprovalsView, AttemptToolEvents, IntegrityView,
    JournalIntegrityView, TaskToolEvents, ToolRecordsPage,
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
pub use model_run::{
    list_model_conversations, prepare_model_run, recover_model_run, request_model_cancel,
    run_model_only, status_from_store as model_run_status, ExpectedTarget,
    ModelConversationSummary, ModelRunOptions, ModelRunOutcome, ModelRunRequest, ModelRunState,
    ModelRunStatus, ModelRunUpdate, PreparedModelRun, TransportFactory, MAX_PROMPT_BYTES,
    MODEL_CONVERSATION_PREFIX,
};
pub use nexus_model::TransportLimits;
pub use nexus_tools::{ToolEventStatus, ToolEventV1, ToolRecordV1};
pub use nexus_transcript as transcript;
pub use streaming::{poll_journal, ClientEvent};
pub use version::{CLIENT_API_VERSION, CLIENT_API_VERSION_STR, IPC_PROTOCOL_VERSION};
