//! A scripted stand-in for `nexus-bridge`, used ONLY by `tests/bridge_link.rs` to exercise the
//! host's transport logic (handshake, reconnect, failure handling). It executes nothing: every
//! `call` is answered with an echo. It is not an engine and is never shipped.

use nexus_desktop_lib::bridge_proto::*;
use std::io::{BufRead, Write};

fn send(m: &ToHost) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{}", encode(m));
    let _ = o.flush();
}

fn main() {
    let env = |k: &str| std::env::var(k).ok();
    if env("MOCK_SILENT").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    if env("MOCK_EXIT_AT_START").is_some() {
        eprintln!("Permission denied (publickey).");
        std::process::exit(255);
    }
    send(&ToHost::Hello(Hello {
        proto: env("MOCK_PROTO")
            .and_then(|p| p.parse().ok())
            .unwrap_or(PROTO_VERSION),
        app_version: env("MOCK_VERSION").unwrap_or_else(|| "0.1.0".into()),
        client_api_version: 1,
        ipc_protocol: 1,
        sync: nexus_desktop_lib::sync::wire::SYNC_VERSION,
        uid: 1000,
        hostname: "mock".into(),
    }));
    let active: Option<u64> = env("MOCK_ACTIVE").and_then(|a| a.parse().ok());
    let mut waiting_confirm: Option<u64> = None;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(m) = serde_json::from_str::<ToGuest>(&line) else {
            break;
        };
        match m {
            ToGuest::Ping { n } => send(&ToHost::Pong {
                n,
                phase: "ready".into(),
                active_runs: active,
            }),
            ToGuest::Call { id, cmd, args } => match cmd.as_str() {
                "crash" => std::process::exit(3),
                "ask" => {
                    waiting_confirm = Some(id);
                    send(&ToHost::Confirm {
                        id,
                        title: "T".into(),
                        text: "May I?".into(),
                    });
                }
                _ => send(&ToHost::Ok {
                    id,
                    value: serde_json::json!({"cmd": cmd, "args": args}),
                }),
            },
            ToGuest::Sync { id, req } => send(&ToHost::Ok {
                id,
                value: serde_json::json!({"sync": serde_json::to_value(&req).unwrap_or_default()}),
            }),
            ToGuest::SecretReply { .. } => {}
            ToGuest::ConfirmReply { id, allowed, error } => {
                if waiting_confirm == Some(id) {
                    send(&ToHost::Ok {
                        id,
                        value: serde_json::json!({"allowed": allowed, "error": error}),
                    });
                }
            }
        }
    }
}
