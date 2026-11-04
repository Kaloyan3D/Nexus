//! H-05: MAX_CLIENTS admission must be atomic.
//!
//! Failing-first stress test: the pre-fix accept loop checks
//! `active_clients` before spawning while workers increment the counter
//! after spawning, so a burst of simultaneous connections can admit far
//! more than the configured 32 clients.

mod common;

use common::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Barrier};
use std::time::Duration;

const BURST: usize = 48;
const MAX_ADMITTED: usize = 32;

#[test]
fn burst_beyond_max_clients_never_exceeds_32() {
    let mut d = spawn_daemon("readonly", false);
    let socket = d.socket.clone();
    // All clients connect at the same instant to maximize the check-then-
    // spawn race window in the accept loop.
    let barrier = Arc::new(Barrier::new(BURST + 1));
    let handles: Vec<_> = (0..BURST)
        .map(|i| {
            let sock = socket.clone();
            let gate = Arc::clone(&barrier);
            std::thread::spawn(move || {
                gate.wait();
                let mut stream = match UnixStream::connect(&sock) {
                    Ok(s) => s,
                    Err(e) => return format!("connect-failed:{e}"),
                };
                stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
                stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
                let frame =
                    format!(r#"{{"protocol":1,"id":"burst-{i}","cmd":"health","params":{{}}}}"#);
                if stream.write_all(frame.as_bytes()).is_err() {
                    return "write-failed".to_owned();
                }
                if stream.write_all(b"\n").is_err() {
                    return "write-failed".to_owned();
                }
                // Admitted clients get exactly one response line; refused
                // clients see EOF (the server drops over-cap connections).
                let mut buf = Vec::new();
                loop {
                    let mut byte = [0u8; 1];
                    match stream.read(&mut byte) {
                        Ok(0) => {
                            if buf.is_empty() {
                                return "refused-eof".to_owned();
                            }
                            return "truncated".to_owned();
                        }
                        Ok(_) => {}
                        Err(e) => return format!("read-failed:{e}"),
                    }
                    if byte[0] == b'\n' {
                        break;
                    }
                    buf.push(byte[0]);
                }
                match serde_json::from_slice::<serde_json::Value>(&buf) {
                    Ok(v) if v.get("ok") == Some(&serde_json::Value::Bool(true)) => {
                        // Hold the connection open: the worker stays admitted
                        // until we go away, so the burst cannot recycle our
                        // slot while the accept loop is still draining the
                        // backlog. This is what makes the concurrent-cap
                        // assertion deterministic.
                        std::thread::sleep(Duration::from_secs(2));
                        "admitted".to_owned()
                    }
                    Ok(v)
                        if v.get("ok") == Some(&serde_json::Value::Bool(false))
                            && v.get("code").and_then(|c| c.as_str()) == Some("server-busy") =>
                    {
                        "refused-busy".to_owned()
                    }
                    Ok(v) => format!("unexpected:{v}"),
                    Err(e) => format!("bad-json:{e}"),
                }
            })
        })
        .collect();
    barrier.wait();
    let mut admitted = 0usize;
    let mut refused_busy = 0usize;
    let mut refused_eof = 0usize;
    for h in handles {
        match h.join().expect("client thread").as_str() {
            "admitted" => admitted += 1,
            "refused-busy" => refused_busy += 1,
            "refused-eof" => refused_eof += 1,
            other => panic!("unexpected client outcome: {other}"),
        }
    }
    assert_eq!(
        admitted + refused_busy + refused_eof,
        BURST,
        "every burst connection has a deterministic outcome"
    );
    assert_eq!(
        admitted, MAX_ADMITTED,
        "exactly the cap is admitted concurrently: {admitted} of {BURST} (max {MAX_ADMITTED})"
    );
    assert_eq!(
        refused_eof, 0,
        "over-cap refusals are graceful structured server-busy responses, never bare closes"
    );
    assert_eq!(
        refused_busy,
        BURST - admitted,
        "every non-admitted client gets the structured refusal, never a hang"
    );
    // The daemon still serves after the burst.
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"post-burst","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    terminate(&mut d.child);
    let _ = d.child.wait();
}
