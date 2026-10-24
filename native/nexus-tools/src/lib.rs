//! Nexus Native Core A3.1 — secure, deterministic, read-only workspace tools.
//!
//! Trust boundary (see `native/A3.1-EVIDENCE.md`):
//!
//! ```text
//!  model / renderer JSON ──► prepare (typed, validated, digested; no content I/O)
//!        ──► Kernel::authorize_tool (sealed grant, journal `authorized`)
//!        ──► Kernel::begin_tool_execution (re-verify seal+lease+fence, journal `started`)
//!        ──► executor (descriptor-relative reads beneath the pinned root)
//!        ──► Kernel::complete_tool_execution (journal `completed`, redacted)
//! ```
//!
//! The executor never invents authority: it can only run a call whose grant
//! the Kernel signed, whose arguments and budgets hash to what was signed,
//! and whose workspace identity matches the sealed device/inode. There is
//! no shell, no subprocess, no write path and no network in this crate.

pub mod authorization;
pub mod contract;
pub mod depcache;
pub mod detect;
pub mod direct;
pub mod events;
pub mod exec;
pub mod exec_contract;
pub mod gitwt;
pub mod inplace;
pub mod list;
pub mod mutate;
pub mod offline;
pub mod process;
pub mod protect;
pub mod read;
pub mod redact;
pub mod registry;
pub mod result;
pub mod sandbox;
pub mod search;
pub mod snapshot;
pub mod stage;
pub mod workbench;
pub mod workspace;
pub mod write;

pub use authorization::{
    authorize, begin, execute, execute_process, execute_process_in, execute_write, finish, prepare,
    prepare_process, prepare_write, reconcile_processes, reconcile_writes, run_process_call,
    run_started, run_write_call, AuthorizedToolCall, PreparedToolRequest, StartedToolCall,
    ToolExecutionOutcome,
};
pub use contract::{
    descriptor_for, descriptors, ListArgs, ProcessArgs, ReadArgs, SearchArgs, ToolArgs,
    ToolBudgets, ToolDescriptor, ToolId, ToolRequestV1, TOOL_CONTRACT_VERSION, TOOL_VERSION,
};
pub use events::{
    fold_tool_records, record_from_entry, tool_events_from_journal, ToolEventStatus, ToolEventV1,
    ToolRecordV1,
};
pub use exec::{CancellationToken, ExecCtx};
pub use redact::{Redaction, Redactor};
pub use result::{ResultStatus, ToolError, ToolErrorCode, ToolResultV1, ToolStats, Truncation};
pub use workspace::{Workspace, WorkspacePolicy, POLICY_VERSION};
pub use write::{preview_write, unified_diff, WriteHooks, WritePreview};
