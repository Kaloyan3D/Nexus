//! The seam between the desktop shell and the Nexus engineering engine.
//!
//! The engine (kernel daemon, broker, sandbox) only runs on Linux. On Linux the shell reaches
//! it on the same machine; on macOS it is reached in a Linux guest through [`crate::bridge_link`].
//! A host asks an [`EngineLink`] for its [`EngineStatus`] and for every engine command either
//! gets the engine's real answer or a structured error that says why not. Nothing here
//! executes, simulates or pretends to be an engine; [`NoEngine`] is the safe fallback used
//! whenever no guest is configured.

use crate::dto::UiError;
use serde_json::Value;

/// Error code for "this platform has no engine configured".
pub const UNAVAILABLE_CODE: &str = "engine-unavailable";

/// Why there is no engine to talk to at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnavailableReason {
    /// No guest is configured (the macOS default).
    NoGuestConnected,
}

/// What a host can truthfully say about the engine right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineStatus {
    /// No guest configured; nothing is attempted.
    Unavailable(UnavailableReason),
    /// A guest is configured but there is no live connection; reconnection is automatic.
    Disconnected { detail: String },
    /// Establishing the connection or waiting for the guest's hello.
    Connecting,
    /// Connected, compatible, and the engine answers.
    Ready,
    /// Like `Ready`, with this many runs in flight in the engine.
    Busy { active_runs: u64 },
    /// Connected or reachable, but unusable (incompatible build, bridge failure).
    Error { detail: String },
}

impl EngineStatus {
    /// Commands reach the engine only in these states.
    pub fn is_ready(&self) -> bool {
        matches!(self, EngineStatus::Ready | EngineStatus::Busy { .. })
    }

    /// Stable machine-readable code, also used as the error code of refused calls.
    pub fn code(&self) -> &'static str {
        match self {
            EngineStatus::Unavailable(_) => UNAVAILABLE_CODE,
            EngineStatus::Disconnected { .. } => "engine-disconnected",
            EngineStatus::Connecting => "engine-connecting",
            EngineStatus::Ready | EngineStatus::Busy { .. } => "engine-ready",
            EngineStatus::Error { .. } => "engine-error",
        }
    }

    /// One plain sentence for the person, saying what is and is not the case.
    pub fn message(&self) -> String {
        const NOTHING: &str =
            "No task, command or model request was sent, and nothing was changed or granted.";
        match self {
            EngineStatus::Unavailable(UnavailableReason::NoGuestConnected) => format!(
                "The Nexus engineering engine runs on Linux and is not connected to this Mac. {NOTHING}"
            ),
            EngineStatus::Disconnected { detail } => format!(
                "The Linux engine is not reachable ({detail}). Nexus keeps trying to reconnect. {NOTHING}"
            ),
            EngineStatus::Connecting => format!("Connecting to the Linux engine… {NOTHING}"),
            EngineStatus::Ready => "The Linux engine is connected.".to_owned(),
            EngineStatus::Busy { active_runs } => {
                format!("The Linux engine is connected and running {active_runs} task(s).")
            }
            EngineStatus::Error { detail } => {
                format!("The Linux engine cannot be used: {detail}. {NOTHING}")
            }
        }
    }

    /// The error every engine-backed command returns while the engine cannot take it.
    pub fn unavailable_error(&self) -> UiError {
        UiError {
            code: self.code().to_owned(),
            message: self.message(),
        }
    }
}

/// Facts for the Settings page's diagnostics (never contains a secret or a key path's content).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EngineDiagnostics {
    pub lines: Vec<String>,
}

/// How a host reaches the engine.
pub trait EngineLink: Send + Sync {
    fn status(&self) -> EngineStatus;

    /// Run one registered command in the engine. The default (no engine) always refuses with
    /// the status error; nothing is executed.
    fn call(&self, _cmd: &str, _args: Value) -> Result<Value, UiError> {
        Err(self.status().unavailable_error())
    }

    /// One project-transfer operation. Same refusal rules as [`EngineLink::call`].
    fn sync(&self, _req: crate::sync::wire::SyncReq) -> Result<Value, UiError> {
        Err(self.status().unavailable_error())
    }

    fn diagnostics(&self) -> EngineDiagnostics {
        EngineDiagnostics::default()
    }

    /// Reconnect now instead of waiting for the next retry.
    fn reconnect(&self) {}

    /// Stop background work and close the connection. Idempotent.
    fn shutdown(&self) {}
}

/// No engine is connected and none is started. Starts no process, opens no socket.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoEngine;

impl EngineLink for NoEngine {
    fn status(&self) -> EngineStatus {
        EngineStatus::Unavailable(UnavailableReason::NoGuestConnected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_engine_is_never_ready_and_reports_a_stable_code() {
        let s = NoEngine.status();
        assert!(!s.is_ready());
        let e = s.unavailable_error();
        assert_eq!(e.code, "engine-unavailable");
        assert!(e.message.contains("not connected"));
        assert!(e.message.contains("nothing"));
        let c = NoEngine.call("thread_send", serde_json::json!({}));
        assert_eq!(c.unwrap_err().code, "engine-unavailable");
    }

    #[test]
    fn only_ready_and_busy_take_commands() {
        assert!(EngineStatus::Ready.is_ready());
        assert!(EngineStatus::Busy { active_runs: 1 }.is_ready());
        for s in [
            EngineStatus::Connecting,
            EngineStatus::Disconnected { detail: "x".into() },
            EngineStatus::Error { detail: "x".into() },
        ] {
            assert!(!s.is_ready());
            assert_ne!(s.unavailable_error().code, "engine-ready");
        }
    }
}
