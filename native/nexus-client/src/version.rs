//! Client API version contract (A2.4 Phase 2).

/// Client API major version consumed by both CLI and future GUI.
pub const CLIENT_API_VERSION: u32 = 1;
/// Human-readable version string.
pub const CLIENT_API_VERSION_STR: &str = "1";
/// Daemon IPC protocol version this client speaks (exactly, never negotiated down).
pub const IPC_PROTOCOL_VERSION: u32 = 1;
