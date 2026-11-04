//! A2.5 conversation API: durable mock recording, replay after restart,
//! isolation, honest absence.

use nexus_client::transcript::{EventKind, MessageState, PageSpec, Source, Speaker};
use nexus_client::*;

fn cfg(dir: &std::path::Path) -> ClientConfig {
    let mut c = ClientConfig::resolve(Some("/nonexistent.sock".into()), None, false).unwrap();
    c.transcript_dir = dir.join("transcripts");
    c.runs_dir = Some(dir.join("runs"));
    c.sessions_root = Some(dir.join("sessions"));
    c
}

fn spec() -> PageSpec {
    PageSpec {
        limit: 200,
        ..Default::default()
    }
}

#[test]
fn recorded_mock_run_is_durable_ordered_and_labelled_mock() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    let mut steps = 0;
    let (report, id) = run_mock_recorded(&c, "Привет, Nexus", &mut |p| {
        if matches!(p, MockProgress::Step { .. }) {
            steps += 1;
        }
    })
    .unwrap();
    assert!(id.starts_with("mock_") && steps > 0);
    // "restart": a brand new config/store handle sees the same records
    let again = cfg(d.path());
    let v = conversation(&again, &id, spec()).unwrap();
    assert!(v.available);
    assert_eq!(v.source, "native-store");
    let evs = &v.page.events;
    assert_eq!(evs[0].kind, EventKind::UserMessage);
    assert_eq!(evs[0].text.as_deref(), Some("Привет, Nexus"));
    assert!(evs.iter().all(|e| e.source == Source::MockFixture));
    let a = evs
        .iter()
        .find(|e| e.kind == EventKind::AssistantMessage)
        .unwrap();
    assert_eq!(a.state, MessageState::Final);
    assert_eq!(a.text.as_deref(), Some(report.text.as_str()));
    assert_eq!(a.speaker, Speaker::Worker);
    assert_ne!(a.actor.agent.as_deref(), Some("nova"));
    assert!(evs.windows(2).all(|w| w[0].seq < w[1].seq));
    // partial revisions collapsed: exactly one assistant message is shown
    assert_eq!(
        evs.iter()
            .filter(|e| e.kind == EventKind::AssistantMessage)
            .count(),
        1
    );
}

#[test]
fn conversations_do_not_leak_between_tasks() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    let (_, a) = run_mock_recorded(&c, "first", &mut |_| {}).unwrap();
    let (_, b) = run_mock_recorded(&c, "second", &mut |_| {}).unwrap();
    assert_ne!(a, b);
    let va = conversation(&c, &a, spec()).unwrap();
    let vb = conversation(&c, &b, spec()).unwrap();
    assert_eq!(va.page.events[0].text.as_deref(), Some("first"));
    assert_eq!(vb.page.events[0].text.as_deref(), Some("second"));
    assert!(va.page.events.iter().all(|e| e.task_instance_id == a));
    let list = list_mock_conversations(&c);
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|m| m.finalized));
}

#[test]
fn credentials_in_prompts_are_redacted_before_persisting() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    let (_, id) =
        run_mock_recorded(&c, "use api_key=abcdef1234567890 please", &mut |_| {}).unwrap();
    let raw = std::fs::read_to_string(c.transcript_dir.join(format!("{id}.jsonl"))).unwrap();
    assert!(!raw.contains("abcdef1234567890"));
    let v = conversation(&c, &id, spec()).unwrap();
    assert!(v.page.events[0]
        .text
        .as_deref()
        .unwrap()
        .contains("[REDACTED:"));
    assert_eq!(v.page.events[0].redactions, 1);
}

#[test]
fn missing_history_is_reported_with_exact_copy() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    let v = conversation(&c, "task_0123456789abcdef0123456789abcdef", spec()).unwrap();
    assert!(!v.available);
    assert_eq!(v.source, "none");
    assert!(v.reason.unwrap().starts_with(NO_HISTORY_MESSAGE));
    assert!(v.page.events.is_empty());
}

#[test]
fn malformed_ids_are_rejected_and_model_io_is_honest_for_mocks() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    assert!(conversation(&c, "../../etc/passwd", spec()).is_err());
    assert!(model_io(&c, "TASK-0001").is_err());
    let (_, id) = run_mock_recorded(&c, "x", &mut |_| {}).unwrap();
    let m = model_io(&c, &id).unwrap();
    assert!(!m.available && m.records.is_empty());
}

#[test]
fn empty_prompt_writes_nothing() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    assert!(run_mock_recorded(&c, "  ", &mut |_| {}).is_err());
    assert!(list_mock_conversations(&c).is_empty());
}
