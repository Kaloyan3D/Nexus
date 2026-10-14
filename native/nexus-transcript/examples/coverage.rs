//! Prints historical conversation coverage for every task instance found in a
//! runs directory. Usage: coverage <runs_dir> <sessions_root>
use nexus_transcript::*;
use std::collections::BTreeSet;
use std::fs;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = DshSources::new(a[1].as_str(), a[2].as_str());
    let mut ids = BTreeSet::new();
    for d in fs::read_dir(&src.runs_dir).unwrap().flatten() {
        if let Ok(raw) = fs::read_to_string(d.path().join("attempts.jsonl")) {
            for l in raw.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
                    if let Some(i) = v["taskInstanceId"].as_str() {
                        ids.insert(i.to_owned());
                    }
                }
            }
        }
    }
    let (mut with, mut without, mut refused) = (0, 0, 0);
    let (mut users, mut asst, mut tools, mut red, mut trunc, mut partial) =
        (0, 0, 0, 0u64, 0u64, 0);
    let t = std::time::Instant::now();
    for id in &ids {
        match read_history(&src, id) {
            Ok(h) => {
                if h.events.is_empty() {
                    without += 1;
                    if h.attempts.iter().any(|a| a.binding.starts_with("refused")) {
                        refused += 1;
                    }
                } else {
                    with += 1;
                }
                if with == 0 && without == 1 {
                    println!(
                        "sample refusal: {:?}",
                        h.attempts.first().map(|a| a.binding.clone())
                    );
                }
                red += h.coverage.redactions;
                trunc += h.coverage.truncated_fields;
                for e in &h.events {
                    match e.kind {
                        EventKind::UserMessage => users += 1,
                        EventKind::AssistantMessage => {
                            asst += 1;
                            if e.state != MessageState::Final {
                                partial += 1
                            }
                        }
                        EventKind::ToolCall | EventKind::ToolResult => tools += 1,
                        _ => {}
                    }
                }
            }
            Err(e) => {
                without += 1;
                eprintln!("{id}: {e}");
            }
        }
    }
    println!(
        "instances={} with_history={} without={} (refused={}) user_msgs={} assistant_msgs={} (non-final={}) tool_events={} redactions={} truncated_fields={} elapsed={:?}",
        ids.len(), with, without, refused, users, asst, partial, tools, red, trunc, t.elapsed()
    );
}
