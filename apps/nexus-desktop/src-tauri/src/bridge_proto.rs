//! Wire protocol between the macOS host and the Linux `nexus-bridge`, carried as one JSON
//! object per line over the stdio of an SSH session (see `docs/M2-TRANSPORT-SECURITY.md`).
//!
//! The protocol has no "run this" verb: the host can only ask the guest to execute a named,
//! already-registered Tauri command with JSON arguments, exactly what the renderer could ask
//! on Linux. The guest can only ask the host for a native confirmation.

use crate::dto::UiError;
use crate::sync::wire::{SyncReq, SYNC_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped on any incompatible change to the messages below.
pub const PROTO_VERSION: u32 = 2;
/// A single protocol line (a full conversation page fits well below this).
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// Dialog text shown to the person is bounded so a guest cannot flood a native alert.
pub const MAX_DIALOG_TITLE: usize = 200;
pub const MAX_DIALOG_TEXT: usize = 8_000;

/// Commands the bridge never executes, whatever the host sends: they are host-local (a Mac
/// folder is not a guest folder) or simulated.
pub const BRIDGE_REFUSES: &[&str] = &["project_pick", "run_mock"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ToGuest {
    /// Run one registered command. `args` is the object the renderer passed.
    Call {
        id: u64,
        cmd: String,
        args: Value,
    },
    /// One project-transfer operation (`sync::wire`). Confined by the guest to its staging root
    /// and to the project id the operation names; it is not a file or command API.
    Sync {
        id: u64,
        req: SyncReq,
    },
    /// The person's answer to a [`ToHost::Confirm`].
    ConfirmReply {
        id: u64,
        allowed: bool,
        /// Set when the Mac could not show the dialog at all. That is a failure, never a "no".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// What the person typed into the Mac's secure prompt for a [`ToHost::Secret`]; `None` = cancelled.
    /// The value travels only over this private channel and is never logged.
    SecretReply {
        id: u64,
        value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Ping {
        n: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ToHost {
    /// First line, once, after the guest bridge is up.
    Hello(Hello),
    Ok {
        id: u64,
        value: Value,
    },
    Err {
        id: u64,
        error: UiError,
    },
    /// The guest needs the person to confirm something in a native Mac dialog.
    Confirm {
        id: u64,
        title: String,
        text: String,
    },
    /// The guest needs a secret (an API key) typed by the person into a native, non-echoing Mac prompt.
    Secret {
        id: u64,
        title: String,
        prompt: String,
    },
    Pong {
        n: u64,
        /// The guest runtime's own phase (`starting` | `ready` | `error` | `stopped`).
        phase: String,
        /// Runs that have not ended, when the broker could be asked.
        active_runs: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub proto: u32,
    /// `CARGO_PKG_VERSION` of the guest build; the host requires the same value.
    pub app_version: String,
    pub client_api_version: u32,
    pub ipc_protocol: u32,
    /// Version of the project-transfer protocol the guest speaks.
    pub sync: u32,
    /// Numeric user the bridge (and so every broker call) runs as.
    pub uid: u32,
    pub hostname: String,
}

/// Compatibility verdict for a guest `Hello`; `Err` is shown to the person verbatim.
pub fn check_hello(h: &Hello, host_app_version: &str) -> Result<(), String> {
    if h.proto != PROTO_VERSION {
        return Err(format!(
            "the Linux engine speaks bridge protocol {}, this app speaks {PROTO_VERSION}: update the older side",
            h.proto
        ));
    }
    if h.sync != SYNC_VERSION {
        return Err(format!(
            "the Linux engine speaks project-transfer version {}, this app speaks {SYNC_VERSION}: update the older side",
            h.sync
        ));
    }
    if h.app_version != host_app_version {
        return Err(format!(
            "the Linux engine is Nexus {}, this app is {host_app_version}: build both from the same source",
            h.app_version
        ));
    }
    Ok(())
}

/// Encode one protocol line (without the trailing newline).
pub fn encode<T: Serialize>(m: &T) -> String {
    serde_json::to_string(m).unwrap_or_else(|_| "{}".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> Hello {
        Hello {
            proto: PROTO_VERSION,
            app_version: "0.1.0".into(),
            client_api_version: 1,
            ipc_protocol: 1,
            sync: SYNC_VERSION,
            uid: 1000,
            hostname: "kaloyan".into(),
        }
    }

    #[test]
    fn messages_round_trip_with_stable_tags() {
        let c = encode(&ToGuest::Call {
            id: 7,
            cmd: "thread_list".into(),
            args: serde_json::json!({"projectId": "p"}),
        });
        assert!(c.contains("\"t\":\"call\""));
        let back: ToGuest = serde_json::from_str(&c).unwrap();
        assert!(matches!(back, ToGuest::Call { id: 7, .. }));
        let p = encode(&ToHost::Pong {
            n: 1,
            phase: "ready".into(),
            active_runs: Some(2),
        });
        assert!(p.contains("\"t\":\"pong\""));
    }

    #[test]
    fn unknown_verbs_do_not_parse() {
        assert!(serde_json::from_str::<ToGuest>(r#"{"t":"exec","argv":["sh"]}"#).is_err());
        assert!(serde_json::from_str::<ToGuest>(r#"{"t":"shell","cmd":"id"}"#).is_err());
    }

    #[test]
    fn hello_compatibility() {
        assert!(check_hello(&hello(), "0.1.0").is_ok());
        let mut h = hello();
        h.proto = 99;
        assert!(check_hello(&h, "0.1.0").unwrap_err().contains("protocol"));
        assert!(check_hello(&hello(), "0.2.0")
            .unwrap_err()
            .contains("same source"));
    }

    #[test]
    fn secret_messages_round_trip_and_the_value_is_only_in_the_reply() {
        let ask = encode(&ToHost::Secret {
            id: 3,
            title: "T".into(),
            prompt: "Paste your key".into(),
        });
        assert!(ask.contains("\"t\":\"secret\""));
        let reply = encode(&ToGuest::SecretReply {
            id: 3,
            value: Some("k-123".into()),
            error: None,
        });
        let back: ToGuest = serde_json::from_str(&reply).unwrap();
        assert!(
            matches!(back, ToGuest::SecretReply { id: 3, value: Some(ref v), .. } if v == "k-123")
        );
        assert!(!ask.contains("k-123"));
    }
}
