//! Structured, deterministic tool results and explicit error taxonomy.

use crate::redact::Redaction;
use nexus_contracts::{canonical_json, sha256_hex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolErrorCode {
    UnsupportedTool,
    InvalidArguments,
    PathInvalid,
    SymlinkRefused,
    SpecialFileRefused,
    HardlinkRefused,
    SensitivePathRefused,
    HiddenPathRefused,
    NotFound,
    NotADirectory,
    NotAFile,
    FileTooLarge,
    DirectoryTooLarge,
    BinaryFile,
    InvalidUtf8,
    MountCrossing,
    RaceDetected,
    WorkspaceInvalid,
    WorkspaceMismatch,
    /// The target differs from what the request expected (pre-image
    /// mismatch, already exists, ambiguous edit, concurrent change).
    Conflict,
    /// The write failed before publication; the target is unchanged.
    WriteFailed,
    /// The filesystem lacks an atomic primitive we require (renameat2).
    UnsupportedFilesystem,
    /// A mandatory sandbox primitive is unavailable: nothing was run.
    SandboxUnavailable,
    /// The workspace snapshot could not be staged safely.
    SnapshotFailed,
    /// Command refused by policy.
    CommandRefused,
    /// Bytes were published but could not be verified.
    PublishedUnverified,
    Cancelled,
    /// Authoritative revocation/fencing observed mid-execution.
    Revoked,
    AuthorizationRefused,
    IoError,
}

impl ToolErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedTool => "unsupported-tool",
            Self::InvalidArguments => "invalid-arguments",
            Self::PathInvalid => "path-invalid",
            Self::SymlinkRefused => "symlink-refused",
            Self::SpecialFileRefused => "special-file-refused",
            Self::HardlinkRefused => "hardlink-refused",
            Self::SensitivePathRefused => "sensitive-path-refused",
            Self::HiddenPathRefused => "hidden-path-refused",
            Self::NotFound => "not-found",
            Self::NotADirectory => "not-a-directory",
            Self::NotAFile => "not-a-file",
            Self::FileTooLarge => "file-too-large",
            Self::DirectoryTooLarge => "directory-too-large",
            Self::BinaryFile => "binary-file",
            Self::InvalidUtf8 => "invalid-utf8",
            Self::MountCrossing => "mount-crossing",
            Self::RaceDetected => "race-detected",
            Self::WorkspaceInvalid => "workspace-invalid",
            Self::WorkspaceMismatch => "workspace-mismatch",
            Self::Conflict => "conflict",
            Self::WriteFailed => "write-failed",
            Self::UnsupportedFilesystem => "unsupported-filesystem",
            Self::PublishedUnverified => "published-unverified",
            Self::SandboxUnavailable => "sandbox-unavailable",
            Self::SnapshotFailed => "snapshot-failed",
            Self::CommandRefused => "command-refused",
            Self::Cancelled => "cancelled",
            Self::Revoked => "revoked",
            Self::AuthorizationRefused => "authorization-refused",
            Self::IoError => "io-error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}
impl std::error::Error for ToolError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResultStatus {
    Ok,
    Truncated,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Truncation {
    pub truncated: bool,
    pub reasons: Vec<String>,
}

impl Truncation {
    pub fn add(&mut self, reason: &str) {
        self.truncated = true;
        if !self.reasons.iter().any(|r| r == reason) {
            self.reasons.push(reason.to_owned());
        }
    }
}

/// Deterministic counters (no wall-clock values).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStats {
    pub bytes_read: u64,
    pub files_scanned: u64,
    pub dirs_visited: u64,
    pub entries_returned: u64,
    pub matches_returned: u64,
    pub skipped_hidden: u64,
    pub skipped_sensitive: u64,
    pub skipped_ignored: u64,
    pub skipped_symlinks: u64,
    pub skipped_special: u64,
    pub skipped_hardlinks: u64,
    pub skipped_binary: u64,
    pub skipped_large: u64,
    pub skipped_invalid_utf8: u64,
    pub skipped_non_utf8_names: u64,
    pub skipped_mount_crossing: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultV1 {
    pub schema_version: u32,
    pub tool_id: String,
    pub tool_version: u32,
    pub status: ResultStatus,
    pub output: Option<serde_json::Value>,
    pub error: Option<ToolError>,
    pub truncation: Truncation,
    /// Explicit marker: content returned in `output` was redacted.
    #[serde(default)]
    pub redaction: Redaction,
    pub stats: ToolStats,
    /// sha256 of the canonical output (or of the error for failures).
    pub output_digest: String,
    pub output_bytes: u64,
}

impl ToolResultV1 {
    pub fn success(
        tool_id: &str,
        tool_version: u32,
        output: serde_json::Value,
        truncation: Truncation,
        redaction: Redaction,
        stats: ToolStats,
    ) -> Self {
        let canon = canonical_json(&output);
        Self {
            schema_version: 1,
            tool_id: tool_id.to_owned(),
            tool_version,
            status: if truncation.truncated {
                ResultStatus::Truncated
            } else {
                ResultStatus::Ok
            },
            output_bytes: canon.len() as u64,
            output_digest: sha256_hex(&canon),
            output: Some(output),
            error: None,
            truncation,
            redaction,
            stats,
        }
    }

    pub fn failure(tool_id: &str, tool_version: u32, error: ToolError, stats: ToolStats) -> Self {
        let canon = canonical_json(&serde_json::json!({
            "code": error.code.as_str(),
            "message": error.message,
        }));
        Self {
            schema_version: 1,
            tool_id: tool_id.to_owned(),
            tool_version,
            status: ResultStatus::Error,
            output: None,
            error: Some(error),
            truncation: Truncation::default(),
            redaction: Redaction::default(),
            stats,
            output_digest: sha256_hex(&canon),
            output_bytes: 0,
        }
    }
}
