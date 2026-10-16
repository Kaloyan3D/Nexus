//! Example only (A5.3): how a Rust backend of ANOTHER application could use
//! Nexus through the `nexus` CLI. It is not an Arthur integration, adds no
//! SDK, and never touches an issuer capability or provider credential: it
//! only invokes `nexus intent ...` and parses the documented JSON envelope
//! (`schema: "nexus.intent.cli/v1"`).
//!
//! The "project" below is a hypothetical stand-in. The future
//! `ProjectHandoffV1` (see docs/ProjectHandoffV1.md) is NOT implemented and
//! Nexus rejects every intent type except `model-only`.
//!
//! Run (with a broker listening):
//!   NEXUS_BROKER_SOCKET=/run/nexus/broker.sock cargo run -p nexus-cli --example external_consumer

use std::io::Write;
use std::process::{Command, Stdio};

fn nexus(args: &[&str], stdin: Option<&str>) -> Result<(i32, serde_json::Value), String> {
    let bin = std::env::var("NEXUS_BIN").unwrap_or_else(|_| "nexus".to_owned());
    let mut child = Command::new(bin)
        .arg("--json")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start nexus: {e}"))?;
    if let (Some(text), Some(mut s)) = (stdin, child.stdin.take()) {
        s.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.trim().lines().last().ok_or("empty nexus output")?;
    let v: serde_json::Value = serde_json::from_str(last).map_err(|e| e.to_string())?;
    if v["schema"] != "nexus.intent.cli/v1" {
        return Err("unexpected schema".into());
    }
    Ok((out.status.code().unwrap_or(-1), v))
}

fn main() -> Result<(), String> {
    // A hypothetical structured project document, flattened by the CALLER
    // into bounded text. Nexus sees text only.
    let project = serde_json::json!({
        "name": "Example Notes App",
        "goals": ["capture ideas quickly", "link related ideas"],
        "constraints": ["offline first"],
    });
    let content = format!(
        "Outline an architecture for this project. Reply with modules and a roadmap.\n\n{}",
        serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?
    );
    // A STABLE key derived from the project version makes retries safe: the
    // same key + payload never creates a second billable attempt.
    let (code, v) = nexus(
        &[
            "intent",
            "submit",
            "--input",
            "-",
            "--wait",
            "--idempotency-key",
            "example-project-v1-0001",
        ],
        Some(&content),
    )?;
    if v["ok"] == true {
        println!("state:    {}", v["run"]["state"]);
        println!(
            "task:     {} / attempt {}",
            v["run"]["taskId"], v["run"]["attemptId"]
        );
        println!(
            "model:    {}/{}",
            v["run"]["providerId"], v["run"]["remoteModelId"]
        );
        println!("result:\n{}", v["text"].as_str().unwrap_or(""));
    } else {
        // error.class: usage | auth | rejected | transport | internal
        println!(
            "failed ({code}): {} [{}]",
            v["error"]["code"], v["error"]["class"]
        );
    }
    Ok(())
}
