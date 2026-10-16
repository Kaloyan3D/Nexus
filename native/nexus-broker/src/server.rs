//! Broker socket server and command handlers.
//!
//! Wire: one JSON object per line, `{protocol, id, cmd, params}`; replies
//! `{protocol, id, ok, result}` or `{protocol, id, ok:false, code, message}`.
//! The command set is closed; there is deliberately no verb that forwards a
//! daemon command, path, URL or shell.

use crate::config::BrokerConfig;
use crate::pipeline;
use crate::store::{RunRecord, Store};
use nexus_client::intent_client::{AllowedModel, IntentRun};
use nexus_client::{ClientConfig, ModelRunStatus};
use nexus_contracts::intent::NexusIntentV1;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FRAME: u64 = 80 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MAX_UNAUTH_CONNECTIONS: usize = 4;
const MAX_FOLLOW_DELTA: usize = 32 * 1024;
const TERMINAL: &[&str] = &[
    "completed",
    "cancelled",
    "timed-out",
    "provider-failed",
    "uncertain",
    "refused",
    "failed",
    "rejected",
    "abandoned",
];

pub struct Broker {
    pub cfg: BrokerConfig,
    pub store: Store,
    pub(crate) cap_hex: String,
    pub(crate) node_abs: std::path::PathBuf,
    pub(crate) cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(crate) bridge_lock: Mutex<()>,
    pub shutdown: AtomicBool,
    conns: AtomicUsize,
    unauth_conns: AtomicUsize,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    models: Mutex<Option<(Instant, Vec<AllowedModel>)>>,
    _lock: std::fs::File,
}

type CmdResult = Result<Value, (&'static str, String)>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_terminal_state(s: &str) -> bool {
    TERMINAL.contains(&s)
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    hex::encode(b)
}

fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

impl Broker {
    pub(crate) fn client_config(&self) -> ClientConfig {
        ClientConfig {
            socket_path: self.cfg.daemon_socket.clone(),
            ledger_dir: None,
            json: false,
            runs_dir: None,
            sessions_root: None,
            transcript_dir: self.cfg.transcript_dir.clone(),
        }
    }

    /// Load -> mutate -> persist atomically. Terminal states are sticky: a
    /// late worker write can never resurrect or rewrite a finished run.
    pub fn update(&self, run_id: &str, f: impl FnOnce(&mut IntentRun)) {
        let _g = self.store.lock();
        if let Some(mut rec) = self.store.load(run_id) {
            if rec.run.terminal {
                return;
            }
            f(&mut rec.run);
            rec.run.updated_at_ms = now_ms();
            let _ = self.store.put(&rec);
        }
    }

    fn view(&self, rec: &RunRecord) -> (IntentRun, String) {
        let mut run = rec.run.clone();
        let mut text = String::new();
        if let Some(conv) = &run.conversation_id {
            if let Ok(store) = nexus_transcript::TranscriptStore::open(&self.cfg.transcript_dir) {
                if let Ok(l) = store.load(conv) {
                    run.prompt_preview = l
                        .events
                        .iter()
                        .find(|e| e.kind == nexus_transcript::EventKind::UserMessage)
                        .and_then(|e| e.text.clone())
                        .map(|t| t.chars().take(160).collect());
                }
            }
            if let Ok(s) = nexus_client::model_run_status(&self.client_config(), conv) {
                text = s.text.clone();
                // Live overlay only while the record is not final; a final
                // record keeps its own recorded outcome.
                if !run.terminal {
                    overlay(&mut run, &s);
                }
            }
        }
        (run, text)
    }

    pub fn models(&self) -> Result<Vec<AllowedModel>, (&'static str, String)> {
        {
            let g = self.models.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((t, m)) = g.as_ref() {
                if t.elapsed() < Duration::from_secs(30) {
                    return Ok(m.clone());
                }
            }
        }
        let repo = self.cfg.repo_root.to_string_lossy().into_owned();
        let data = self.cfg.registry_data_root.to_string_lossy().into_owned();
        let info = pipeline::bridge(self, "target-info", &[&repo, &data], None).map_err(|e| {
            (
                "internal",
                format!("Registry target unavailable: {}", e.message),
            )
        })?;
        let s = |k: &str| {
            info.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        let m = AllowedModel {
            provider_id: s("providerId"),
            remote_model_id: s("remoteModelId"),
            logical_model_id: s("logicalModelId"),
            endpoint_kind: if s("endpointProtocol") == "https" {
                "provider".into()
            } else {
                "loopback-test-double".into()
            },
            output_limit_tokens: info
                .get("outputLimitTokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        };
        let mut list = vec![m];
        if !self.cfg.allow_models.is_empty() {
            list.retain(|m| {
                self.cfg
                    .allow_models
                    .iter()
                    .any(|(p, r)| *p == m.provider_id && *r == m.remote_model_id)
            });
        }
        *self.models.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((Instant::now(), list.clone()));
        Ok(list)
    }

    fn owned(&self, client: &str, run_id: &str) -> Result<RunRecord, (&'static str, String)> {
        match self.store.load(run_id) {
            Some(r) if r.run.client_id == client => Ok(r),
            // Same answer for "absent" and "someone else's": no existence leak.
            _ => Err(("not-found", "no such run".to_owned())),
        }
    }

    fn submit(self: &Arc<Self>, client: &str, params: &Value) -> CmdResult {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err(("broker-shutting-down", "the broker is shutting down".into()));
        }
        let intent = NexusIntentV1::parse(params.get("intent").unwrap_or(&Value::Null))
            .map_err(|e| (e.code, e.message))?;
        let digest = intent.payload_digest();
        // Idempotent replay first: it must never depend on current load.
        {
            let _g = self.store.lock();
            if let Some(id) = self.store.idem_lookup(client, &intent.idempotency_key) {
                if let Some(rec) = self.store.load(&id) {
                    if rec.payload_digest != digest {
                        return Err((
                            "idempotency-conflict",
                            "this idempotency key was already used with a different payload".into(),
                        ));
                    }
                    let (run, _) = self.view(&rec);
                    return Ok(json!({ "run": run, "replay": true }));
                }
            }
        }
        // Model selection is checked BEFORE a run exists: a wrong model
        // costs nothing and leaves no state.
        let available = self.models()?;
        if let Some(m) = &intent.model {
            if !self.cfg.allow_models.is_empty()
                && !self
                    .cfg
                    .allow_models
                    .iter()
                    .any(|(p, r)| *p == m.provider_id && *r == m.remote_model_id)
            {
                return Err((
                    "model-not-allowed",
                    "the broker does not allow this model".into(),
                ));
            }
            if !available
                .iter()
                .any(|a| a.provider_id == m.provider_id && a.remote_model_id == m.remote_model_id)
            {
                return Err((
                    "model-not-available",
                    "the Registry does not currently issue this provider/model".into(),
                ));
            }
        } else if available.is_empty() {
            return Err((
                "model-not-allowed",
                "no model is allowed for this broker".into(),
            ));
        }
        let run_id;
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _g = self.store.lock();
            // Re-check under the lock (two concurrent submits of one key).
            if let Some(id) = self.store.idem_lookup(client, &intent.idempotency_key) {
                if let Some(rec) = self.store.load(&id) {
                    if rec.payload_digest != digest {
                        return Err((
                            "idempotency-conflict",
                            "key reused with a different payload".into(),
                        ));
                    }
                    let (run, _) = self.view(&rec);
                    return Ok(json!({ "run": run, "replay": true }));
                }
            }
            let all = self.store.all();
            let now = now_ms();
            let recent = all
                .iter()
                .filter(|r| {
                    r.run.client_id == client && now.saturating_sub(r.run.created_at_ms) < 60_000
                })
                .count();
            if recent >= self.cfg.rate_per_minute {
                return Err(("rate-limited", "too many submissions; retry later".into()));
            }
            if all.iter().filter(|r| !r.run.terminal).count() >= self.cfg.max_active {
                return Err(("busy", "the broker is at its concurrent-run limit".into()));
            }
            run_id = format!("run_{}", rand_hex(16));
            let run = IntentRun {
                run_id: run_id.clone(),
                request_id: intent.request_id.clone(),
                client_id: client.to_owned(),
                state: "received".into(),
                terminal: false,
                intent_type: intent.intent_type.clone(),
                response_mode: match intent.response_mode {
                    nexus_contracts::intent::ResponseMode::Stream => "stream".into(),
                    nexus_contracts::intent::ResponseMode::Final => "final".into(),
                },
                created_at_ms: now,
                updated_at_ms: now,
                ..Default::default()
            };
            let rec = RunRecord {
                run,
                payload_digest: digest,
                idempotency_key: intent.idempotency_key.clone(),
            };
            // Record first, then the index: a crash between the two leaves
            // an unindexed record (recovered as abandoned), never a key that
            // points nowhere.
            self.store
                .put(&rec)
                .map_err(|e| ("internal", format!("cannot persist the run: {e}")))?;
            match self
                .store
                .idem_create(client, &intent.idempotency_key, &run_id)
            {
                Ok(true) => {}
                Ok(false) => return Err(("idempotency-conflict", "key already in use".into())),
                Err(e) => return Err(("internal", format!("cannot persist the key: {e}"))),
            }
        }
        self.cancel_flags
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(run_id.clone(), flag.clone());
        let b = Arc::clone(self);
        let rid = run_id.clone();
        let h = std::thread::spawn(move || pipeline::execute(b, rid, intent, flag));
        self.workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(h);
        let rec = self
            .store
            .load(&run_id)
            .ok_or(("internal", "run vanished".to_owned()))?;
        let (run, _) = self.view(&rec);
        Ok(json!({ "run": run, "replay": false }))
    }

    fn cancel(&self, client: &str, run_id: &str) -> CmdResult {
        let rec = self.owned(client, run_id)?;
        if rec.run.terminal {
            let (run, _) = self.view(&rec);
            return Ok(json!({ "run": run, "outcome": "already-terminal" }));
        }
        let already = rec.run.cancel_requested;
        self.update(run_id, |r| r.cancel_requested = true);
        if let Some(f) = self
            .cancel_flags
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(run_id)
        {
            f.store(true, Ordering::SeqCst);
        }
        if let Some(conv) = rec.run.conversation_id.clone() {
            let _ = nexus_client::request_model_cancel(&self.client_config(), &conv);
        }
        let rec = self
            .store
            .load(run_id)
            .ok_or(("internal", "run vanished".to_owned()))?;
        let (run, _) = self.view(&rec);
        Ok(
            json!({ "run": run, "outcome": if already { "already-requested" } else { "requested" } }),
        )
    }

    fn follow(&self, client: &str, params: &Value) -> CmdResult {
        let run_id = params.get("runId").and_then(|v| v.as_str()).unwrap_or("");
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let seen = params
            .get("stateSeen")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let wait = params
            .get("waitMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(2_000);
        let deadline = Instant::now() + Duration::from_millis(wait);
        loop {
            let rec = self.owned(client, run_id)?;
            let (run, text) = self.view(&rec);
            if offset > text.len() || !text.is_char_boundary(offset) {
                return Err((
                    "bad-offset",
                    "offset is beyond the text or inside a character".into(),
                ));
            }
            let changed = seen.as_deref().map(|s| s != run.state).unwrap_or(false);
            if text.len() > offset || run.terminal || changed || Instant::now() >= deadline {
                let mut end = (offset + MAX_FOLLOW_DELTA).min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                return Ok(json!({
                    "run": run, "textDelta": &text[offset..end], "nextOffset": end,
                }));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn handle(self: &Arc<Self>, client: &str, cmd: &str, params: &Value) -> CmdResult {
        let run_id = params.get("runId").and_then(|v| v.as_str()).unwrap_or("");
        match cmd {
            "intent-submit" => self.submit(client, params),
            "intent-status" => {
                let rec = self.owned(client, run_id)?;
                Ok(json!({ "run": self.view(&rec).0 }))
            }
            "intent-result" => {
                let rec = self.owned(client, run_id)?;
                let (run, text) = self.view(&rec);
                if !run.terminal {
                    return Err((
                        "not-terminal",
                        "the run has not finished; follow it or poll status".into(),
                    ));
                }
                Ok(json!({ "run": run, "text": text }))
            }
            "intent-follow" => self.follow(client, params),
            "intent-cancel" => self.cancel(client, run_id),
            "intent-list" => {
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(50)
                    .clamp(1, 100) as usize;
                let runs: Vec<IntentRun> = self
                    .store
                    .all()
                    .iter()
                    .filter(|r| r.run.client_id == client)
                    .take(limit)
                    .map(|r| self.view(r).0)
                    .collect();
                Ok(json!({ "runs": runs }))
            }
            "intent-conversation" => {
                // Read-only, per-run, ownership-authorized transcript page. The
                // client names a conversation id; the broker serves it ONLY if a
                // run owned by this client points at it. No path, no file.
                let conv = params
                    .get("conversationId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let owned = self.store.all().into_iter().any(|r| {
                    r.run.client_id == client && r.run.conversation_id.as_deref() == Some(conv)
                });
                if !owned {
                    return Err(("not-found", "no such run".to_owned()));
                }
                let n = |k: &str| params.get(k).and_then(|v| v.as_u64());
                let spec = nexus_transcript::PageSpec {
                    after_seq: n("afterSeq"),
                    before_seq: n("beforeSeq"),
                    limit: n("limit").unwrap_or(200).clamp(1, 200) as u32,
                };
                let view = nexus_client::conversation(&self.client_config(), conv, spec)
                    .map_err(|_| ("internal", "the conversation could not be read".to_owned()))?;
                Ok(json!({ "view": view }))
            }
            "intent-models" => Ok(json!({ "models": self.models()? })),
            "broker-health" => Ok(json!({ "ok": true, "clientId": client })),
            _ => Err((
                "unknown-command",
                "this broker serves intent verbs only".into(),
            )),
        }
    }
}

fn overlay(run: &mut IntentRun, s: &ModelRunStatus) {
    let mapped = match s.state.as_str() {
        "accepted" | "target-selected" | "authorized" => "executing",
        other => other,
    };
    run.state = mapped.to_owned();
    if is_terminal_state(mapped) {
        run.terminal = true;
    }
    run.endpoint_kind = s.endpoint_kind.clone().or(run.endpoint_kind.take());
    run.http_status = s.http_status;
    run.usage_input_tokens = s.usage_input_tokens;
    run.usage_output_tokens = s.usage_output_tokens;
    run.finish_reason = s.finish_reason.clone();
    run.latency_ms = s.latency_ms;
    run.first_token_ms = s.first_token_ms;
    run.provider_request_id = s.provider_request_id.clone();
    run.provider_response_id = s.provider_response_id.clone();
    run.error_code = s.error_code.clone().or(run.error_code.take());
    run.cancel_requested = run.cancel_requested || s.cancel_requested;
}

fn reply(id: &Value, r: CmdResult) -> Value {
    match r {
        Ok(v) => json!({ "protocol": 1, "id": id, "ok": true, "result": v }),
        Err((code, message)) => {
            json!({ "protocol": 1, "id": id, "ok": false, "code": code, "message": message })
        }
    }
}

fn serve_conn(b: Arc<Broker>, mut stream: UnixStream) {
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let uid = peer_uid(&stream);
    let me = unsafe { libc::geteuid() };
    let allowed: Vec<u32> = if b.cfg.allowed_uids.is_empty() {
        vec![me]
    } else {
        b.cfg.allowed_uids.clone()
    };
    let authorized = matches!(uid, Some(u) if allowed.contains(&u));
    // The peer UID is known BEFORE any byte is read: an unauthorized peer
    // gets a short fuse so it cannot hold connection slots.
    let _ = stream.set_read_timeout(Some(Duration::from_millis(if authorized {
        10_000
    } else {
        400
    })));
    let mut line = String::new();
    let mut rd = BufReader::new((&stream).take(MAX_FRAME));
    let n = rd.read_line(&mut line).unwrap_or(0);
    let out = if !authorized {
        reply(
            &Value::Null,
            Err((
                "unauthorized",
                "the connecting process UID is not authorized".into(),
            )),
        )
    } else if n == 0 {
        return;
    } else if !line.ends_with('\n') {
        reply(
            &Value::Null,
            Err((
                "bad-request",
                "request frame is missing its terminator or too large".into(),
            )),
        )
    } else {
        match serde_json::from_str::<Value>(&line) {
            Err(_) => reply(
                &Value::Null,
                Err(("bad-request", "request is not JSON".into())),
            ),
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let cmd = req.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                let params = req.get("params").cloned().unwrap_or(Value::Null);
                reply(
                    &id,
                    b.handle(&format!("uid:{}", uid.unwrap_or(u32::MAX)), cmd, &params),
                )
            }
        }
    };
    let _ = stream.write_all(format!("{out}\n").as_bytes());
}

pub struct BrokerHandle {
    pub broker: Arc<Broker>,
    accept: Option<std::thread::JoinHandle<()>>,
    socket: std::path::PathBuf,
}

impl BrokerHandle {
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// Stop accepting, cancel every running run through its normal path
    /// (executors observe the cancel marker), and join the workers.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.broker.shutdown.store(true, Ordering::SeqCst);
        let flags: Vec<(String, Arc<AtomicBool>)> = self
            .broker
            .cancel_flags
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (id, f) in flags {
            f.store(true, Ordering::SeqCst);
            if let Some(rec) = self.broker.store.load(&id) {
                if let Some(conv) = rec.run.conversation_id {
                    let _ = nexus_client::request_model_cancel(&self.broker.client_config(), &conv);
                }
            }
        }
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let hs: Vec<_> = self
                .broker
                .workers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .drain(..)
                .collect();
            if hs.is_empty() {
                break;
            }
            for h in hs {
                if Instant::now() < deadline {
                    let _ = h.join();
                }
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        if self.accept.is_some() {
            self.stop();
        }
    }
}

/// Startup recovery. NOTHING is resumed or resubmitted: a run that never
/// reached the executor is `abandoned` (nothing was sent); one whose
/// executor died is closed by the executor's own recovery (`uncertain` /
/// `refused`), exactly as `nexus model recover` does.
fn recover(b: &Broker) {
    let cfg = b.client_config();
    for rec in b.store.all() {
        if rec.run.terminal {
            continue;
        }
        let id = rec.run.run_id.clone();
        match rec.run.conversation_id.clone() {
            Some(conv) => {
                if let Ok(s) = nexus_client::recover_model_run(&cfg, &conv) {
                    let _g = b.store.lock();
                    if let Some(mut r) = b.store.load(&id) {
                        pipeline::apply_status(&mut r.run, &s);
                        r.run.updated_at_ms = now_ms();
                        let _ = b.store.put(&r);
                    }
                }
            }
            None => {
                let _g = b.store.lock();
                if let Some(mut r) = b.store.load(&id) {
                    r.run.state = "abandoned".into();
                    r.run.terminal = true;
                    r.run.error_code = Some("broker-restarted-before-submission".into());
                    r.run.error_message =
                        Some("the broker restarted before any provider submission; nothing was sent and nothing is resumed".into());
                    r.run.updated_at_ms = now_ms();
                    let _ = b.store.put(&r);
                }
            }
        }
    }
}

/// Start the broker. Refuses unless the daemon is a shadow-test daemon with
/// the model pilot enabled (which production-v1 forbids) and dispatch off.
pub fn start(cfg: BrokerConfig) -> Result<BrokerHandle, String> {
    use fs2::FileExt;
    use std::os::unix::fs::PermissionsExt;
    let store = Store::open(&cfg.state_dir).map_err(|e| format!("state dir: {e}"))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(cfg.state_dir.join("broker.lock"))
        .map_err(|e| format!("lock: {e}"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "another broker already owns this state directory".to_owned())?;
    crate::identity::write_instance(&cfg.state_dir)?;
    let node_abs = crate::trust::resolve_node(&cfg.node, &cfg.extra_trusted_owner_uids)?;
    crate::trust::check_bridge(&cfg.bridge_path(), &cfg.extra_trusted_owner_uids)?;
    let cap_hex = nexus_client::issuer::read_capability(&cfg.cap_path)
        .map_err(|e| format!("issuer capability: {}", e.message))?;
    // Daemon preconditions (read-only status, no authority needed).
    let cc = ClientConfig {
        socket_path: cfg.daemon_socket.clone(),
        ledger_dir: None,
        json: false,
        runs_dir: None,
        sessions_root: None,
        transcript_dir: cfg.transcript_dir.clone(),
    };
    let st = nexus_client::status(&cc).map_err(|e| format!("daemon unreachable: {}", e.message))?;
    if st.get("modelPilotEnabled") != Some(&Value::Bool(true)) {
        return Err("the daemon's model pilot is disabled (or the daemon runs production-v1): refusing to start".into());
    }
    if st.get("dispatchEnabled") != Some(&Value::Bool(false)) {
        return Err("the daemon reports dispatch enabled: refusing to start".into());
    }
    if st.get("trustMode").and_then(|v| v.as_str()) != Some("shadow-test") {
        return Err("the daemon is not in shadow-test trust mode: refusing to start".into());
    }
    std::fs::create_dir_all(&cfg.ledger_workspace)
        .and_then(|_| {
            std::fs::set_permissions(
                &cfg.ledger_workspace,
                std::fs::Permissions::from_mode(0o700),
            )
        })
        .map_err(|e| format!("intent ledger directory is unusable: {e}"))?;
    std::fs::create_dir_all(&cfg.transcript_dir)
        .map_err(|e| format!("transcript directory is unusable: {e}"))?;
    // Only ever replace a stale SOCKET: never delete another kind of file
    // (or follow a symlink) that happens to sit at the configured path.
    if let Ok(md) = std::fs::symlink_metadata(&cfg.socket_path) {
        use std::os::unix::fs::FileTypeExt;
        if !md.file_type().is_socket() {
            return Err(
                "the configured socket path exists and is not a socket; refusing to replace it"
                    .into(),
            );
        }
        if UnixStream::connect(&cfg.socket_path).is_ok() {
            return Err("a broker socket is already live at this path".into());
        }
        let _ = std::fs::remove_file(&cfg.socket_path);
    }
    // Bind under a restrictive umask so the socket is never briefly more
    // permissive than its final mode.
    let umask_val: libc::mode_t = if cfg.socket_group.is_some() {
        0o117
    } else {
        0o177
    };
    let old_umask = unsafe { libc::umask(umask_val) };
    let bound = UnixListener::bind(&cfg.socket_path);
    unsafe { libc::umask(old_umask) };
    let listener = bound.map_err(|e| format!("bind: {e}"))?;
    let mode = if cfg.socket_group.is_some() {
        0o660
    } else {
        0o600
    };
    std::fs::set_permissions(&cfg.socket_path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("socket mode: {e}"))?;
    if let Some(gid) = cfg.socket_group {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(cfg.socket_path.as_os_str().as_bytes())
            .map_err(|e| e.to_string())?;
        if unsafe { libc::chown(c.as_ptr(), u32::MAX, gid) } != 0 {
            return Err("cannot set the socket group".into());
        }
    }
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let socket = cfg.socket_path.clone();
    let broker = Arc::new(Broker {
        cfg,
        store,
        cap_hex,
        node_abs,
        cancel_flags: Mutex::new(HashMap::new()),
        bridge_lock: Mutex::new(()),
        shutdown: AtomicBool::new(false),
        conns: AtomicUsize::new(0),
        unauth_conns: AtomicUsize::new(0),
        workers: Mutex::new(Vec::new()),
        models: Mutex::new(None),
        _lock: lock,
    });
    recover(&broker);
    let b2 = Arc::clone(&broker);
    let accept = std::thread::spawn(move || {
        while !b2.shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((s, _)) => {
                    let _ = s.set_nonblocking(false);
                    // Unauthorized peers are served from a small, separate
                    // pool so they can never starve authorized clients.
                    let me = unsafe { libc::geteuid() };
                    let allowed: Vec<u32> = if b2.cfg.allowed_uids.is_empty() {
                        vec![me]
                    } else {
                        b2.cfg.allowed_uids.clone()
                    };
                    let ok = matches!(peer_uid(&s), Some(u) if allowed.contains(&u));
                    let (counter, cap) = if ok {
                        (&b2.conns, MAX_CONNECTIONS)
                    } else {
                        (&b2.unauth_conns, MAX_UNAUTH_CONNECTIONS)
                    };
                    if counter.fetch_add(1, Ordering::SeqCst) >= cap {
                        counter.fetch_sub(1, Ordering::SeqCst);
                        let mut s = s;
                        let _ = s.write_all(b"{\"protocol\":1,\"ok\":false,\"code\":\"busy\",\"message\":\"too many connections\"}\n");
                        continue;
                    }
                    let b3 = Arc::clone(&b2);
                    std::thread::spawn(move || {
                        serve_conn(Arc::clone(&b3), s);
                        if ok {
                            b3.conns.fetch_sub(1, Ordering::SeqCst);
                        } else {
                            b3.unauth_conns.fetch_sub(1, Ordering::SeqCst);
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(30));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    });
    Ok(BrokerHandle {
        broker,
        accept: Some(accept),
        socket,
    })
}
