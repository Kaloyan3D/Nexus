//! EM-04C1: the persistent Governor worker. Parity with the one-shot bridge, statelessness,
//! isolation, restart/crash/timeout/cancellation behaviour, IPC attacks (against the Rust
//! supervisor with a hostile fake worker, and against the real worker with raw frames), bounds,
//! backpressure and process lifecycle. Needs `node`; every test is skipped without it.

use super::governor_bridge::{BridgeError, GovernorEvaluator, NodeGovernorBridge};
use super::worker_bridge::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn node() -> Option<PathBuf> {
    let out = Command::new("node").arg("--version").output().ok()?;
    out.status.success().then(|| PathBuf::from("node"))
}

macro_rules! need_node {
    () => {
        if node().is_none() {
            return;
        }
    };
}

fn cfg(script: String, timeout_ms: u64) -> WorkerConfig {
    let mut c = WorkerConfig::new("node".into());
    c.script = script;
    c.timeout = Duration::from_millis(timeout_ms);
    c
}

fn real() -> WorkerGovernorBridge {
    WorkerGovernorBridge::new("node".into(), "scope-A", Arc::new(AtomicBool::new(false)))
}

fn with_script(script: String, timeout_ms: u64) -> WorkerGovernorBridge {
    WorkerGovernorBridge::with_config(
        cfg(script, timeout_ms),
        "scope-A",
        Arc::new(AtomicBool::new(false)),
    )
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes existence; the child has been reaped by its owner when gone
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn sigkill(pid: u32) {
    // SAFETY: killing our own test child
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

/// The real worker script with a hook on its outgoing frames: `action` runs instead of the n-th
/// outgoing frame (1 = ready, 2 = the first response, ...). The evaluation has already happened.
fn real_with_hook(n: u32, action: &str) -> String {
    format!(
        "(function(){{ let w = 0; const orig = process.stdout.write.bind(process.stdout);\
         process.stdout.write = function (b) {{ w += 1; if (w === {n}) {{ {action} }} return orig(b); }}; }})();\n{}",
        WORKER_SOURCE
    )
}

/// A fake worker with an honest handshake (it echoes the digests of what it was sent) and a
/// per-test `reply(m)` body that may write anything with `put(...)`.
fn fake(reply: &str) -> String {
    format!(
        r#"
const crypto = require('node:crypto');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
let buf = Buffer.alloc(0), hello = true;
function frame(o) {{ const b = Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); }}
const put = (o) => process.stdout.write(frame(o));
const ok = (m, result) => put({{ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: {{ ok: true, result }} }});
process.stdin.on('data', (c) => {{
  buf = Buffer.concat([buf, c]);
  for (;;) {{
    if (buf.length < 4) return;
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) return;
    const m = JSON.parse(buf.subarray(4, 4 + n));
    buf = buf.subarray(4 + n);
    if (hello) {{
      hello = false;
      const d = {{}};
      for (const k of ['governor', 'runtime', 'activity', 'signals']) d[k] = sha(m.sources[k]);
      d.bridge = sha(m.bridge);
      DIGEST_TAMPER
      put({{ v: 1, type: 'ready', digests: d, node: process.version }});
      continue;
    }}
    {reply}
  }}
}});
process.stdin.on('end', () => process.exit(0));
"#
    )
    .replace("DIGEST_TAMPER", "")
}

// ---------------------------------------------------------------------------------------------
// parity with the one-shot bridge
// ---------------------------------------------------------------------------------------------

fn eval_args(reasoning: &Value, activity: &Value, events: Value, caps: &[&str]) -> Value {
    json!({
        "museReasoning": reasoning, "museActivity": activity, "events": events,
        "capabilities": caps, "resolve": true,
    })
}

fn same(a: &Result<Value, BridgeError>, b: &Result<Value, BridgeError>, what: &str) {
    match (a, b) {
        (Ok(x), Ok(y)) => assert_eq!(x, y, "{what}"),
        (Err(x), Err(y)) => assert_eq!(x, y, "{what}"),
        _ => panic!("{what}: one bridge answered and the other refused: {a:?} / {b:?}"),
    }
}

fn corpus() -> Vec<(&'static str, Vec<Value>)> {
    let ev = |t: &str, o: &str| json!({"type": "semantic", "op": o, "value": t});
    let sig = |s: Value, k: &str| json!({"type": "signal", "signal": s, "dispatchKey": k});
    let act = |c: Value| json!({"type": "activity", "classification": c});
    vec![
        ("fresh", vec![]),
        ("phase", vec![ev("implement", "setPhase")]),
        (
            "failures",
            vec![
                json!({"type": "semantic", "op": "recordImplementationFailure"}),
                json!({"type": "semantic", "op": "recordImplementationFailure"}),
                json!({"type": "semantic", "op": "recordHypothesisFailure"}),
            ],
        ),
        (
            "signal then replay",
            vec![
                sig(
                    json!({"phase": "diagnose", "recordHypothesisFailure": true}),
                    "n1:aaa",
                ),
                sig(
                    json!({"phase": "diagnose", "recordHypothesisFailure": true}),
                    "n1:aaa",
                ),
            ],
        ),
        (
            "activity",
            vec![
                act(json!({"kind": "mutation"})),
                act(json!({"kind": "verification", "outcome": "failed", "family": "native:cargo"})),
            ],
        ),
        (
            "establish",
            vec![
                sig(json!({"markRootCauseEstablished": true}), "n1:bbb"),
                sig(
                    json!({"markSolutionEstablished": true, "phase": "implement"}),
                    "n1:ccc",
                ),
            ],
        ),
        ("forbidden", vec![sig(json!({"effort": "max"}), "n1:ddd")]),
    ]
}

/// Drives the same chained scenario through both bridges; every answer must be equal.
fn run_chain(a: &dyn GovernorEvaluator, b: &dyn GovernorEvaluator, caps: &[&str]) {
    let (mut ra, mut aa) = (Value::Null, Value::Null);
    let (mut rb, mut ab) = (Value::Null, Value::Null);
    for (name, events) in corpus() {
        let xa = a.call("evaluate", &eval_args(&ra, &aa, json!(events), caps));
        let xb = b.call("evaluate", &eval_args(&rb, &ab, json!(events), caps));
        same(&xa, &xb, name);
        if let (Ok(x), Ok(y)) = (&xa, &xb) {
            ra = x["museReasoning"].clone();
            aa = x["museActivity"].clone();
            rb = y["museReasoning"].clone();
            ab = y["museActivity"].clone();
            assert_eq!(ra, rb, "{name}");
            assert_eq!(aa, ab, "{name}");
        }
    }
}

#[test]
fn the_worker_answers_exactly_like_the_one_shot_bridge() {
    need_node!();
    let one = NodeGovernorBridge::new("node".into());
    let w = real();
    same(
        &w.call("ladder", &json!({})),
        &one.call("ladder", &json!({})),
        "ladder",
    );
    run_chain(&w, &one, &["low", "medium", "high", "xhigh"]);
    run_chain(&w, &one, &["low", "medium", "high", "xhigh", "max"]);
    // the refusals are the same codes
    for args in [
        json!({"museReasoning": {"phase": "hacking", "rootCauseEstablished": false},
               "museActivity": null, "events": [], "capabilities": ["medium"], "resolve": true}),
        json!({"events": [{"type": "effort", "value": "max"}], "resolve": true}),
        json!({"museActivity": {"schemaVersion": 9}, "events": [], "capabilities": ["medium"], "resolve": true}),
        json!({"museReasoning": null, "museActivity": null, "events": [], "capabilities": ["low"], "resolve": true}),
    ] {
        same(
            &w.call("evaluate", &args),
            &one.call("evaluate", &args),
            &args.to_string(),
        );
    }
    same(
        &w.call("nonsense", &json!({})),
        &one.call("nonsense", &json!({})),
        "unknown op",
    );
    assert_eq!(w.stats().spawns, 1, "one process served every request");
}

#[test]
fn the_worker_keeps_no_state_between_requests() {
    need_node!();
    let w = real();
    let one = NodeGovernorBridge::new("node".into());
    // a request with a rich state, then an empty one: the second must equal a fresh one-shot
    let rich = w
        .call(
            "evaluate",
            &eval_args(
                &Value::Null,
                &Value::Null,
                json!([{"type": "signal", "signal": {"markRootCauseEstablished": true}, "dispatchKey": "n1:xyz"}]),
                &["low", "medium", "high"],
            ),
        )
        .unwrap();
    assert_eq!(rich["museReasoning"]["rootCauseEstablished"], true);
    let fresh_args = eval_args(
        &Value::Null,
        &Value::Null,
        json!([]),
        &["low", "medium", "high"],
    );
    same(
        &w.call("evaluate", &fresh_args),
        &one.call("evaluate", &fresh_args),
        "after a rich request",
    );
    // a replayed delivery is a duplicate only because the CALLER sends the processed window
    let replay = w
        .call(
            "evaluate",
            &eval_args(
                &Value::Null,
                &Value::Null,
                json!([{"type": "signal", "signal": {"markRootCauseEstablished": true}, "dispatchKey": "n1:xyz"}]),
                &["low", "medium", "high"],
            ),
        )
        .unwrap();
    assert_eq!(
        replay["acks"][0]["duplicate"], false,
        "no hidden window in the worker"
    );
    let again = w
        .call(
            "evaluate",
            &eval_args(
                &rich["museReasoning"],
                &rich["museActivity"],
                json!([{"type": "signal", "signal": {"markRootCauseEstablished": true}, "dispatchKey": "n1:xyz"}]),
                &["low", "medium", "high"],
            ),
        )
        .unwrap();
    assert_eq!(
        again["acks"][0]["duplicate"], true,
        "the window travels in the state"
    );
}

#[test]
fn two_runs_never_see_each_others_requests() {
    need_node!();
    let (a, b) = (real(), {
        WorkerGovernorBridge::new("node".into(), "scope-B", Arc::new(AtomicBool::new(false)))
    });
    let one = NodeGovernorBridge::new("node".into());
    let step = |phase: &str| {
        eval_args(
            &Value::Null,
            &Value::Null,
            json!([{"type": "semantic", "op": "setPhase", "value": phase}]),
            &["low", "medium", "high", "xhigh"],
        )
    };
    for i in 0..12 {
        let (pa, pb) = if i % 2 == 0 {
            ("verify", "design")
        } else {
            ("recover", "discover")
        };
        let (ra, rb) = (a.call("evaluate", &step(pa)), b.call("evaluate", &step(pb)));
        same(&ra, &one.call("evaluate", &step(pa)), "A");
        same(&rb, &one.call("evaluate", &step(pb)), "B");
        assert_eq!(ra.unwrap()["museReasoning"]["phase"], pa);
        assert_eq!(rb.unwrap()["museReasoning"]["phase"], pb);
    }
    assert_ne!(a.pid(), b.pid(), "each run owns its process");
}

#[test]
fn the_worker_environment_is_empty_and_its_memory_stays_flat() {
    need_node!();
    let w = real();
    let args = eval_args(
        &Value::Null,
        &Value::Null,
        json!([]),
        &["low", "medium", "high", "xhigh"],
    );
    for _ in 0..20 {
        w.call("evaluate", &args).unwrap();
    }
    let pid = w.pid().unwrap();
    let env = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
    assert!(env.is_empty(), "env_clear: the worker has no environment");
    let early = rss_kb(pid);
    for _ in 0..300 {
        w.call("evaluate", &args).unwrap();
    }
    let late = rss_kb(pid);
    assert!(early > 0 && late > 0);
    assert!(
        late < early + 40 * 1024,
        "rss grew from {early} to {late} KiB"
    );
    assert!(late < 192 * 1024, "worker rss {late} KiB");
    assert_eq!(w.pid(), Some(pid), "still the same process");
}

// ---------------------------------------------------------------------------------------------
// lifecycle: restart, crash, timeout, cancellation, shutdown
// ---------------------------------------------------------------------------------------------

fn evalq() -> Value {
    eval_args(
        &Value::Null,
        &Value::Null,
        json!([]),
        &["low", "medium", "high", "xhigh"],
    )
}

#[test]
fn a_worker_killed_between_requests_is_replaced() {
    need_node!();
    let w = real();
    let one = NodeGovernorBridge::new("node".into());
    w.call("evaluate", &evalq()).unwrap();
    let first = w.pid().unwrap();
    sigkill(first);
    same(
        &w.call("evaluate", &evalq()),
        &one.call("evaluate", &evalq()),
        "after the kill",
    );
    let second = w.pid().unwrap();
    assert_ne!(first, second);
    assert!(!alive(first));
    assert_eq!(w.stats().spawns, 2);
}

#[test]
fn a_crash_during_an_evaluation_is_retried_once_on_a_clean_worker() {
    need_node!();
    // the 2nd outgoing frame is the first response: the process dies instead of answering
    let w = with_script(real_with_hook(2, "process.exit(9);"), 5000);
    let one = NodeGovernorBridge::new("node".into());
    let r = w.call("evaluate", &evalq());
    // the first process crashed mid-evaluation; the retry ran on a new process, whose own first
    // response is also hooked: both die, so the call fails closed with an error
    assert_eq!(r.unwrap_err().code, "bridge-failed");
    let st = w.stats();
    assert_eq!((st.spawns, st.retries), (2, 1), "{st:?}");
    // a hook on the 3rd frame (the SECOND response) lets the first request through
    let w = with_script(real_with_hook(3, "process.exit(9);"), 5000);
    same(
        &w.call("evaluate", &evalq()),
        &one.call("evaluate", &evalq()),
        "first",
    );
    same(
        &w.call("evaluate", &evalq()),
        &one.call("evaluate", &evalq()),
        "second, retried",
    );
    let st = w.stats();
    assert_eq!(st.spawns, 2, "{st:?}");
    assert_eq!(st.retries, 1, "{st:?}");
    assert_eq!(st.crashes, 1, "{st:?}");
}

#[test]
fn a_crash_during_signal_acceptance_never_applies_a_signal_twice() {
    need_node!();
    // the state is the caller's: the retried evaluation starts from the same state and the signal
    // is applied once, in the single answer that is returned
    let w = with_script(real_with_hook(3, "process.exit(9);"), 5000);
    let one = NodeGovernorBridge::new("node".into());
    let sig = |k: &str| json!([{"type": "signal", "signal": {"recordHypothesisFailure": true, "phase": "diagnose"}, "dispatchKey": k}]);
    let caps = ["low", "medium", "high", "xhigh"];
    w.call(
        "evaluate",
        &eval_args(&Value::Null, &Value::Null, json!([]), &caps),
    )
    .unwrap();
    let args = eval_args(&Value::Null, &Value::Null, sig("n1:k1"), &caps);
    let got = w.call("evaluate", &args).unwrap();
    assert_eq!(got, one.call("evaluate", &args).unwrap());
    assert_eq!(got["acks"][0]["duplicate"], false);
    assert_eq!(got["museReasoning"]["failedHypotheses"], 1, "{got}");
    assert_eq!(w.stats().retries, 1);
    // delivering it again with the resulting state is a duplicate, on a worker that never saw it
    let replay = w
        .call(
            "evaluate",
            &eval_args(
                &got["museReasoning"],
                &got["museActivity"],
                sig("n1:k1"),
                &caps,
            ),
        )
        .unwrap();
    assert_eq!(replay["acks"][0]["duplicate"], true);
    assert_eq!(replay["museReasoning"]["failedHypotheses"], 1);
}

#[test]
fn a_crash_loop_stops_restarting() {
    need_node!();
    let mut c = cfg(real_with_hook(2, "process.exit(9);"), 5000);
    c.max_spawns = 3;
    let w = WorkerGovernorBridge::with_config(c, "scope-A", Arc::new(AtomicBool::new(false)));
    let mut codes = vec![];
    for _ in 0..4 {
        codes.push(w.call("evaluate", &evalq()).unwrap_err().code);
    }
    assert!(
        codes.contains(&"bridge-restart-limit".to_owned()),
        "{codes:?}"
    );
    assert!(w.stats().spawns <= 3, "{:?}", w.stats());
}

#[test]
fn a_hung_worker_times_out_is_killed_and_replaced() {
    need_node!();
    let w = with_script(real_with_hook(2, "for (;;) {}"), 600);
    let t = Instant::now();
    let e = w.call("evaluate", &evalq()).unwrap_err();
    assert_eq!(e.code, "bridge-timeout");
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    // the timed-out process is gone; the next request gets a clean one (its first response is
    // hooked too, so it times out as well: the supervisor never reuses the hung process)
    assert!(w.pid().is_none());
    assert_eq!(w.stats().timeouts, 1);
}

#[test]
fn cancellation_stops_a_pending_request_and_kills_the_worker() {
    need_node!();
    let cancel = Arc::new(AtomicBool::new(false));
    let w = Arc::new(WorkerGovernorBridge::with_config(
        cfg(real_with_hook(3, "for (;;) {}"), 20_000),
        "scope-A",
        cancel.clone(),
    ));
    w.call("evaluate", &evalq()).unwrap();
    let pid = w.pid().unwrap();
    let w2 = w.clone();
    let h = std::thread::spawn(move || w2.call("evaluate", &evalq()));
    std::thread::sleep(Duration::from_millis(400));
    let t = Instant::now();
    cancel.store(true, Ordering::SeqCst);
    let e = h.join().unwrap().unwrap_err();
    assert_eq!(e.code, "bridge-cancelled");
    assert!(t.elapsed() < Duration::from_secs(2));
    assert!(!alive(pid), "the cancelled worker is killed");
    // once cancelled, nothing starts again
    assert_eq!(
        w.call("evaluate", &evalq()).unwrap_err().code,
        "bridge-cancelled"
    );
    assert_eq!(w.stats().spawns, 1);
}

#[test]
fn shutdown_and_drop_end_the_process() {
    need_node!();
    let w = real();
    w.call("evaluate", &evalq()).unwrap();
    let pid = w.pid().unwrap();
    assert!(alive(pid));
    w.shutdown();
    assert!(!alive(pid));
    assert_eq!(
        w.call("evaluate", &evalq()).unwrap_err().code,
        "bridge-closed"
    );
    let w = real();
    w.call("evaluate", &evalq()).unwrap();
    let pid = w.pid().unwrap();
    drop(w);
    assert!(!alive(pid), "dropping the owner ends the worker");
    // the lease ends it even while the evaluator is still shared
    let w = Arc::new(real());
    w.call("evaluate", &evalq()).unwrap();
    let pid = w.pid().unwrap();
    let lease = WorkerLease::new(w.clone());
    drop(lease);
    assert!(!alive(pid));
    assert_eq!(
        w.call("evaluate", &evalq()).unwrap_err().code,
        "bridge-closed"
    );
}

#[test]
fn a_missing_node_is_unavailable_and_leaks_nothing() {
    let before = live_workers();
    let w = WorkerGovernorBridge::new(
        "/nonexistent/node".into(),
        "scope-A",
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        w.call("ladder", &json!({})).unwrap_err().code,
        "bridge-unavailable"
    );
    assert!(live_workers() <= before + 16);
    assert_eq!(w.stats().spawns, 0);
}

// ---------------------------------------------------------------------------------------------
// bounds and backpressure
// ---------------------------------------------------------------------------------------------

#[test]
fn oversized_input_is_refused_before_any_process_starts() {
    need_node!();
    let w = real();
    let big = json!({"events": [], "pad": "x".repeat(MAX_WORKER_ARGS + 1)});
    assert_eq!(
        w.call("evaluate", &big).unwrap_err().code,
        "bridge-input-too-large"
    );
    assert_eq!(
        w.call("evaluate", &json!([1])).unwrap_err().code,
        "bridge-input-invalid"
    );
    assert_eq!(w.stats().spawns, 0);
    // just under the bound is accepted and answered
    let edge = json!({"museReasoning": null, "museActivity": null, "events": [], "resolve": false,
                      "pad": "y".repeat(MAX_WORKER_ARGS - 200)});
    assert!(w.call("evaluate", &edge).is_ok());
}

#[test]
fn waiting_callers_are_bounded() {
    need_node!();
    let mut c = cfg(real_with_hook(2, "for (;;) {}"), 2500);
    c.max_pending = 2;
    let w = Arc::new(WorkerGovernorBridge::with_config(
        c,
        "scope-A",
        Arc::new(AtomicBool::new(false)),
    ));
    let hs: Vec<_> = (0..4)
        .map(|_| {
            let w = w.clone();
            std::thread::spawn(move || w.call("evaluate", &evalq()).unwrap_err().code)
        })
        .collect();
    let codes: Vec<String> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(codes.iter().any(|c| c == "bridge-busy"), "{codes:?}");
    assert!(w.stats().busy_rejections >= 1);
}

// ---------------------------------------------------------------------------------------------
// IPC attacks on the supervisor (a hostile fake worker)
// ---------------------------------------------------------------------------------------------

fn normal_reply() -> &'static str {
    "ok(m, { echo: m.op });"
}

#[test]
fn the_fake_worker_baseline_works() {
    need_node!();
    let w = with_script(fake(normal_reply()), 3000);
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap(),
        json!({"echo": "evaluate"})
    );
    assert_eq!(
        w.call("ladder", &json!({})).unwrap(),
        json!({"echo": "ladder"})
    );
    assert_eq!(w.stats().spawns, 1);
}

#[test]
fn a_duplicated_response_is_a_violation_never_a_second_answer() {
    need_node!();
    let w = with_script(
        fake("put({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: { ok: true, result: { n: m.id } } });\
              put({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: { ok: true, result: { n: 'DUP' } } });"),
        3000,
    );
    for _ in 0..4 {
        let r = w.call("evaluate", &json!({})).unwrap();
        assert_ne!(r["n"], "DUP", "a duplicate is never delivered as an answer");
    }
    assert!(w.stats().protocol_violations >= 1, "{:?}", w.stats());
}

#[test]
fn a_stale_replayed_or_foreign_response_is_refused() {
    need_node!();
    for (name, reply) in [
        ("older id", "put({ v: 1, type: 'response', id: m.id - 1, scope: m.scope, bridge: { ok: true, result: {} } });"),
        ("newer id", "put({ v: 1, type: 'response', id: m.id + 1, scope: m.scope, bridge: { ok: true, result: {} } });"),
        ("foreign scope", "put({ v: 1, type: 'response', id: m.id, scope: 'scope-B', bridge: { ok: true, result: {} } });"),
        ("missing scope", "put({ v: 1, type: 'response', id: m.id, bridge: { ok: true, result: {} } });"),
        ("string id", "put({ v: 1, type: 'response', id: String(m.id), scope: m.scope, bridge: { ok: true, result: {} } });"),
        ("unknown field", "put({ v: 1, type: 'response', id: m.id, scope: m.scope, extra: 1, bridge: { ok: true, result: {} } });"),
        ("wrong version", "put({ v: 2, type: 'response', id: m.id, scope: m.scope, bridge: { ok: true, result: {} } });"),
        ("unknown type", "put({ v: 1, type: 'event', id: m.id, scope: m.scope, bridge: { ok: true, result: {} } });"),
        ("no ok flag", "put({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: { result: {} } });"),
        ("bridge not an object", "put({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: 7 });"),
        ("not json", "put('this is not json');"),
        ("not an object", "put('[1,2,3]');"),
    ] {
        let w = with_script(fake(reply), 3000);
        let e = w.call("evaluate", &json!({})).unwrap_err();
        assert_eq!(e.code, "bridge-protocol", "{name}: {e:?}");
        assert!(w.pid().is_none(), "{name}: the offending process is killed");
    }
}

#[test]
fn a_fatal_message_and_a_silent_exit_are_failures() {
    need_node!();
    let w = with_script(
        fake("put({ v: 1, type: 'fatal', code: 'boom' }); process.exit(3);"),
        3000,
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap_err().code,
        "bridge-failed"
    );
    let w = with_script(fake("process.exit(0);"), 3000);
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap_err().code,
        "bridge-failed"
    );
}

#[test]
fn partial_and_truncated_frames_are_handled() {
    need_node!();
    // the answer arrives in pieces, across timer ticks: it is still ONE answer
    let w = with_script(
        fake(
            "const f = frame({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: { ok: true, result: { slow: true } } });\
             process.stdout.write(f.subarray(0, 2));\
             setTimeout(() => process.stdout.write(f.subarray(2, 9)), 40);\
             setTimeout(() => process.stdout.write(f.subarray(9)), 90);",
        ),
        5000,
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap(),
        json!({"slow": true})
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap(),
        json!({"slow": true})
    );
    assert_eq!(w.stats().spawns, 1);
    // half a frame and then death is a failure, not a guess
    let w = with_script(
        fake("const f = frame({ v: 1, type: 'response', id: m.id, scope: m.scope, bridge: { ok: true, result: {} } });\
              process.stdout.write(f.subarray(0, f.length - 3)); setTimeout(() => process.exit(1), 30);"),
        3000,
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap_err().code,
        "bridge-failed"
    );
}

#[test]
fn an_oversized_frame_is_refused_without_being_read() {
    need_node!();
    let w = with_script(
        fake("const h = Buffer.alloc(4); h.writeUInt32BE(64 * 1024 * 1024); process.stdout.write(h);"),
        3000,
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap_err().code,
        "bridge-output-too-large"
    );
    let w = with_script(
        fake("const h = Buffer.alloc(4); h.writeUInt32BE(0); process.stdout.write(h);"),
        3000,
    );
    assert_eq!(
        w.call("evaluate", &json!({})).unwrap_err().code,
        "bridge-output-too-large"
    );
    assert!(w.pid().is_none());
}

#[test]
fn a_worker_that_loaded_other_sources_is_refused_at_start() {
    need_node!();
    let tampered = fake(normal_reply()).replace(
        "put({ v: 1, type: 'ready'",
        "d.governor = '0'.repeat(64); put({ v: 1, type: 'ready'",
    );
    let w = with_script(tampered, 3000);
    let e = w.call("ladder", &json!({})).unwrap_err();
    assert_eq!(e.code, "bridge-protocol", "{e:?}");
    assert!(e.message.contains("governor"), "{e:?}");
    assert!(w.pid().is_none());
    // an extra or missing digest, and an unexpected ready field, are refused too
    for edit in [
        "d.extra = '0'.repeat(64); put({ v: 1, type: 'ready'",
        "delete d.signals; put({ v: 1, type: 'ready'",
        "put({ v: 1, type: 'ready', surprise: 1",
    ] {
        let t = fake(normal_reply()).replace("put({ v: 1, type: 'ready'", edit);
        let w = with_script(t, 3000);
        assert_eq!(
            w.call("ladder", &json!({})).unwrap_err().code,
            "bridge-protocol",
            "{edit}"
        );
    }
}

#[test]
fn a_worker_that_never_starts_times_out() {
    need_node!();
    let w = with_script("setInterval(() => {}, 1000);".into(), 500);
    assert_eq!(
        w.call("ladder", &json!({})).unwrap_err().code,
        "bridge-timeout"
    );
    assert!(w.pid().is_none());
}

// ---------------------------------------------------------------------------------------------
// IPC attacks on the real worker (raw frames)
// ---------------------------------------------------------------------------------------------

struct Raw {
    child: Child,
}

impl Raw {
    fn start() -> Self {
        let child = Command::new("node")
            .arg("-e")
            .arg(WORKER_SOURCE)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self { child }
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        let s = self.child.stdin.as_mut().unwrap();
        let _ = s.write_all(bytes).and_then(|_| s.flush());
    }

    fn send(&mut self, v: &Value) {
        let b = v.to_string().into_bytes();
        let mut f = (b.len() as u32).to_be_bytes().to_vec();
        f.extend(b);
        self.send_raw(&f);
    }

    fn recv(&mut self) -> Option<Value> {
        let o = self.child.stdout.as_mut().unwrap();
        let mut h = [0u8; 4];
        o.read_exact(&mut h).ok()?;
        let mut b = vec![0u8; u32::from_be_bytes(h) as usize];
        o.read_exact(&mut b).ok()?;
        serde_json::from_slice(&b).ok()
    }

    fn hello(&mut self) -> Value {
        self.send(&json!({"v": 1, "type": "hello", "sources": {
            "governor": GOVERNOR_SRC, "runtime": RUNTIME_SRC, "activity": ACTIVITY_SRC, "signals": SIGNALS_SRC,
        }, "bridge": BRIDGE_SRC}));
        self.recv().expect("ready")
    }

    fn req(id: u64) -> Value {
        json!({"v": 1, "type": "request", "id": id, "scope": "s", "op": "ladder", "args": {}})
    }

    fn exited(&mut self) -> bool {
        for _ in 0..100 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

use super::governor_bridge::{
    ACTIVITY_SOURCE as ACTIVITY_SRC, BRIDGE_SOURCE as BRIDGE_SRC, GOVERNOR_SOURCE as GOVERNOR_SRC,
    RUNTIME_SOURCE as RUNTIME_SRC, SIGNALS_SOURCE as SIGNALS_SRC,
};

#[test]
fn the_real_worker_refuses_every_malformed_or_replayed_frame() {
    need_node!();
    let attacks: Vec<(&str, Vec<Value>, &str)> =
        vec![("request before hello", vec![], "hello-invalid")];
    // a request before the handshake is not a hello
    for (name, _, code) in attacks {
        let mut r = Raw::start();
        r.send(&Raw::req(1));
        let f = r.recv().unwrap();
        assert_eq!(f["type"], "fatal", "{name}");
        assert_eq!(f["code"], code, "{name}");
        assert!(r.exited(), "{name}");
    }
    let cases: Vec<(&str, Vec<Value>, &str)> = vec![
        (
            "a replayed id",
            vec![Raw::req(1), Raw::req(1)],
            "request-out-of-sequence",
        ),
        ("a skipped id", vec![Raw::req(2)], "request-out-of-sequence"),
        ("id zero", vec![Raw::req(0)], "request-out-of-sequence"),
        (
            "a second hello",
            vec![json!({"v": 1, "type": "hello", "sources": {}, "bridge": ""})],
            "request-invalid",
        ),
        (
            "unknown field",
            vec![
                json!({"v": 1, "type": "request", "id": 1, "scope": "s", "op": "ladder", "args": {}, "x": 1}),
            ],
            "request-invalid",
        ),
        (
            "no scope",
            vec![json!({"v": 1, "type": "request", "id": 1, "op": "ladder", "args": {}})],
            "request-invalid",
        ),
        (
            "empty scope",
            vec![
                json!({"v": 1, "type": "request", "id": 1, "scope": "", "op": "ladder", "args": {}}),
            ],
            "request-invalid",
        ),
        (
            "hostile op",
            vec![
                json!({"v": 1, "type": "request", "id": 1, "scope": "s", "op": "../x;", "args": {}}),
            ],
            "request-invalid",
        ),
        (
            "array args",
            vec![
                json!({"v": 1, "type": "request", "id": 1, "scope": "s", "op": "ladder", "args": []}),
            ],
            "request-invalid",
        ),
        (
            "null args",
            vec![
                json!({"v": 1, "type": "request", "id": 1, "scope": "s", "op": "ladder", "args": null}),
            ],
            "request-invalid",
        ),
        (
            "wrong version",
            vec![
                json!({"v": 2, "type": "request", "id": 1, "scope": "s", "op": "ladder", "args": {}}),
            ],
            "request-invalid",
        ),
        (
            "fractional id",
            vec![
                json!({"v": 1, "type": "request", "id": 1.5, "scope": "s", "op": "ladder", "args": {}}),
            ],
            "request-out-of-sequence",
        ),
    ];
    for (name, frames, code) in cases {
        let mut r = Raw::start();
        assert_eq!(r.hello()["type"], "ready", "{name}");
        let mut last = Value::Null;
        for f in frames {
            r.send(&f);
            last = r.recv().unwrap_or(Value::Null);
            if last["type"] == "fatal" {
                break;
            }
        }
        assert_eq!(last["type"], "fatal", "{name}: {last}");
        assert_eq!(last["code"], code, "{name}");
        assert!(r.exited(), "{name}: the worker ends after a violation");
    }
    // framing violations
    for (name, bytes, code) in [
        (
            "a frame over the bound",
            (700u32 * 1024).to_be_bytes().to_vec(),
            "frame-too-large",
        ),
        (
            "a zero-length frame",
            0u32.to_be_bytes().to_vec(),
            "frame-too-large",
        ),
    ] {
        let mut r = Raw::start();
        r.hello();
        r.send_raw(&bytes);
        let f = r.recv().unwrap();
        assert_eq!(
            (f["type"].as_str(), f["code"].as_str()),
            (Some("fatal"), Some(code)),
            "{name}"
        );
        assert!(r.exited());
    }
    let mut r = Raw::start();
    r.hello();
    let junk = b"{not json";
    let mut f = (junk.len() as u32).to_be_bytes().to_vec();
    f.extend(junk);
    r.send_raw(&f);
    assert_eq!(r.recv().unwrap()["code"], "request-invalid");
    // a hello with the wrong shape
    let mut r = Raw::start();
    r.send(&json!({"v": 1, "type": "hello", "sources": {"governor": 1}, "bridge": "x"}));
    assert_eq!(r.recv().unwrap()["code"], "hello-invalid");
    let mut r = Raw::start();
    r.send(&json!({"v": 1, "type": "hello", "sources": {"governor": "", "runtime": "", "activity": "", "signals": ""}, "bridge": "this is ( not js"}));
    assert_eq!(r.recv().unwrap()["code"], "bridge-uncompilable");
}

#[test]
fn the_real_worker_survives_unknown_ops_split_frames_and_closes_on_eof() {
    need_node!();
    let mut r = Raw::start();
    assert_eq!(r.hello()["type"], "ready");
    // the same frame delivered a byte at a time
    let body = Raw::req(1).to_string().into_bytes();
    let mut f = (body.len() as u32).to_be_bytes().to_vec();
    f.extend(&body);
    for b in f {
        r.send_raw(&[b]);
    }
    let a = r.recv().unwrap();
    assert_eq!(a["type"], "response");
    assert_eq!(a["id"], 1);
    assert_eq!(a["scope"], "s");
    assert_eq!(a["bridge"]["ok"], true);
    // an unknown op is the bridge's own refusal, not a violation: the worker stays up
    let mut bad = Raw::req(2);
    bad["op"] = json!("nonsense");
    r.send(&bad);
    let b = r.recv().unwrap();
    assert_eq!(
        (b["bridge"]["ok"].as_bool(), b["bridge"]["code"].as_str()),
        (Some(false), Some("op-invalid"))
    );
    // two requests written back to back are answered strictly in order
    r.send(&Raw::req(3));
    r.send(&Raw::req(4));
    assert_eq!(r.recv().unwrap()["id"], 3);
    assert_eq!(r.recv().unwrap()["id"], 4);
    drop(r.child.stdin.take());
    assert!(r.exited(), "EOF on stdin ends the worker");
}

// ---------------------------------------------------------------------------------------------
// the transports, side by side
// ---------------------------------------------------------------------------------------------

/// `cargo test --release -- --ignored --nocapture the_persistent_worker_is_faster`
#[test]
#[ignore = "benchmark: run explicitly, preferably in release"]
fn the_persistent_worker_is_faster_than_the_one_shot_bridge() {
    need_node!();
    let n = 60;
    let one = NodeGovernorBridge::new("node".into());
    let w = real();
    let gov = evalq();
    let sig = eval_args(
        &Value::Null,
        &Value::Null,
        json!([{"type": "signal", "signal": {"phase": "diagnose", "recordHypothesisFailure": true}, "dispatchKey": "n1:bench"}]),
        &["low", "medium", "high", "xhigh"],
    );
    let time = |b: &dyn GovernorEvaluator, args: &Value, n: usize| {
        let mut v: Vec<f64> = (0..n)
            .map(|_| {
                let t = Instant::now();
                b.call("evaluate", args).unwrap();
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (
            v[v.len() / 2],
            v[(v.len() * 95) / 100],
            v.iter().sum::<f64>() / v.len() as f64,
        )
    };
    let t0 = Instant::now();
    w.call("evaluate", &gov).unwrap();
    let cold = t0.elapsed().as_secs_f64() * 1000.0;
    let pid = w.pid().unwrap();
    let rss0 = rss_kb(pid);
    for (name, args) in [("governor", &gov), ("signal", &sig)] {
        let (m1, p1, a1) = time(&one, args, n);
        let (m2, p2, a2) = time(&w, args, n * 5);
        println!(
            "BENCH {name}: one-shot median {m1:.1} ms p95 {p1:.1} mean {a1:.1} | worker median {m2:.2} ms p95 {p2:.2} mean {a2:.2} | speedup x{:.0}",
            m1 / m2
        );
    }
    println!(
        "BENCH worker cold start (spawn + handshake + first request) {cold:.1} ms; rss after first {rss0} KiB, after {} requests {} KiB",
        n * 10 + 1,
        rss_kb(pid)
    );
    assert_eq!(w.stats().spawns, 1);
}

/// `cargo test --release -- --ignored --nocapture the_worker_memory_plateaus`
#[test]
#[ignore = "measurement: run explicitly"]
fn the_worker_memory_plateaus() {
    need_node!();
    let w = real();
    let args = evalq();
    let t = Instant::now();
    w.call("evaluate", &args).unwrap();
    let pid = w.pid().unwrap();
    println!(
        "MEM start (spawn+handshake+1st) {:?}; rss {} KiB hwm {} KiB",
        t.elapsed(),
        rss_kb(pid),
        hwm_kb(pid)
    );
    for round in 1..=8 {
        for _ in 0..500 {
            w.call("evaluate", &args).unwrap();
        }
        println!(
            "MEM after {:>5} requests: rss {} KiB hwm {} KiB",
            round * 500 + 1,
            rss_kb(pid),
            hwm_kb(pid)
        );
    }
}

fn hwm_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}
