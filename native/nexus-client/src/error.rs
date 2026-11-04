//! Typed, redacted client errors with deterministic CLI exit codes.

use nexus_model::redact;

/// Deterministic process exit codes for the native CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    Ok = 0,
    Usage = 2,
    Disconnected = 3,
    Unauthorized = 4,
    BlockedLive = 5,
    MockFailed = 6,
    Internal = 1,
}

/// Versioned client failure. Messages are redacted at construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub code: &'static str,
    pub message: String,
    pub exit: ExitCode,
    pub bytes_sent: bool,
}

impl ClientError {
    pub fn new(code: &'static str, exit: ExitCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: redact(&message.into()),
            exit,
            bytes_sent: false,
        }
    }
    pub fn disconnected(message: impl Into<String>) -> Self {
        Self::new("disconnected", ExitCode::Disconnected, message)
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new("unauthorized", ExitCode::Unauthorized, message)
    }
    pub fn blocked(message: impl Into<String>) -> Self {
        Self::new("live-blocked", ExitCode::BlockedLive, message)
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self::new("bad-usage", ExitCode::Usage, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", ExitCode::Internal, message)
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ClientError {}
