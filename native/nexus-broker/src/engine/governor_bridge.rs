//! EM-04A: the bounded bridge to the historical Muse Reasoning Governor.
//!
//! The validated DSH policy (`config/Muse-Reasoning{Governor,Runtime,Activity}.cjs`) is reused,
//! not rewritten: the three sources are embedded in the broker byte for byte at build time and
//! evaluated by a short-lived `node` process running `muse_bridge.cjs`, which replaces their only
//! DSH hooks (filesystem, routing-state path, clock) with in-memory Native adapters.
//!
//! The bridge is a PURE FUNCTION from the engine's point of view: JSON in (the engine's own
//! versioned Muse blocks, the trusted observations to fold, the task binding's authorized levels),
//! JSON out (the new blocks and the decision). It holds no handle, reads no file, opens no socket
//! and has no environment (`env_clear`); its input and output are bounded and it is killed after
//! `BRIDGE_TIMEOUT`. A failure is an `Err`, never a guess.
//!
//! Engines receive it as a capability ([`GovernorEvaluator`] in [`super::EngineEnv`]) so the
//! extension boundary stays free of paths and processes, and tests can substitute it.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The historical sources, exactly as committed in `config/` (checked by a test against the
/// files on disk, so an edit to either side is noticed).
pub const GOVERNOR_SOURCE: &str = include_str!("../../../../config/Muse-ReasoningGovernor.cjs");
pub const RUNTIME_SOURCE: &str = include_str!("../../../../config/Muse-ReasoningRuntime.cjs");
pub const ACTIVITY_SOURCE: &str = include_str!("../../../../config/Muse-ReasoningActivity.cjs");
/// EM-04B: the historical model-facing signal path (`applyReasoningSignal`).
pub const SIGNALS_SOURCE: &str = include_str!("../../../../config/Muse-ReasoningSignals.cjs");
/// The Native adapter script.
pub const BRIDGE_SOURCE: &str = include_str!("muse_bridge.cjs");

/// A bridge evaluation never takes longer than this (it is killed and reported as an error).
pub const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest bridge answer read (the Muse blocks are a few KB).
pub const MAX_BRIDGE_OUTPUT: usize = 256 * 1024;
/// Largest request sent to the bridge (sources ~66 KB + state).
pub const MAX_BRIDGE_INPUT: usize = 1024 * 1024;

/// SHA-256 of the embedded sources, recorded with every decision as its evidence.
pub fn sources_digest() -> String {
    nexus_contracts::sha256_hex(&format!(
        "{}\n{}\n{}\n{}\n{}",
        nexus_contracts::sha256_hex(GOVERNOR_SOURCE),
        nexus_contracts::sha256_hex(RUNTIME_SOURCE),
        nexus_contracts::sha256_hex(ACTIVITY_SOURCE),
        nexus_contracts::sha256_hex(SIGNALS_SOURCE),
        nexus_contracts::sha256_hex(BRIDGE_SOURCE),
    ))
}

/// An evaluator of the historical Muse policy: `op` + `args` in, the bridge's `result` out.
pub trait GovernorEvaluator: Send + Sync {
    fn call(&self, op: &str, args: &serde_json::Value) -> Result<serde_json::Value, BridgeError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

fn berr(code: &str, message: impl Into<String>) -> BridgeError {
    BridgeError {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// The production evaluator: `node -e <bridge>` with the request on stdin.
pub struct NodeGovernorBridge {
    node: PathBuf,
}

impl NodeGovernorBridge {
    pub fn new(node: PathBuf) -> Self {
        Self { node }
    }
}

impl GovernorEvaluator for NodeGovernorBridge {
    fn call(&self, op: &str, args: &serde_json::Value) -> Result<serde_json::Value, BridgeError> {
        let input = serde_json::json!({
            "sources": {
                "governor": GOVERNOR_SOURCE,
                "runtime": RUNTIME_SOURCE,
                "activity": ACTIVITY_SOURCE,
                "signals": SIGNALS_SOURCE,
            },
            "op": op,
            "args": args,
        })
        .to_string();
        if input.len() > MAX_BRIDGE_INPUT {
            return Err(berr(
                "bridge-input-too-large",
                "bridge input exceeds its bound",
            ));
        }
        let mut child = Command::new(&self.node)
            .arg("-e")
            .arg(BRIDGE_SOURCE)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| berr("bridge-unavailable", format!("cannot start node: {e}")))?;
        let mut stdin = child.stdin.take();
        let writer = std::thread::spawn(move || {
            if let Some(s) = stdin.as_mut() {
                let _ = s.write_all(input.as_bytes());
            }
        });
        let mut so = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(s) = so.as_mut() {
                let _ = s.take(MAX_BRIDGE_OUTPUT as u64 + 1).read_to_end(&mut out);
            }
            out
        });
        let deadline = Instant::now() + BRIDGE_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(2)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let _ = writer.join();
        let out = reader.join().unwrap_or_default();
        let Some(status) = status else {
            return Err(berr(
                "bridge-timeout",
                "the Governor bridge did not answer in time",
            ));
        };
        if !status.success() {
            return Err(berr(
                "bridge-failed",
                "the Governor bridge exited with an error",
            ));
        }
        if out.len() > MAX_BRIDGE_OUTPUT {
            return Err(berr(
                "bridge-output-too-large",
                "bridge output exceeds its bound",
            ));
        }
        let v: serde_json::Value = serde_json::from_slice(&out)
            .map_err(|_| berr("bridge-output-invalid", "bridge output is not JSON"))?;
        if v["ok"] != true {
            return Err(berr(
                v["code"].as_str().unwrap_or("bridge-error"),
                v["message"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect::<String>(),
            ));
        }
        Ok(v["result"].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> Option<PathBuf> {
        let out = Command::new("node").arg("--version").output().ok()?;
        out.status.success().then(|| PathBuf::from("node"))
    }

    fn repo_file(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../config")
            .join(name);
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn the_embedded_sources_are_the_historical_files_byte_for_byte() {
        assert_eq!(GOVERNOR_SOURCE, repo_file("Muse-ReasoningGovernor.cjs"));
        assert_eq!(RUNTIME_SOURCE, repo_file("Muse-ReasoningRuntime.cjs"));
        assert_eq!(ACTIVITY_SOURCE, repo_file("Muse-ReasoningActivity.cjs"));
        assert_eq!(SIGNALS_SOURCE, repo_file("Muse-ReasoningSignals.cjs"));
        assert_eq!(sources_digest().len(), 64);
    }

    #[test]
    fn the_bridge_exposes_the_historical_ladder_unchanged() {
        let Some(n) = node() else { return };
        let r = NodeGovernorBridge::new(n)
            .call("ladder", &serde_json::json!({}))
            .unwrap();
        assert_eq!(
            r["efforts"],
            serde_json::json!(["medium", "high", "xhigh", "max"])
        );
        assert_eq!(
            r["phases"],
            serde_json::json!([
                "discover",
                "diagnose",
                "design",
                "implement",
                "verify",
                "recover",
                "review"
            ])
        );
    }

    #[test]
    fn a_fresh_state_resolves_the_discover_default_and_never_touches_the_filesystem() {
        let Some(n) = node() else { return };
        let r = NodeGovernorBridge::new(n)
            .call(
                "evaluate",
                &serde_json::json!({
                    "museReasoning": null, "museActivity": null, "events": [],
                    "capabilities": ["low", "medium", "high", "xhigh"], "resolve": true,
                }),
            )
            .unwrap();
        assert_eq!(r["decision"]["outcome"], "resolved");
        assert_eq!(r["decision"]["effort"], "medium");
        assert_eq!(r["decision"]["reason"], "phase-default");
        assert_eq!(r["museReasoning"]["phase"], "discover");
        assert_eq!(r["museReasoning"]["currentEffort"], "medium");
        // the fixed clock: decision evidence is deterministic
        assert_eq!(
            r["museReasoning"]["lastResolution"]["atUtc"],
            "1970-01-01T00:00:00.000Z"
        );
        assert!(!std::path::Path::new("/nexus-native-virtual").exists());
    }

    #[test]
    fn unknown_capabilities_fail_closed_and_leave_the_state_unchanged() {
        let Some(n) = node() else { return };
        let r = NodeGovernorBridge::new(n)
            .call(
                "evaluate",
                &serde_json::json!({
                    "museReasoning": null, "museActivity": null, "events": [],
                    "capabilities": ["low"], "resolve": true,
                }),
            )
            .unwrap();
        assert_eq!(r["decision"]["outcome"], "capability-unavailable");
        assert_eq!(
            r["decision"]["code"],
            "nexus-muse-reasoning-capability-unavailable"
        );
        assert_eq!(r["decision"]["requested"], "medium");
        assert!(
            r["museReasoning"].is_null(),
            "a refused resolution writes nothing"
        );
    }

    #[test]
    fn corrupt_state_and_unknown_events_are_refused() {
        let Some(n) = node() else { return };
        let b = NodeGovernorBridge::new(n);
        let e = b
            .call(
                "evaluate",
                &serde_json::json!({
                    "museReasoning": {"phase": "hacking", "rootCauseEstablished": false},
                    "museActivity": null, "events": [], "capabilities": ["medium"], "resolve": true,
                }),
            )
            .unwrap_err();
        assert_eq!(e.code, "state-invalid");
        let e = b
            .call(
                "evaluate",
                &serde_json::json!({"events": [{"type": "effort", "value": "max"}], "resolve": true}),
            )
            .unwrap_err();
        assert_eq!(e.code, "event-invalid");
        let e = b
            .call(
                "evaluate",
                &serde_json::json!({
                    "museActivity": {"schemaVersion": 9}, "events": [], "capabilities": ["medium"],
                    "resolve": true,
                }),
            )
            .unwrap_err();
        assert_eq!(e.code, "state-invalid");
    }

    #[test]
    fn the_bridge_refuses_any_dependency_outside_the_traced_set() {
        let Some(n) = node() else { return };
        for module in [
            "node:child_process",
            "node:net",
            "./Engineering-Profiles.cjs",
            "fs",
        ] {
            let input = serde_json::json!({
                "sources": {
                    "governor": format!("require({module:?}); module.exports = {{}};"),
                    "runtime": "", "activity": "",
                },
                "op": "ladder", "args": {},
            });
            let mut child = Command::new(&n)
                .arg("-e")
                .arg(BRIDGE_SOURCE)
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.to_string().as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(v["ok"], false, "{module}");
            assert_eq!(v["code"], "require-refused", "{module}: {v}");
        }
    }

    #[test]
    fn a_missing_node_is_an_error_not_a_guess() {
        let e = NodeGovernorBridge::new(PathBuf::from("/nonexistent/node"))
            .call("ladder", &serde_json::json!({}))
            .unwrap_err();
        assert_eq!(e.code, "bridge-unavailable");
    }
}
