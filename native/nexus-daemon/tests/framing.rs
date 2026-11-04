//! H-04: IPC newline framing and UTF-8 correctness over real sockets.
//!
//! Failing-first regression tests: the pre-fix framer accumulates whole
//! reads into one `String` via per-chunk `from_utf8_lossy`, so coalesced
//! requests are swallowed into a single unparsable frame and multi-byte
//! characters split across reads are silently corrupted.

mod common;

use common::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

fn open_conn(socket: &std::path::Path) -> UnixStream {
    let s = UnixStream::connect(socket).expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    s.set_write_timeout(Some(Duration::from_secs(5)))
        .expect("write timeout");
    s
}

/// Read exactly one `\n`-terminated response. EOF before any byte means
/// the server refused the connection (admission control); that surfaces as
/// `None` so tests can distinguish refusal from a hang.
fn read_one(stream: &mut UnixStream) -> Option<serde_json::Value> {
    let mut buf = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match stream.read(&mut byte) {
            Ok(0) => {
                if buf.is_empty() {
                    return None;
                }
                panic!("connection closed mid-response");
            }
            Ok(_) => {}
            Err(e) => panic!("response read failed (server never answered): {e}"),
        }
        if byte[0] == b'\n' {
            break;
        }
        buf.push(byte[0]);
        assert!(buf.len() < 8 * 1024 * 1024, "response exceeds sane bound");
    }
    let text = std::str::from_utf8(&buf).expect("daemon responses are UTF-8");
    Some(serde_json::from_str(text).expect("daemon responses are JSON"))
}

fn health_frame(id: &str) -> String {
    format!(r#"{{"protocol":1,"id":"{id}","cmd":"health","params":{{}}}}"#)
}

#[test]
fn coalesced_requests_in_one_read_are_all_served() {
    let mut d = spawn_daemon("readonly", false);
    let mut conn = open_conn(&d.socket);
    // Three complete frames in a SINGLE write: a correct framer serves all
    // three; the pre-fix accumulator merges them into one bad-request and
    // then stalls waiting for more input.
    let burst = format!(
        "{}\n{}\n{}\n",
        health_frame("coal-1"),
        health_frame("coal-2"),
        health_frame("coal-3")
    );
    conn.write_all(burst.as_bytes()).expect("burst write");
    for want in ["coal-1", "coal-2", "coal-3"] {
        let resp = read_one(&mut conn).unwrap_or_else(|| {
            panic!("missing response for {want}: server swallowed coalesced frames")
        });
        assert_ok(&resp);
        assert_eq!(resp.get("id").and_then(|v| v.as_str()), Some(want));
    }
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn fragmented_frame_with_split_multibyte_chars_is_exact() {
    let mut d = spawn_daemon("readonly", false);
    let mut conn = open_conn(&d.socket);
    // Multi-byte characters (é = 2 bytes, 🌍 = 4 bytes) travel inside the
    // frame; byte-at-a-time delivery forces them to split across reads.
    let value = serde_json::json!({ "greeting": "héllo 🌍", "nested": ["é", "🌍🌍"] });
    let frame = serde_json::json!({"protocol": 1, "id": "frag-1", "cmd": "digest", "params": {"value": value}})
        .to_string();
    let bytes = frame.as_bytes();
    for byte in bytes {
        conn.write_all(std::slice::from_ref(byte))
            .expect("byte write");
        std::thread::sleep(Duration::from_millis(2));
    }
    conn.write_all(b"\n").expect("newline");
    let resp = read_one(&mut conn).expect("fragmented frame answered");
    assert_ok(&resp);
    let expected_canonical = nexus_contracts::canonical_json(&value);
    let expected_sha = nexus_contracts::sha256_hex(&expected_canonical);
    assert_eq!(
        resp.get("canonical").and_then(|v| v.as_str()),
        Some(expected_canonical.as_str()),
        "canonical bytes must preserve split UTF-8 exactly (no U+FFFD corruption)"
    );
    assert_eq!(
        resp.get("sha256").and_then(|v| v.as_str()),
        Some(expected_sha.as_str())
    );
    assert!(resp
        .get("canonical")
        .and_then(|v| v.as_str())
        .unwrap()
        .contains("🌍"));
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn invalid_utf8_is_refused_not_silently_replaced() {
    let mut d = spawn_daemon("readonly", false);
    let mut conn = open_conn(&d.socket);
    // 0xFF inside the id is never valid UTF-8. Lossy replacement would
    // silently rewrite the request identity and answer ok:true for a
    // corrupted id; the correct behavior is a bad-request refusal.
    let mut raw = b"{\"protocol\":1,\"id\":\"a\xFFb\",\"cmd\":\"health\",\"params\":{}}".to_vec();
    raw.push(b'\n');
    conn.write_all(&raw).expect("raw write");
    let resp = read_one(&mut conn).expect("invalid-UTF-8 frame answered");
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(false)),
        "invalid UTF-8 must be refused, never served under a replaced identity: {resp}"
    );
    assert_refused(&resp, "bad-request");
    // The connection stays usable afterwards.
    conn.write_all(format!("{}\n", health_frame("after-utf8")).as_bytes())
        .expect("write");
    let again = read_one(&mut conn).expect("server survives invalid UTF-8");
    assert_ok(&again);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn oversized_frame_does_not_disturb_a_sibling_client() {
    let mut d = spawn_daemon("readonly", false);
    let mut victim = open_conn(&d.socket);
    let mut sibling = open_conn(&d.socket);
    let big = "x".repeat(1024 * 1024 + 100);
    let frame = format!(r#"{{"protocol":1,"id":"big","cmd":"health","params":{{"pad":"{big}"}}}}"#);
    victim.write_all(frame.as_bytes()).expect("big write");
    victim.write_all(b"\n").expect("newline");
    let refused = read_one(&mut victim).expect("oversize answered");
    assert_refused(&refused, "too-large");
    // The victim connection is closed after the refusal...
    assert!(
        read_one(&mut victim).is_none(),
        "oversize closes the victim connection"
    );
    // ...while the sibling is completely unaffected.
    sibling
        .write_all(format!("{}\n", health_frame("sibling-1")).as_bytes())
        .expect("write");
    let ok = read_one(&mut sibling).expect("sibling answered");
    assert_ok(&ok);
    assert_eq!(ok.get("id").and_then(|v| v.as_str()), Some("sibling-1"));
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn pipelined_sequential_exchanges_on_one_connection() {
    let mut d = spawn_daemon("readonly", false);
    let mut conn = open_conn(&d.socket);
    for i in 0..5 {
        let id = format!("pipe-{i}");
        conn.write_all(format!("{}\n", health_frame(&id)).as_bytes())
            .expect("write");
        let resp = read_one(&mut conn).expect("pipelined answer");
        assert_ok(&resp);
        assert_eq!(resp.get("id").and_then(|v| v.as_str()), Some(id.as_str()));
    }
    terminate(&mut d.child);
    let _ = d.child.wait();
}
