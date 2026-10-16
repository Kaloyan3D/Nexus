//! A5.3.1: the Desktop data contract reads model runs through the broker and
//! never needs the (issuer-private) transcript files.

use nexus_client::desktop_contract as dc;
use nexus_client::ClientConfig;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

const CONV: &str = "model_0123456789abcdef0123456789abcdef";

fn cfg(dir: &Path) -> ClientConfig {
    ClientConfig {
        socket_path: dir.join("unused.sock"),
        ledger_dir: None,
        json: false,
        runs_dir: None,
        sessions_root: None,
        // An unreadable location: any direct transcript read would fail/empty.
        transcript_dir: dir.join("no-such-transcripts").join("deeper"),
    }
}

fn run_json(conv: Option<&str>, state: &str, terminal: bool) -> serde_json::Value {
    serde_json::json!({
        "runId": "run_00000000000000000000000000000000", "requestId": "r", "clientId": "uid:1",
        "state": state, "terminal": terminal, "intentType": "model-only", "responseMode": "stream",
        "conversationId": conv, "providerId": "acme", "remoteModelId": "acme-1", "endpointKind": "provider",
        "usageInputTokens": 3, "usageOutputTokens": 4, "cancelRequested": false,
        "promptPreview": "design it", "createdAtMs": 5, "updatedAtMs": 6
    })
}

/// Fake broker: records frames, answers from `script(cmd)`.
fn broker(
    dir: &Path,
    script: impl Fn(&str) -> serde_json::Value + Send + 'static,
) -> (std::path::PathBuf, Arc<Mutex<Vec<serde_json::Value>>>) {
    let sock = dir.join("broker.sock");
    let _ = std::fs::remove_file(&sock);
    let l = UnixListener::bind(&sock).unwrap();
    let frames = Arc::new(Mutex::new(Vec::new()));
    let f2 = frames.clone();
    std::thread::spawn(move || {
        for s in l.incoming().take(16) {
            let mut s = s.unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            let cmd = v["cmd"].as_str().unwrap().to_owned();
            let id = v["id"].clone();
            f2.lock().unwrap().push(v);
            let mut r = script(&cmd);
            r["protocol"] = 1.into();
            r["id"] = id;
            let _ = s.write_all(format!("{r}\n").as_bytes());
        }
    });
    (sock, frames)
}

fn ok(result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"ok": true, "result": result})
}

fn err(code: &str) -> serde_json::Value {
    serde_json::json!({"ok": false, "code": code, "message": "x"})
}

#[test]
fn conversation_for_a_model_run_comes_from_the_broker_not_the_filesystem() {
    let d = tempfile::tempdir().unwrap();
    let view = serde_json::json!({"taskInstanceId": CONV, "source": "native-store", "available": true,
        "page": {"events": [{"text": "hello"}], "headSeq": 3}});
    let v2 = view.clone();
    let (sock, frames) = broker(d.path(), move |cmd| match cmd {
        "intent-conversation" => ok(serde_json::json!({ "view": v2 })),
        _ => err("unknown-command"),
    });
    let got = dc::conversation_read(&cfg(d.path()), &sock, CONV, Some(2), None, Some(50)).unwrap();
    assert_eq!(got, view);
    let f = frames.lock().unwrap();
    assert_eq!(f[0]["cmd"], "intent-conversation");
    assert_eq!(f[0]["params"]["conversationId"], CONV);
    assert_eq!(f[0]["params"]["afterSeq"], 2);
    assert!(
        f[0].get("auth").is_none(),
        "unprivileged: nothing is signed"
    );
    assert!(
        !d.path().join("no-such-transcripts").exists(),
        "no local transcript access was attempted"
    );
}

#[test]
fn another_clients_run_is_not_found_and_falls_back_to_an_empty_local_view() {
    let d = tempfile::tempdir().unwrap();
    let (sock, _) = broker(d.path(), |_| err("not-found"));
    let got = dc::conversation_read(&cfg(d.path()), &sock, CONV, None, None, None).unwrap();
    assert_eq!(got["available"], false, "{got}");
    assert!(!got.to_string().contains("hello"));
}

#[test]
fn an_unauthorized_broker_answer_is_reported_not_papered_over() {
    let d = tempfile::tempdir().unwrap();
    let (sock, _) = broker(d.path(), |_| err("unauthorized"));
    let e = dc::conversation_read(&cfg(d.path()), &sock, CONV, None, None, None).unwrap_err();
    assert_eq!(e.code, "unauthorized");
    let e = dc::model_run_status(&cfg(d.path()), &sock, CONV).unwrap_err();
    assert_eq!(e.code, "unauthorized");
}

#[test]
fn status_list_and_cancel_use_the_broker_and_expose_no_private_fields() {
    let d = tempfile::tempdir().unwrap();
    let (sock, frames) = broker(d.path(), |cmd| match cmd {
        "intent-list" => ok(
            serde_json::json!({"runs": [run_json(Some(CONV), "streaming", false), run_json(None, "preparing", false)]}),
        ),
        "intent-cancel" => ok(
            serde_json::json!({"run": run_json(Some(CONV), "streaming", false), "outcome": "requested"}),
        ),
        _ => err("unknown-command"),
    });
    let c = cfg(d.path());
    let st = dc::model_run_status(&c, &sock, CONV).unwrap();
    assert_eq!((st.state.as_str(), st.terminal), ("streaming", false));
    assert_eq!(st.provider_id.as_deref(), Some("acme"));
    assert_eq!(st.usage_input_tokens, Some(3));
    assert!(st.text.is_empty());
    let list = dc::list_model_conversations(&c, &sock);
    assert_eq!(
        list.len(),
        1,
        "runs without a conversation yet are not listed"
    );
    assert_eq!(list[0].first_prompt, "design it");
    dc::cancel_model_run(&c, &sock, CONV).unwrap();
    let f = frames.lock().unwrap();
    let cmds: Vec<_> = f.iter().map(|v| v["cmd"].as_str().unwrap()).collect();
    assert_eq!(
        cmds,
        ["intent-list", "intent-list", "intent-list", "intent-cancel"]
    );
}

#[test]
fn an_unreachable_broker_falls_back_to_the_callers_own_local_state_only() {
    let d = tempfile::tempdir().unwrap();
    let c = cfg(d.path());
    let nobody = d.path().join("nobody.sock");
    assert!(dc::list_model_conversations(&c, &nobody).is_empty());
    let got = dc::conversation_read(&c, &nobody, CONV, None, None, None).unwrap();
    assert_eq!(got["available"], false);
}
