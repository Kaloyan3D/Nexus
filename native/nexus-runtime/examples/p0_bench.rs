//! P0 DSH-vs-Native benchmark driver (diagnostic, not part of the product).
//!
//! Drives an ISOLATED interactive runtime (`NEXUS_HOME`, binaries from `NEXUS_BIN_DIR`,
//! Registry scripts from `NEXUS_REPO_ROOT`) exactly as the Desktop does: the supervisor
//! starts `nexusd` + `nexus-broker`, a project is opened, a conversation message starts a
//! repo-code run, the run is followed to its terminal state.
//!
//!   p0_bench start | stop | status
//!   p0_bench open <project-dir>                     -> prints the project id
//!   p0_bench send <project-id> <thread-id|-> <prompt-file> <key>
//!                                                    -> waits; prints one JSON summary line

use nexus_client::intent_client as ic;
use nexus_runtime::{Home, Tools};
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let home = Home::resolve().expect("home");
    let sock = home.broker_socket();
    match a.get(1).map(String::as_str) {
        Some("start") => {
            let tools = Tools::discover().expect("tools");
            eprintln!("tools: {tools:?}");
            let st = nexus_runtime::start(&home, &tools).expect("start");
            println!("{}", serde_json::to_string(&st).unwrap());
        }
        Some("stop") => nexus_runtime::stop(&home).expect("stop"),
        Some("status") => {
            println!(
                "{}",
                serde_json::to_string(&nexus_runtime::status(&home)).unwrap()
            )
        }
        Some("open") => {
            let v = ic::project_open(&sock, &a[2]).expect("project-open");
            println!("{}", v["project"]["id"].as_str().unwrap_or("?"));
        }
        Some("send") => {
            let prompt = std::fs::read_to_string(&a[4]).expect("prompt file");
            let thread = (a[3] != "-").then(|| a[3].as_str());
            let s = ic::thread_send(
                &sock,
                &ic::ThreadSend {
                    thread_id: thread,
                    project_id: &a[2],
                    content: prompt.trim(),
                    mode: "edit",
                    workspace: "continue",
                    idempotency_key: &a[5],
                    model: None,
                    route: None,
                },
            )
            .expect("thread-send");
            let tid = s["threadId"].as_str().unwrap_or("").to_owned();
            let rid = s["run"]["runId"].as_str().expect("run id").to_owned();
            let started = Instant::now();
            let run = loop {
                let r = ic::status(&sock, &rid).expect("status");
                if r.terminal {
                    break r;
                }
                if started.elapsed() > Duration::from_secs(4 * 3600) {
                    panic!("run {rid} did not finish in 4 h");
                }
                std::thread::sleep(Duration::from_secs(2));
            };
            let v = serde_json::to_value(&run).unwrap();
            let pick = |k: &str| v.get(k).cloned().unwrap_or(serde_json::Value::Null);
            println!(
                "{}",
                serde_json::json!({
                    "threadId": tid, "runId": rid, "wallSecs": started.elapsed().as_secs(),
                    "state": pick("state"), "completion": pick("completion"),
                    "errorCode": pick("errorCode"), "turn": pick("turn"),
                    "toolCalls": pick("toolCalls"), "recoveries": pick("recoveries"),
                    "lastRecovery": pick("lastRecovery"),
                    "editsUsed": pick("editsUsed"), "testsUsed": pick("testsUsed"),
                    "lastTestVerification": pick("lastTestVerification"),
                    "unresolvedFailedChecks": pick("unresolvedFailedChecks"),
                    "usageIn": pick("usageInputTokens"), "usageOut": pick("usageOutputTokens"),
                    "contextCompactions": pick("contextCompactions"),
                    "changedFiles": v["changedFiles"].as_array().map(|a| a.len()),
                    "conversationId": pick("conversationId"),
                })
            );
        }
        _ => eprintln!("usage: p0_bench start|stop|status|open|send ..."),
    }
}
