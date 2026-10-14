//! Real-data audit against the live Controller ledger and DSH session store.
//! Ignored by default (machine-specific). Run:
//!   NEXUS_LEDGER_DIR=<repo>/.ai-harness/state cargo test -p nexus-client \
//!     --test real_history -- --ignored --nocapture

use nexus_client::transcript::{EventKind, InputClass, PageSpec, Speaker};
use nexus_client::*;
use std::collections::{BTreeSet, HashSet};
use std::time::Instant;

fn cfg() -> ClientConfig {
    ClientConfig::resolve(Some("/nonexistent.sock".into()), None, false).unwrap()
}
fn spec(limit: u32) -> PageSpec {
    PageSpec {
        limit,
        ..Default::default()
    }
}

fn instance_ids(c: &ClientConfig) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for d in std::fs::read_dir(c.runs_dir.as_ref().unwrap())
        .unwrap()
        .flatten()
    {
        if let Ok(raw) = std::fs::read_to_string(d.path().join("attempts.jsonl")) {
            for l in raw.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
                    if let Some(i) = v["taskInstanceId"].as_str() {
                        ids.insert(i.to_owned());
                    }
                }
            }
        }
    }
    ids
}

#[test]
#[ignore]
fn real_ledger_integrity_isolation_and_limits() {
    let c = cfg();
    let ids = instance_ids(&c);
    assert_eq!(ids.len(), 59, "expected 59 task instances with attempts");

    let (mut with, mut without) = (0, 0);
    let (mut attempts, mut verified) = (0, 0);
    let mut refused: Vec<String> = Vec::new();
    let mut slowest = (0u128, String::new());
    for id in &ids {
        let t = Instant::now();
        let v = conversation(&c, id, spec(500)).unwrap();
        let ms = t.elapsed().as_millis();
        if ms > slowest.0 {
            slowest = (ms, id.clone());
        }
        for a in &v.attempts {
            attempts += 1;
            if a.binding == "verified" {
                verified += 1;
            }
        }
        if v.available {
            with += 1;
            // isolation: every record belongs to exactly this instance, and every
            // session id it cites is one of this task's own attempts
            let own: HashSet<_> = v
                .attempts
                .iter()
                .filter_map(|a| a.session_id.clone())
                .collect();
            for e in &v.page.events {
                assert_eq!(&e.task_instance_id, id);
                assert!(own.contains(e.session_id.as_deref().unwrap()));
                if let Some(a) = &e.attempt_id {
                    assert!(v.attempts.iter().any(|x| &x.attemptId_ref() == a));
                }
            }
        } else {
            without += 1;
            assert!(v.page.events.is_empty());
            assert!(v.reason.as_deref().unwrap().starts_with(NO_HISTORY_MESSAGE));
            if v.attempts.iter().any(|a| a.binding.starts_with("refused")) {
                refused.push(id.clone());
            }
        }
    }
    println!(
        "instances={} with={} without={} attempts={} verified={} refused={:?} slowest={}ms ({})",
        ids.len(),
        with,
        without,
        attempts,
        verified,
        refused,
        slowest.0,
        slowest.1
    );
    assert_eq!((with, without), (58, 1));
    assert_eq!((attempts, verified), (70, 69));
    assert_eq!(refused.len(), 1, "the unmatched attempt must fail closed");
}

trait AttemptIdRef {
    #[allow(non_snake_case)]
    fn attemptId_ref(&self) -> String;
}
impl AttemptIdRef for nexus_client::transcript::AttemptProvenance {
    #[allow(non_snake_case)]
    fn attemptId_ref(&self) -> String {
        self.attempt_id.clone()
    }
}

#[test]
#[ignore]
fn real_task_0058_content_and_switching() {
    let c = cfg();
    let t58 = "task_66b2aed68b9941e89313321b46b6f06e";
    let v = conversation(&c, t58, spec(500)).unwrap();
    assert!(v.available && v.source == "dsh-session-log");
    assert_eq!(v.display_task_id.as_deref(), Some("TASK-0058"));
    assert_eq!(v.attempts.len(), 2);
    assert!(v.attempts.iter().all(|a| a.binding == "verified"));
    let ev = &v.page.events;
    let users: Vec<_> = ev
        .iter()
        .filter(|e| e.kind == EventKind::UserMessage && e.input_class == InputClass::UserAuthored)
        .collect();
    assert!(users.iter().any(|e| e.text.as_deref() == Some("continue")));
    assert!(ev
        .iter()
        .any(|e| e.kind == EventKind::AssistantMessage && e.speaker == Speaker::Worker));
    assert!(ev.iter().any(|e| e.kind == EventKind::ControllerMessage));
    assert!(ev.iter().any(|e| e.kind == EventKind::Error));
    // a real tool call paired with a result by call id
    let call = ev
        .iter()
        .find(|e| e.kind == EventKind::ToolCall)
        .expect("tool call");
    assert!(ev
        .iter()
        .any(|e| e.kind == EventKind::ToolResult && e.tool_call_id == call.tool_call_id));
    // attempt switching: later turns belong to attempt 2
    assert!(ev
        .iter()
        .any(|e| e.attempt_id.as_deref() == Some("TASK-0058-A1")));
    assert!(ev
        .iter()
        .any(|e| e.attempt_id.as_deref() == Some("TASK-0058-A2")));
    // Model I/O: recorded headers exist and say what they are
    let io = model_io(&c, t58).unwrap();
    assert!(io.available && !io.records.is_empty());
    assert!(io.note.contains("not recorded verbatim"));
    // switching back and forth never mixes records
    let other = "task_4c9f5b5641b542c0920568bd5e0ac589"; // TASK-0009
    for _ in 0..3 {
        let a = conversation(&c, t58, spec(50)).unwrap();
        let b = conversation(&c, other, spec(50)).unwrap();
        assert!(a.page.events.iter().all(|e| e.task_instance_id == t58));
        assert!(b.page.events.iter().all(|e| e.task_instance_id == other));
    }
    // a task that never started has no history and says so exactly
    let none = conversation(&c, "task_bc52a0b3076d4fc9aa22ad3cda26f632", spec(50)).unwrap();
    assert!(!none.available);
    assert!(none.reason.unwrap().starts_with(NO_HISTORY_MESSAGE));
    // no secret-shaped strings survive in any recorded text of this task
    let blob = serde_json::to_string(ev).unwrap();
    assert!(!blob.contains("sk-live") && !blob.to_lowercase().contains("bearer ey"));
}

#[test]
#[ignore]
fn real_cursor_replay_has_no_duplicates() {
    let c = cfg();
    let t = "task_66b2aed68b9941e89313321b46b6f06e";
    let first = conversation(&c, t, spec(500)).unwrap();
    let head = first.page.head_seq.unwrap();
    // replaying from the head returns nothing; from the middle returns each id once
    let none = conversation(
        &c,
        t,
        PageSpec {
            after_seq: Some(head),
            limit: 500,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(none.page.events.is_empty());
    let mid = head / 2;
    let tail = conversation(
        &c,
        t,
        PageSpec {
            after_seq: Some(mid),
            limit: 500,
            ..Default::default()
        },
    )
    .unwrap();
    let ids: HashSet<_> = tail
        .page
        .events
        .iter()
        .map(|e| e.message_id.clone())
        .collect();
    assert_eq!(ids.len(), tail.page.events.len());
}
