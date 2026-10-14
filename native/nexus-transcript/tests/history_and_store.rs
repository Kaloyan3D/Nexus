//! Contract, store and historical-adapter tests (synthetic fixtures only).

use nexus_transcript::*;
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::Path;

const TASK: &str = "task_0123456789abcdef0123456789abcdef";
const OTHER: &str = "task_ffffffffffffffffffffffffffffffff";
const SESSION: &str = "session-11111111-2222-3333-4444-555555555555";

fn ev(id: &str, task: &str, kind: EventKind, text: &str) -> TranscriptEventV1 {
    let mut e = TranscriptEventV1::new(
        id,
        task,
        kind,
        Speaker::User,
        InputClass::UserAuthored,
        Source::NativeStore,
    );
    e.text = Some(text.to_owned());
    e
}

// ---------- store ----------

#[test]
fn append_assigns_order_and_persists_across_reopen() {
    let d = tempfile::tempdir().unwrap();
    {
        let s = TranscriptStore::open(d.path()).unwrap();
        for i in 0..5 {
            let o = s
                .append(
                    TASK,
                    ev(&format!("e{i}"), TASK, EventKind::UserMessage, "x"),
                )
                .unwrap();
            assert_eq!(o.seq, i);
        }
    }
    let s = TranscriptStore::open(d.path()).unwrap();
    let l = s.load(TASK).unwrap();
    assert_eq!(l.events.len(), 5);
    assert!(l.events.windows(2).all(|w| w[0].seq < w[1].seq));
    // continues the sequence after restart
    assert_eq!(
        s.append(TASK, ev("e5", TASK, EventKind::UserMessage, "y"))
            .unwrap()
            .seq,
        5
    );
}

#[test]
fn duplicates_are_suppressed_and_conflicts_refused() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    let e = ev("e1", TASK, EventKind::UserMessage, "hello");
    assert!(!s.append(TASK, e.clone()).unwrap().duplicate);
    assert!(s.append(TASK, e.clone()).unwrap().duplicate);
    assert_eq!(s.load(TASK).unwrap().events.len(), 1);
    let mut changed = e;
    changed.text = Some("different".into());
    assert_eq!(s.append(TASK, changed), Err(StoreError::Conflict));
}

#[test]
fn cross_task_writes_and_bad_ids_are_refused() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    assert_eq!(
        s.append(TASK, ev("e1", OTHER, EventKind::UserMessage, "x")),
        Err(StoreError::CrossTask)
    );
    assert_eq!(
        s.append(
            "../../etc/passwd",
            ev("e1", TASK, EventKind::UserMessage, "x")
        ),
        Err(StoreError::BadTaskId)
    );
    assert!(s.load(OTHER).unwrap().events.is_empty());
}

#[test]
fn dsh_records_cannot_be_copied_into_native_store() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    let mut e = ev("e1", TASK, EventKind::UserMessage, "x");
    e.source = Source::DshSessionLog;
    assert!(matches!(s.append(TASK, e), Err(StoreError::Invalid(_))));
}

#[test]
fn torn_trailing_line_is_tolerated_and_tampering_fails_closed() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    s.append(TASK, ev("e1", TASK, EventKind::UserMessage, "one"))
        .unwrap();
    s.append(TASK, ev("e2", TASK, EventKind::UserMessage, "two"))
        .unwrap();
    let path = d.path().join(format!("{TASK}.jsonl"));
    // simulate crash mid-append
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    f.write_all(b"{\"v\":1,\"prev\":\"abc").unwrap();
    drop(f);
    let l = s.load(TASK).unwrap();
    assert_eq!(l.events.len(), 2);
    assert_eq!(l.skipped, 1);
    // a later append still works and chains correctly
    s.append(TASK, ev("e3", TASK, EventKind::UserMessage, "three"))
        .unwrap();
    assert_eq!(s.load(TASK).unwrap().events.len(), 3);
    // tamper with record 1
    let text = fs::read_to_string(&path)
        .unwrap()
        .replace("\"one\"", "\"ONE\"");
    fs::write(&path, text).unwrap();
    let l = s.load(TASK).unwrap();
    assert_eq!(l.integrity_failure_at, Some(1));
    assert!(
        l.events.is_empty(),
        "nothing after a chain break is trusted"
    );
}

#[test]
fn revisions_collapse_partial_to_final() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    let mut p = ev("m1", TASK, EventKind::AssistantMessage, "Hel");
    p.state = MessageState::Partial;
    s.append(TASK, p.clone()).unwrap();
    s.append(TASK, ev("u2", TASK, EventKind::UserMessage, "between"))
        .unwrap();
    let mut f = p;
    f.revision = 1;
    f.event_id = "m1@1".into();
    f.message_id = "m1".into();
    f.state = MessageState::Final;
    f.text = Some("Hello".into());
    s.append(TASK, f).unwrap();
    let l = s.load(TASK).unwrap();
    let pg = page(
        &l.events,
        PageSpec {
            limit: 50,
            ..Default::default()
        },
    );
    assert_eq!(pg.events.len(), 2);
    assert_eq!(pg.events[0].text.as_deref(), Some("Hello"));
    assert_eq!(pg.events[0].state, MessageState::Final);
    assert_eq!(
        pg.events[1].event_id, "u2",
        "message keeps its original position"
    );
}

#[test]
fn paging_cursors_have_no_gaps_or_duplicates() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    for i in 0..1200 {
        s.append(
            TASK,
            ev(&format!("e{i}"), TASK, EventKind::UserMessage, "x"),
        )
        .unwrap();
    }
    let events = s.load(TASK).unwrap().events;
    let tail = page(
        &events,
        PageSpec {
            limit: 100,
            ..Default::default()
        },
    );
    assert_eq!(tail.events.len(), 100);
    assert_eq!(tail.last_seq, Some(1199));
    assert!(tail.has_earlier && !tail.has_later);
    let earlier = page(
        &events,
        PageSpec {
            before_seq: tail.first_seq,
            limit: 100,
            ..Default::default()
        },
    );
    assert_eq!(earlier.last_seq.unwrap() + 1, tail.first_seq.unwrap());
    // forward follow from a cursor returns only newer events
    let fwd = page(
        &events,
        PageSpec {
            after_seq: Some(1150),
            limit: 500,
            ..Default::default()
        },
    );
    assert_eq!(fwd.events.len(), 49);
    assert_eq!(fwd.first_seq, Some(1151));
    let none = page(
        &events,
        PageSpec {
            after_seq: Some(1199),
            limit: 10,
            ..Default::default()
        },
    );
    assert!(none.events.is_empty());
}

#[test]
fn large_transcript_loads_quickly() {
    let d = tempfile::tempdir().unwrap();
    let s = TranscriptStore::open(d.path()).unwrap();
    let big = "word ".repeat(400);
    for i in 0..400 {
        s.append(
            TASK,
            ev(&format!("e{i}"), TASK, EventKind::AssistantMessage, &big),
        )
        .unwrap();
    }
    let t = std::time::Instant::now();
    let l = s.load(TASK).unwrap();
    let pg = page(
        &l.events,
        PageSpec {
            limit: 200,
            ..Default::default()
        },
    );
    assert_eq!(l.events.len(), 400);
    assert_eq!(pg.events.len(), 200);
    assert!(t.elapsed().as_secs() < 5, "load took {:?}", t.elapsed());
}

// ---------- historical adapter ----------

fn zstd_frame(data: &[u8]) -> Vec<u8> {
    // Raw (uncompressed) zstd frame: valid per RFC 8878, no compressor needed.
    let mut out = vec![0x28, 0xB5, 0x2F, 0xFD];
    // Frame header: single segment, 4-byte content size.
    out.push(0b1010_0000); // FCS flag=2 (4 bytes), single segment, no checksum
    let len = data.len() as u32;
    out.extend_from_slice(&len.to_le_bytes());
    // One raw block, last block: header = (size << 3) | (type 0 << 1) | last
    let mut rest = data;
    while !rest.is_empty() {
        let n = rest.len().min(128 * 1024 - 1);
        let last = n == rest.len();
        let hdr = ((n as u32) << 3) | u32::from(last);
        out.extend_from_slice(&hdr.to_le_bytes()[..3]);
        out.extend_from_slice(&rest[..n]);
        rest = &rest[n..];
    }
    out
}

struct Fixture {
    _dir: tempfile::TempDir,
    src: DshSources,
}

fn write_session(root: &Path, ws: &str, sid: &str, rows: &[serde_json::Value]) {
    let dir = root.join(ws).join(sid);
    fs::create_dir_all(&dir).unwrap();
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
}

fn fixture(binding_instance: &str, with_error_turn: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("runs");
    let sessions = dir.path().join("sessions");
    let task_dir = runs.join("TASK-0007");
    fs::create_dir_all(&task_dir).unwrap();
    let attempts = [
        json!({"attemptId":"TASK-0007-A1","taskId":"TASK-0007","taskInstanceId":TASK,"workspace":"/w","sequence":1,"executionClass":"muse_main","status":"started","startedAtUtc":"2026-10-01T00:00:00Z","sessionId":SESSION,"startedByTurn":"1"}),
        json!({"attemptId":"TASK-0007-A1","taskId":"TASK-0007","taskInstanceId":TASK,"sequence":1,"status":"failed","timestampUtc":"2026-10-01T01:00:00Z"}),
        json!({"attemptId":"TASK-0007-A2","taskId":"TASK-0007","taskInstanceId":TASK,"workspace":"/w","sequence":2,"executionClass":"muse_main","status":"started","startedAtUtc":"2026-10-01T02:00:00Z","sessionId":SESSION,"startedByTurn":"3"}),
        // belongs to a different task instance: must never leak in
        json!({"attemptId":"TASK-0007-AX","taskId":"TASK-0007","taskInstanceId":OTHER,"workspace":"/w","sequence":9,"status":"started","sessionId":SESSION,"startedByTurn":"1"}),
    ];
    let a: String = attempts.iter().map(|r| format!("{r}\n")).collect();
    fs::write(task_dir.join("attempts.jsonl"), a).unwrap();

    let mut rows = vec![
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1000,"cwd":"/w"}),
        json!({"type":"agent-preset/selected","seq":1,"time":1001,"data":{"agentPreset":"aih-muse"}}),
        json!({"type":"turn/start","seq":2,"time":1002,"data":{"turn":1}}),
        json!({"type":"user/message","seq":3,"time":1003,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Controller: task TASK-0007 bound to this session.\nTask instance: {binding_instance}\n")}]}}),
        json!({"type":"user/message","seq":4,"time":1004,"data":{"id":"u","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"Implement it. api_key=abcdefghijkl1234"}]}}),
        json!({"type":"request/header","seq":5,"time":1005,"data":{"header":{"config":{"provider":"p","model":"m1","reasoningEffort":"high","maxTokens":100},"system":"You are an agent. Authorization: Bearer abcdefghij123456","tools":[{"name":"run_code"}]}}}),
        json!({"type":"request/context","seq":6,"time":1006,"data":{"contextWindow":1000}}),
        json!({"type":"assistant/message","seq":7,"time":1007,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"Working on it."},{"type":"tool-call","id":"c1","name":"run_code","arguments":"{}"}],"source":{"kind":"model","provider":"p","model":"m1","replayState":{"secret":"SHOULD-NOT-APPEAR"}}}}}),
        json!({"type":"tool/call","seq":8,"time":1008,"data":{"turn":1,"step":1,"callId":"c1","name":"run_code","arguments":"{\"code\":\"x\"}"}}),
        json!({"type":"tool/result","seq":9,"time":1009,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"c1"},"content":[{"type":"tool-result","toolCallId":"c1","content":[{"type":"text","text":"done"}],"isError":false}],"role":"user"}}}),
        json!({"type":"step/start","seq":10,"time":1010,"data":{"turn":1,"step":2}}),
        json!({"type":"request/header","seq":11,"time":1011,"data":{"header":{"config":{"provider":"p","model":"m2"},"system":"s","tools":[]}}}),
        json!({"type":"assistant/chunk","seq":12,"time":1012,"data":{"turn":1,"step":2,"chunk":{"type":"text-delta","index":0,"text":"Partial ans"}}}),
        json!({"type":"assistant/chunk","seq":13,"time":1013,"data":{"turn":1,"step":2,"chunk":{"type":"finish","reason":{"kind":"error"}}}}),
        json!({"type":"step/end","seq":14,"time":1014,"data":{"turn":1,"step":2}}),
        json!({"type":"turn/end","seq":15,"time":1015,"data":{"turn":1,"reason":{"kind":"completed"}}}),
    ];
    if with_error_turn {
        rows.push(json!({"type":"turn/start","seq":16,"time":1016,"data":{"turn":3}}));
        rows.push(json!({"type":"user/message","seq":17,"time":1017,"data":{"id":"u2","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"continue"}]}}));
        rows.push(json!({"type":"turn/end","seq":18,"time":1018,"data":{"turn":3,"reason":{"kind":"error","error":{"message":"boom","code":"E1"}}}}));
    }
    write_session(&sessions, "--w--", SESSION, &rows);
    Fixture {
        src: DshSources::new(runs, sessions),
        _dir: dir,
    }
}

#[test]
fn historical_join_classifies_and_attributes() {
    let f = fixture(TASK, true);
    let h = read_history(&f.src, TASK).unwrap();
    assert_eq!(h.display_task_id, "TASK-0007");
    assert_eq!(
        h.attempts.len(),
        2,
        "foreign task instance attempt must not leak"
    );
    assert!(h.attempts.iter().all(|a| a.binding == "verified"));
    let kinds: Vec<_> = h.events.iter().map(|e| (e.kind, e.input_class)).collect();
    assert!(kinds.contains(&(EventKind::UserMessage, InputClass::UserAuthored)));
    assert!(kinds.contains(&(EventKind::ControllerMessage, InputClass::ControllerCompiled)));
    assert!(kinds.contains(&(EventKind::ToolResult, InputClass::ToolOutput)));
    // worker, never orchestrator, with the recorded agent/model
    let a = h
        .events
        .iter()
        .find(|e| e.kind == EventKind::AssistantMessage)
        .unwrap();
    assert_eq!(a.speaker, Speaker::Worker);
    assert_eq!(a.actor.agent.as_deref(), Some("aih-muse"));
    assert_eq!(a.actor.model.as_deref(), Some("m1"));
    assert_eq!(a.attempt_id.as_deref(), Some("TASK-0007-A1"));
    // turn 3 belongs to attempt 2
    let last_user = h
        .events
        .iter()
        .find(|e| e.text.as_deref() == Some("continue"))
        .unwrap();
    assert_eq!(last_user.attempt_id.as_deref(), Some("TASK-0007-A2"));
    // order is strictly increasing
    assert!(h.events.windows(2).all(|w| w[0].seq < w[1].seq));
}

#[test]
fn partial_stream_handoff_error_and_omitted_reasoning() {
    let f = fixture(TASK, true);
    let h = read_history(&f.src, TASK).unwrap();
    let partial = h
        .events
        .iter()
        .find(|e| e.recording == Recording::AssembledFromChunks)
        .expect("assembled partial message");
    assert_eq!(partial.state, MessageState::Interrupted);
    assert_eq!(partial.text.as_deref(), Some("Partial ans"));
    assert!(h.events.iter().any(|e| e.kind == EventKind::ModelHandoff));
    let err = h
        .events
        .iter()
        .find(|e| e.kind == EventKind::Error)
        .unwrap();
    assert_eq!(err.text.as_deref(), Some("boom"));
    assert_eq!(h.coverage.reasoning_blocks_omitted, 1);
    // private replay state never surfaces
    let all = serde_json::to_string(&h.events).unwrap();
    assert!(!all.contains("SHOULD-NOT-APPEAR"));
}

#[test]
fn credentials_are_redacted_visibly() {
    let f = fixture(TASK, false);
    let h = read_history(&f.src, TASK).unwrap();
    let u = h
        .events
        .iter()
        .find(|e| e.kind == EventKind::UserMessage)
        .unwrap();
    assert!(u.text.as_deref().unwrap().contains("[REDACTED:credential]"));
    assert!(!u.text.as_deref().unwrap().contains("abcdefghijkl1234"));
    assert_eq!(u.redactions, 1);
    let req = &h.model_requests[0];
    assert!(req
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("[REDACTED:bearer-token]"));
    assert_eq!(req.context_window, Some(1000));
    assert_eq!(req.attempt_id.as_deref(), Some("TASK-0007-A1"));
    assert!(h.coverage.redactions >= 2);
}

#[test]
fn session_bound_to_another_instance_is_refused() {
    let f = fixture(OTHER, false);
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h.attempts.iter().all(|a| a.binding.starts_with("refused")));
}

#[test]
fn unknown_task_instance_has_no_history() {
    let f = fixture(TASK, false);
    assert_eq!(
        read_history(&f.src, "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap_err(),
        HistoryError::NoAttempts
    );
}

#[test]
fn missing_session_file_is_reported_not_invented() {
    let f = fixture(TASK, false);
    fs::remove_dir_all(&f.src.sessions_root).unwrap();
    fs::create_dir_all(&f.src.sessions_root).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h
        .attempts
        .iter()
        .all(|a| a.binding.starts_with("unavailable")));
}

#[test]
fn display_id_alone_never_joins() {
    // attempts file in a directory whose name differs from the record's taskId
    let f = fixture(TASK, false);
    let wrong = f.src.runs_dir.join("TASK-0099");
    fs::create_dir_all(&wrong).unwrap();
    let rec = json!({"attemptId":"TASK-0007-A7","taskId":"TASK-0007","taskInstanceId":TASK,"workspace":"/w","sequence":7,"status":"started","sessionId":SESSION,"startedByTurn":"1"});
    fs::write(wrong.join("attempts.jsonl"), format!("{rec}\n")).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.attempts.iter().all(|a| a.attempt_id != "TASK-0007-A7"));
    assert!(h.coverage.records_invalid >= 1);
}

#[test]
fn malformed_records_are_counted_not_fatal() {
    let f = fixture(TASK, false);
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let raw = "{\"type\":\"session\",\"version\":0,\"id\":\"".to_owned()
        + SESSION
        + "\",\"createdAt\":1,\"cwd\":\"/w\"}\nnot json\n{\"type\":\"user/message\"}\n";
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(raw.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.coverage.records_invalid >= 1);
    // binding message absent => refused, no events
    assert!(h.events.is_empty());
}

#[test]
fn long_tool_output_is_truncated_and_flagged() {
    let f = fixture(TASK, false);
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let big = "x".repeat(100_000);
    let rows = [
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1,"cwd":"/w"}),
        json!({"type":"user/message","seq":1,"time":1,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Task instance: {TASK}")}]}}),
        json!({"type":"tool/result","seq":2,"time":2,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"c"},"content":[{"type":"tool-result","toolCallId":"c","content":[{"type":"text","text":big}],"isError":false}]}}}),
    ];
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    let r = h
        .events
        .iter()
        .find(|e| e.kind == EventKind::ToolResult)
        .unwrap();
    assert!(r.truncated);
    assert_eq!(r.original_len, Some(100_000));
    assert_eq!(r.text.as_deref().unwrap().chars().count(), 32_000);
}

#[test]
fn untrusted_markup_is_carried_as_inert_text() {
    let f = fixture(TASK, false);
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let evil = "<script>alert(1)</script> [x](javascript:alert(1)) ```\nunterminated";
    let rows = [
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1,"cwd":"/w"}),
        json!({"type":"user/message","seq":1,"time":1,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Task instance: {TASK}")}]}}),
        json!({"type":"user/message","seq":2,"time":2,"data":{"id":"u","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":evil}]}}),
    ];
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    let u = h
        .events
        .iter()
        .find(|e| e.kind == EventKind::UserMessage)
        .unwrap();
    assert_eq!(
        u.text.as_deref(),
        Some(evil),
        "content is preserved verbatim; the UI must not interpret it as HTML"
    );
}

// ---------- A2.5 audit: input hardening regressions ----------

fn rle_frame(total: usize) -> Vec<u8> {
    // Zstd frame of RLE blocks: a few bytes on disk, `total` bytes of 'a' out.
    let mut out = vec![0x28, 0xB5, 0x2F, 0xFD, 0b1010_0000];
    out.extend_from_slice(&(total as u32).to_le_bytes());
    let mut left = total;
    while left > 0 {
        let n = left.min(128 * 1024 - 1);
        left -= n;
        let hdr = ((n as u32) << 3) | (1 << 1) | u32::from(left == 0);
        out.extend_from_slice(&hdr.to_le_bytes()[..3]);
        out.push(b'a');
    }
    out
}

fn session_path(f: &Fixture) -> std::path::PathBuf {
    f.src
        .sessions_root
        .join("--w--")
        .join(SESSION)
        .join("session.jsonl.zstd")
}

#[test]
fn symlinked_session_directory_is_never_followed() {
    let f = fixture(TASK, false);
    let real = f.src.sessions_root.join("--w--").join(SESSION);
    let moved = f.src.sessions_root.join("elsewhere");
    fs::rename(&real, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &real).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h
        .attempts
        .iter()
        .all(|a| a.binding.starts_with("unavailable")));
}

#[test]
fn symlinked_session_file_is_never_followed() {
    let f = fixture(TASK, false);
    let p = session_path(&f);
    let target = p.with_file_name("real.zstd");
    fs::rename(&p, &target).unwrap();
    std::os::unix::fs::symlink(&target, &p).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h
        .attempts
        .iter()
        .all(|a| a.binding.starts_with("unavailable")));
}

#[test]
fn symlinked_run_directory_and_attempt_file_are_ignored() {
    let f = fixture(TASK, false);
    let runs = &f.src.runs_dir;
    let real = runs.join("TASK-0007");
    let moved = runs.join("moved");
    fs::rename(&real, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &real).unwrap();
    assert_eq!(
        read_history(&f.src, TASK).unwrap_err(),
        HistoryError::NoAttempts
    );
}

#[test]
fn oversized_compressed_log_is_refused_without_reading_it() {
    let mut f = fixture(TASK, false);
    f.src.limits.max_compressed = 16;
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h
        .attempts
        .iter()
        .all(|a| a.binding.starts_with("unavailable")));
}

#[test]
fn decompression_bomb_is_bounded() {
    let mut f = fixture(TASK, false);
    let p = session_path(&f);
    fs::write(&p, rle_frame(8 * 1024 * 1024)).unwrap(); // tiny on disk, 8 MiB out
    f.src.limits.max_decompressed = 1024 * 1024;
    let t = std::time::Instant::now();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(t.elapsed().as_secs() < 10);
    assert!(h.events.is_empty());
    // the single 8 MiB line (no newlines) exceeds the line limit or is not JSON
    assert!(h.coverage.records_invalid >= 1 || !h.coverage.notes.is_empty());
}

#[test]
fn truncated_frame_keeps_the_decoded_prefix_and_reports_it() {
    let f = fixture(TASK, false);
    let p = session_path(&f);
    let good = fs::read(&p).unwrap();
    let mut cut = good.clone();
    // second frame cut in half = a log being written when the process died
    let half = &good[..good.len() / 2];
    cut.extend_from_slice(half);
    fs::write(&p, cut).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(!h.events.is_empty(), "first complete frame must survive");
    assert!(h
        .coverage
        .notes
        .iter()
        .any(|n| n.contains("truncated") || n.contains("not a valid")));
}

#[test]
fn garbage_log_is_unavailable_not_a_panic() {
    let f = fixture(TASK, false);
    fs::write(session_path(&f), b"this is not zstd at all").unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.events.is_empty());
    assert!(h
        .attempts
        .iter()
        .all(|a| a.binding.starts_with("unavailable")));
}

#[test]
fn overlong_lines_are_skipped_and_counted() {
    let mut f = fixture(TASK, false);
    f.src.limits.max_line = 400;
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let rows = [
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1,"cwd":"/w"}),
        json!({"type":"user/message","seq":1,"time":1,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Task instance: {TASK}")}]}}),
        json!({"type":"user/message","seq":2,"time":2,"data":{"id":"u","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"x".repeat(5000)}]}}),
    ];
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(h.coverage.records_invalid >= 1);
    assert!(h.events.iter().all(|e| e.kind != EventKind::UserMessage));
}

#[test]
fn secrets_in_every_recorded_channel_are_redacted() {
    let f = fixture(TASK, false);
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let secret = "sk-live-ABCDEFGHIJKLMNOP";
    let rows = [
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1,"cwd":"/w"}),
        json!({"type":"agent-preset/selected","seq":0,"time":1,"data":{"agentPreset":secret}}),
        json!({"type":"user/message","seq":1,"time":1,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Task instance: {TASK}")}]}}),
        json!({"type":"turn/start","seq":2,"time":2,"data":{"turn":1}}),
        json!({"type":"request/header","seq":3,"time":3,"data":{"header":{"config":{"provider":secret,"model":secret,"reasoningEffort":secret},"system":format!("key {secret}"),"tools":[{"name":secret}]}}}),
        json!({"type":"llm/retry","seq":4,"time":4,"data":{"turn":1,"retry":1,"maxRetries":3,"failure":{"message":format!("401 Bearer {secret}"),"code":secret}}}),
        json!({"type":"tool/result","seq":5,"time":5,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":secret},"content":[{"type":"tool-result","content":[{"type":"text","text":format!("env OPENAI_API_KEY={secret}")}],"isError":false}]}}}),
        json!({"type":"tool/call","seq":6,"time":6,"data":{"turn":1,"step":1,"callId":"c","name":secret,"arguments":format!("{{\"token\":\"{secret}\"}}")}}),
        json!({"type":"turn/end","seq":7,"time":7,"data":{"turn":1,"reason":{"kind":"error","error":{"message":format!("provider said {secret}"),"code":secret}}}}),
        json!({"type":"turn/start","seq":8,"time":8,"data":{"turn":2}}),
        json!({"type":"turn/end","seq":9,"time":9,"data":{"turn":2,"reason":{"kind":secret}}}),
    ];
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    assert!(!h.events.is_empty());
    let blob =
        serde_json::to_string(&(&h.events, &h.model_requests, &h.attempts, &h.coverage)).unwrap();
    assert!(
        !blob.contains("ABCDEFGHIJKLMNOP"),
        "secret leaked through a recorded channel: {blob}"
    );
}

#[test]
fn reasoning_text_and_replay_state_never_leave_the_adapter() {
    let f = fixture(TASK, false);
    let dir = f.src.sessions_root.join("--w--").join(SESSION);
    let rows = [
        json!({"type":"session","version":0,"id":SESSION,"createdAt":1,"cwd":"/w"}),
        json!({"type":"user/message","seq":1,"time":1,"data":{"id":"b","role":"user","source":{"kind":"plugin","plugin":"aih-controller","form":"controller-binding"},"content":[{"type":"text","text":format!("Task instance: {TASK}")}]}}),
        json!({"type":"assistant/message","seq":2,"time":2,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"PRIVATE CHAIN OF THOUGHT"},{"type":"text","text":"answer"}],"source":{"kind":"model","model":"m","replayState":{"blocks":[{"thinkingSignature":"PRIVATE SUMMARY"}]}}}}}),
        json!({"type":"assistant/chunk","seq":3,"time":3,"data":{"turn":1,"step":2,"chunk":{"type":"reasoning-delta","text":"PRIVATE DELTA"}}}),
        json!({"type":"assistant/chunk","seq":4,"time":4,"data":{"turn":1,"step":2,"chunk":{"type":"text-delta","text":"visible"}}}),
        json!({"type":"step/end","seq":5,"time":5,"data":{"turn":1,"step":2}}),
    ];
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(dir.join("session.jsonl.zstd"), zstd_frame(text.as_bytes())).unwrap();
    let h = read_history(&f.src, TASK).unwrap();
    let blob = serde_json::to_string(&h.events).unwrap();
    assert!(!blob.contains("PRIVATE"), "{blob}");
    assert!(blob.contains("answer") && blob.contains("visible"));
}
