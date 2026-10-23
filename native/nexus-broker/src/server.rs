//! Broker socket server and command handlers.
//!
//! Wire: one JSON object per line, `{protocol, id, cmd, params}`; replies
//! `{protocol, id, ok, result}` or `{protocol, id, ok:false, code, message}`.
//! The command set is closed; there is deliberately no verb that forwards a
//! daemon command, path, URL or shell.

use crate::config::BrokerConfig;
use crate::pipeline;
use crate::resolution;
use crate::store::{RunRecord, Store};
use nexus_client::intent_client::{AllowedModel, IntentRun, RegistryTarget};
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
const MAX_CONNECTIONS: usize = 128;
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
    "limit-reached",
    "rejected",
    "abandoned",
];

pub struct Broker {
    pub cfg: BrokerConfig,
    pub store: Store,
    /// A7.1: durable conversations over the run store.
    pub threads: crate::threads::ThreadStore,
    /// The daemon's issuer capability. A restarted daemon issues a new one; it is re-read
    /// from its file when the daemon stops accepting the one held here.
    pub(crate) cap_hex: std::sync::RwLock<String>,
    pub(crate) node_abs: std::path::PathBuf,
    /// EM-04C2 S1: the Governor worker allowance, derived from `cfg.max_active` (<= 16).
    pub(crate) worker_slots: Arc<crate::engine::worker_bridge::WorkerSlots>,
    pub(crate) cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(crate) bridge_lock: Mutex<()>,
    pub shutdown: AtomicBool,
    conns: AtomicUsize,
    unauth_conns: AtomicUsize,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    models: Mutex<Option<(Instant, Vec<AllowedModel>)>>,
    registry_targets: Mutex<Option<(Instant, Vec<RegistryTarget>)>>,
    /// Single-owner lock on the state directory, released explicitly when the broker is
    /// dropped (R-LOCK-1). Declared LAST so it is released after every other field.
    _lock: crate::state_lock::StateLock,
}

type CmdResult = Result<Value, (&'static str, String)>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Runs published only by their own loop (repo-inspect and repo-code).
fn is_agentic(intent_type: &str) -> bool {
    intent_type == nexus_contracts::intent::INTENT_REPO_INSPECT
        || intent_type == nexus_contracts::intent::INTENT_REPO_CODE
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

    /// EM-01: record the engine a (running) run is bound to. Set once, never on a final run.
    /// `false` when the binding could not be recorded (the caller fails closed).
    pub(crate) fn bind_engine(&self, run_id: &str, mode_id: &str, engine_id: &str) -> bool {
        let _g = self.store.lock();
        let Some(mut rec) = self.store.load(run_id) else {
            return false;
        };
        if rec.engine_id.is_some() {
            return rec.engine_id.as_deref() == Some(engine_id)
                && rec.engine_mode_id.as_deref() == Some(mode_id);
        }
        if rec.run.terminal {
            return false;
        }
        rec.engine_mode_id = Some(mode_id.to_owned());
        rec.engine_id = Some(engine_id.to_owned());
        self.store.put(&rec).is_ok()
    }

    /// EM-02: record the task binding a (running) run executes under. Set once; `false` when it
    /// cannot be recorded or another one is already recorded (the caller fails closed).
    pub(crate) fn bind_task_target(
        &self,
        run_id: &str,
        digest: &str,
        identity: &str,
        version: u32,
    ) -> bool {
        let _g = self.store.lock();
        let Some(mut rec) = self.store.load(run_id) else {
            return false;
        };
        if let Some(have) = &rec.task_binding_digest {
            return have == digest
                && rec.task_binding_identity.as_deref() == Some(identity)
                && rec.task_binding_identity_version == Some(version);
        }
        if rec.run.terminal {
            return false;
        }
        rec.task_binding_digest = Some(digest.to_owned());
        rec.task_binding_identity = Some(identity.to_owned());
        rec.task_binding_identity_version = Some(version);
        self.store.put(&rec).is_ok()
    }

    /// EM-04C1: record the tool catalog a (running) run is offered. Set once; `false` when it
    /// cannot be recorded or another catalog is already recorded (the caller fails closed).
    pub(crate) fn bind_tool_catalog(&self, run_id: &str, digest: &str) -> bool {
        let _g = self.store.lock();
        let Some(mut rec) = self.store.load(run_id) else {
            return false;
        };
        if let Some(have) = &rec.tool_catalog_digest {
            return have == digest;
        }
        if rec.run.terminal {
            return false;
        }
        rec.tool_catalog_digest = Some(digest.to_owned());
        self.store.put(&rec).is_ok()
    }

    /// EM-04C2 S10: record that the run's engine state now exists. `false` = it could not be
    /// recorded, and the run must not go on.
    pub(crate) fn mark_engine_state_started(&self, run_id: &str) -> bool {
        let _g = self.store.lock();
        let Some(mut rec) = self.store.load(run_id) else {
            return false;
        };
        if rec.engine_state_started == Some(true) {
            return true;
        }
        if rec.run.terminal {
            return false;
        }
        rec.engine_state_started = Some(true);
        self.store.put(&rec).is_ok()
    }

    /// Annotate a record that is already final (links between runs, what happened to its
    /// patch). Never changes its state, outcome or counters.
    pub fn annotate(&self, run_id: &str, f: impl FnOnce(&mut IntentRun)) {
        let _g = self.store.lock();
        if let Some(mut rec) = self.store.load(run_id) {
            f(&mut rec.run);
            let _ = self.store.put(&rec);
        }
    }

    /// The run for listings and status polls. A finished or agentic run needs no transcript
    /// or provider-status I/O to be described (the text is served by `intent-result` only),
    /// so a Desktop polling its history stays fast however long that history gets. The prompt
    /// preview is remembered on the record the first time it has to be read.
    pub(crate) fn view_light(&self, rec: &RunRecord) -> IntentRun {
        // The strict profile never keeps task text in its state directory (an audited
        // property); its listings keep the original, transcript-reading view.
        if !self.cfg.interactive || (!rec.run.terminal && !is_agentic(&rec.run.intent_type)) {
            return self.view(rec).0;
        }
        let mut run = rec.run.clone();
        if run.prompt_preview.is_none() {
            let preview: Option<String> = rec
                .prompt
                .as_ref()
                .map(|p| p.chars().take(160).collect())
                .or_else(|| {
                    let conv = run.conversation_id.as_ref()?;
                    let store =
                        nexus_transcript::TranscriptStore::open(&self.cfg.transcript_dir).ok()?;
                    let l = store.load(conv).ok()?;
                    l.events
                        .iter()
                        .find(|e| e.kind == nexus_transcript::EventKind::UserMessage)
                        .and_then(|e| e.text.clone())
                        .map(|t| t.chars().take(160).collect())
                });
            if let (Some(p), true) = (preview.clone(), run.terminal) {
                self.annotate(&run.run_id.clone(), move |r| r.prompt_preview = Some(p));
            }
            run.prompt_preview = preview;
        }
        run.coding_outcome = nexus_client::intent_client::derive_coding_outcome(&run);
        run
    }

    pub(crate) fn view(&self, rec: &RunRecord) -> (IntentRun, String) {
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
                // A repo-inspect run is published ONLY by its loop (the run
                // record is the single source of its state): a transcript
                // terminal written a moment before the record would otherwise
                // expose a finished run without its findings.
                if !run.terminal && !is_agentic(&run.intent_type) {
                    overlay(&mut run, &s);
                }
            }
        }
        // A5.5: a repo-inspect run streams progress through state and tool
        // events; its text is the final answer only. (Intermediate assistant
        // text resets each turn, which would break byte offsets.)
        if is_agentic(&run.intent_type) && !run.terminal {
            text.clear();
        }
        // A6.1.1: what the runtime verified (derived on read, so historical
        // records get it too); never from the model's text.
        run.coding_outcome = nexus_client::intent_client::derive_coding_outcome(&run);
        (run, text)
    }

    /// R-NATIVE-1 read-only Registry target catalog. The default model is
    /// the first issuable target in catalog order (bridge `target-info`
    /// order); every existing `AllowedModel` field keeps its meaning and
    /// the default model is unchanged. Extra fields are optional.
    pub fn registry_targets(&self) -> Result<Vec<RegistryTarget>, (&'static str, String)> {
        {
            let g = self
                .registry_targets
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some((t, m)) = g.as_ref() {
                if t.elapsed() < Duration::from_secs(30) {
                    return Ok(m.clone());
                }
            }
        }
        let repo = self.cfg.repo_root.to_string_lossy().into_owned();
        let data = self.cfg.registry_data_root.to_string_lossy().into_owned();
        let info = pipeline::bridge(self, "catalog", &[&repo, &data], None).map_err(|e| {
            (
                "internal",
                format!("Registry catalog unavailable: {}", e.message),
            )
        })?;
        let arr = info
            .get("targets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out: Vec<RegistryTarget> = Vec::new();
        for v in arr {
            let t: RegistryTarget = serde_json::from_value(v)
                .map_err(|e| ("internal", format!("Registry catalog shape: {e}")))?;
            out.push(t);
        }
        // No credential material ever crosses this boundary: assert identity
        // fields only (belt and braces; the bridge never emits them).
        let text = serde_json::to_string(&out)
            .unwrap_or_default()
            .to_lowercase();
        debug_assert!(!text.contains("credential"));
        debug_assert!(!text.contains("secret"));
        *self
            .registry_targets
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), out.clone()));
        Ok(out)
    }

    pub fn models(&self) -> Result<Vec<AllowedModel>, (&'static str, String)> {
        // R-NATIVE-1: unchanged default model (the saved-config main slot
        // via `target-info`); the wider catalog travels separately as
        // `targets` so existing clients keep their exact contract.
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

    /// The saved default (the engineering-v2 main slot) as a selection; `None` when unreadable.
    pub(crate) fn default_selection(&self) -> Option<nexus_contracts::intent::ModelSelection> {
        let m = self.models().ok()?.into_iter().next()?;
        Some(nexus_contracts::intent::ModelSelection {
            provider_id: m.provider_id,
            remote_model_id: m.remote_model_id,
            logical_model_id: Some(m.logical_model_id).filter(|l| !l.is_empty()),
            route_id: None,
            mode_id: None,
        })
    }

    /// The conversation's bound target identity, when any.
    pub(crate) fn conversation_target(
        &self,
        thread_id: &str,
    ) -> Option<crate::resolution::ResolvedTarget> {
        let th = self.threads.load(thread_id)?;
        let t = th.target?;
        Some(crate::resolution::ResolvedTarget {
            provider_id: t.provider_id,
            logical_model_id: t.logical_model_id,
            remote_model_id: t.remote_model_id,
            route_id: t.route_id,
            connection_id: t.connection_id,
            context_limit_tokens: t.context_limit_tokens.unwrap_or(0),
            output_limit_tokens: t.output_limit_tokens.unwrap_or(0),
            billing_tier: String::new(),
        })
    }

    fn owned(&self, client: &str, run_id: &str) -> Result<RunRecord, (&'static str, String)> {
        match self.store.load(run_id) {
            Some(r) if r.run.client_id == client => Ok(r),
            // Same answer for "absent" and "someone else's": no existence leak.
            _ => Err(("not-found", "no such run".to_owned())),
        }
    }

    fn submit(self: &Arc<Self>, client: &str, params: &Value) -> CmdResult {
        self.submit_with(client, params, None)
    }

    /// `continuation` is set only by the broker itself (never by a client): the run it
    /// continues, whose work is carried into the new run's working copy.
    fn submit_with(
        self: &Arc<Self>,
        client: &str,
        params: &Value,
        continuation: Option<&str>,
    ) -> CmdResult {
        self.submit_linked(client, params, continuation, None)
    }

    /// As `submit_with`, for a run that belongs to a conversation (A7.1): the link says
    /// which one, whether the request is read-only and which earlier run's copy to start from.
    pub(crate) fn submit_linked(
        self: &Arc<Self>,
        client: &str,
        params: &Value,
        continuation: Option<&str>,
        mut link: Option<crate::threads::ThreadLink>,
    ) -> CmdResult {
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
        // A5.5: the workspace is checked BEFORE a run exists as well.
        if let Some(w) = &intent.workspace_id {
            let allowed = if intent.intent_type == nexus_contracts::intent::INTENT_REPO_CODE {
                crate::inspect::code_sources_for(&self.cfg, client)
            } else {
                crate::inspect::workspaces_for(&self.cfg, client)
            };
            if !allowed.contains(w) {
                return Err((
                    "workspace-not-allowed",
                    "that workspace is not available to this client".into(),
                ));
            }
        }
        // R-NATIVE-2: one shared resolution before the run exists. Explicit
        // selection, else the conversation's target, else the default.
        // Refused before any run: unknown / non-issuable / ambiguous.
        let catalog = self.registry_targets().map_err(|(_, m)| ("internal", m))?;
        let conv_target: Option<resolution::ResolvedTarget> = link
            .as_ref()
            .and_then(|l| self.conversation_target(&l.thread_id));
        // no selection and no conversation target: the DEFAULT is the saved engineering-v2 slot
        // (`models()[0]`), not whichever issuable route sorts first in the catalog
        let default_sel = if intent.model.is_none() && conv_target.is_none() {
            self.default_selection()
        } else {
            None
        };
        let resolved = resolution::resolve_target(
            &catalog,
            intent.model.as_ref().or(default_sel.as_ref()),
            conv_target.as_ref(),
        )
        .map_err(|(c, m)| {
            let code: &'static str = match c.as_str() {
                "ambiguous-target" => "ambiguous-target",
                "model-not-allowed" => "model-not-allowed",
                _ => "model-not-available",
            };
            (code, m)
        })?;
        if !self.cfg.allow_models.is_empty()
            && !self
                .cfg
                .allow_models
                .iter()
                .any(|(p, r)| *p == resolved.provider_id && *r == resolved.remote_model_id)
        {
            return Err((
                "model-not-allowed",
                "the broker does not allow this model".into(),
            ));
        }
        if let Some(l) = link.as_mut() {
            l.resolved = Some(resolved.clone());
        }
        // Normalize the selection so the pipelines issue exactly this target. The client's
        // Engineering Mode choice (EM-04C2 S4) is carried unchanged: the Registry alone judges it.
        let mut intent = intent;
        let chosen_mode = intent.model.as_ref().and_then(|m| m.mode_id.clone());
        intent.model = Some(nexus_contracts::intent::ModelSelection {
            provider_id: resolved.provider_id.clone(),
            remote_model_id: resolved.remote_model_id.clone(),
            logical_model_id: Some(resolved.logical_model_id.clone()),
            route_id: Some(resolved.route_id.clone()),
            mode_id: chosen_mode,
        });
        let available_empty = catalog.iter().all(|t| !t.issuable);
        if available_empty {
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
                continuation_of: continuation.map(str::to_owned),
                thread_id: link.as_ref().map(|l| l.thread_id.clone()),
                read_only: link.as_ref().is_some_and(|l| l.read_only),
                seed_from: link.as_ref().and_then(|l| l.seed_from.clone()),
                workspace_relation: link.as_ref().and_then(|l| l.relation_hint.clone()),
                provider_id: Some(resolved.provider_id.clone()),
                remote_model_id: Some(resolved.remote_model_id.clone()),
                logical_model_id: Some(resolved.logical_model_id.clone()),
                route_id: Some(resolved.route_id.clone()),
                connection_id: resolved.connection_id.clone(),
                context_limit_tokens: Some(resolved.context_limit_tokens),
                output_limit_tokens: Some(resolved.output_limit_tokens),
                ..Default::default()
            };
            let rec = RunRecord {
                run,
                payload_digest: digest,
                idempotency_key: intent.idempotency_key.clone(),
                prompt: (intent.intent_type == nexus_contracts::intent::INTENT_REPO_CODE
                    && self.cfg.interactive)
                    .then(|| intent.content.clone()),
                engine_mode_id: None,
                engine_id: None,
                task_binding_digest: None,
                task_binding_identity: None,
                task_binding_identity_version: None,
                tool_catalog_digest: None,
                engine_state_started: Some(false),
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

    /// Continue an interrupted coding task: a NEW run on the same project whose working
    /// copy already holds the earlier run's changes, told what was done and asked to carry
    /// on. Never a replay: nothing the earlier run did is executed again.
    pub(crate) fn resume_run(
        self: &Arc<Self>,
        client: &str,
        old_id: &str,
        auto: bool,
    ) -> CmdResult {
        let old = self.owned(client, old_id)?;
        let r = &old.run;
        if !self.cfg.interactive || r.intent_type != nexus_contracts::intent::INTENT_REPO_CODE {
            return Err((
                "not-available",
                "only interactive coding runs can be continued".into(),
            ));
        }
        if !r.terminal || r.state == "completed" {
            return Err(("not-terminal", "this run is not an interrupted one".into()));
        }
        if let Some(n) = &r.continued_as {
            return Err((
                "already-continued",
                format!("this run was already continued as {n}"),
            ));
        }
        let (Some(task), Some(project), Some(_)) = (
            old.prompt.clone(),
            r.workspace_id.clone(),
            r.task_instance_id.clone(),
        ) else {
            return Err((
                "not-available",
                "this run kept no task text or working copy".into(),
            ));
        };
        if auto && (r.cancel_requested || r.tool_activity.is_empty()) {
            return Err(("not-available", "nothing to continue".into()));
        }
        // a chain of continuations is bounded: a task that keeps dying is reported, not looped
        let mut depth = 0;
        let mut cur = r.continuation_of.clone();
        while let Some(p) = cur {
            depth += 1;
            cur = self.store.load(&p).and_then(|x| x.run.continuation_of);
        }
        if auto && depth >= 3 {
            return Err((
                "not-available",
                "this task was already continued three times".into(),
            ));
        }
        if let Some(tid) = &r.thread_id {
            if !crate::threads::may_continue(self, tid, old_id) {
                return Err((
                    "not-available",
                    "a newer request in this conversation superseded this run".into(),
                ));
            }
        }
        // EM-02: the continuation runs on the SAME model and route as the interrupted run, never on
        // whatever the Registry's default is now; the new task's binding is then checked against
        // the interrupted run's (model, route, connection, endpoint, credential, default effort).
        let (Some(provider_id), Some(remote_model_id), Some(logical), Some(route)) = (
            r.provider_id.clone(),
            r.remote_model_id.clone(),
            r.logical_model_id.clone(),
            r.route_id.clone(),
        ) else {
            return Err((
                "not-available",
                "the interrupted run's model and route are not recorded; it cannot be continued on the same target".into(),
            ));
        };
        let model = nexus_contracts::intent::ModelSelection {
            provider_id,
            remote_model_id,
            logical_model_id: Some(logical),
            route_id: Some(route),
            // a continuation is issued in the Engineering Mode of the run it continues (the
            // default mode is the absence of a choice, exactly as before)
            mode_id: old.engine_mode_id.clone().filter(|m| m != "engineering-v2"),
        };
        let why = r.error_code.clone().unwrap_or_else(|| r.state.clone());
        let done = crate::inspect::receipts_summary(&r.tool_activity);
        let content = format!(
            "{task}\n\n---\nHARNESS NOTE: this task is being CONTINUED after an interruption ({why}). The working copy already contains the changes made so far; do not redo finished work. First check the current state (read the files you changed, re-run the tests), then carry on until the task is complete and verified.\n\nWhat had been done before the interruption:\n{done}\n"
        );
        let intent = NexusIntentV1 {
            schema_version: 1,
            request_id: format!("resume-{}", rand_hex(8)),
            idempotency_key: format!("resume-{old_id}"),
            intent_type: nexus_contracts::intent::INTENT_REPO_CODE.to_owned(),
            content,
            model: Some(model),
            workspace_id: Some(project),
            limits: self
                .cfg
                .code_caps
                .with_user_limits(&self.cfg.state_dir)
                .effective(true)
                .to_intent_limits(),
            response_mode: nexus_contracts::intent::ResponseMode::Stream,
            client_label: Some("nexus-continuation".to_owned()),
        };
        let params = json!({ "intent": serde_json::to_value(&intent).unwrap_or_default() });
        let link = r.thread_id.clone().map(|t| crate::threads::ThreadLink {
            thread_id: t,
            read_only: r.read_only,
            seed_from: None,
            relation_hint: None,
            resolved: None,
        });
        let out = self.submit_linked(&r.client_id.clone(), &params, Some(old_id), link)?;
        if let Some(new_id) = out.pointer("/run/runId").and_then(|v| v.as_str()) {
            let n = new_id.to_owned();
            self.annotate(old_id, |x| x.continued_as = Some(n.clone()));
            if let Some(t) = &r.thread_id {
                crate::threads::attach_continuation(self, t, new_id, old_id);
            }
        }
        Ok(out)
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

    /// The reviewable change set of one of THIS client's repo-code runs, read
    /// by the daemon from the isolated working copy (the broker never opens it).
    fn diff(&self, client: &str, run_id: &str) -> CmdResult {
        let rec = self.owned(client, run_id)?;
        if rec.run.intent_type != nexus_contracts::intent::INTENT_REPO_CODE {
            return Err(("not-found", "this run has no working copy".into()));
        }
        let task = rec
            .run
            .task_instance_id
            .clone()
            .ok_or(("not-found", "this run has no working copy yet".to_owned()))?;
        let resp = pipeline::daemon(self, "worktree-diff", json!({ "taskInstanceId": task }))
            .map_err(|e| {
                (
                    "internal",
                    format!("the change set could not be read ({})", e.code),
                )
            })?;
        let d = resp.get("diff").cloned().unwrap_or_default();
        let (run, _) = self.view(&rec);
        Ok(json!({
            "run": run,
            "baseCommit": d.get("baseCommit").cloned().unwrap_or_default(),
            "files": d.get("files").cloned().unwrap_or_default(),
            "filesTruncated": d.get("filesTruncated").cloned().unwrap_or(Value::Bool(false)),
            "diff": d.get("diff").cloned().unwrap_or_default(),
            "diffDigest": d.get("diffDigest").cloned().unwrap_or_default(),
            "diffTruncated": d.get("diffTruncated").cloned().unwrap_or(Value::Bool(false)),
        }))
    }

    /// Read-only facts about the retained isolated working copy of one of THIS
    /// client's runs (A6.1.3). Never a path; ownership-checked like the diff.
    fn copy_info(&self, client: &str, run_id: &str) -> CmdResult {
        let rec = self.owned(client, run_id)?;
        if rec.run.intent_type != nexus_contracts::intent::INTENT_REPO_CODE {
            return Err(("not-found", "this run has no working copy".into()));
        }
        let task = rec
            .run
            .task_instance_id
            .clone()
            .ok_or(("not-found", "this run has no working copy yet".to_owned()))?;
        let resp = pipeline::daemon(self, "worktree-stat", json!({ "taskInstanceId": task }))
            .map_err(|e| {
                (
                    "internal",
                    format!("the working copy could not be inspected ({})", e.code),
                )
            })?;
        let copy = resp.get("copy").cloned().unwrap_or(Value::Null);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let created = copy.get("createdAtMs").and_then(|v| v.as_u64());
        Ok(json!({
            "retained": resp.get("retained").cloned().unwrap_or(Value::Bool(false)),
            "active": !rec.run.terminal,
            "projectId": rec.run.workspace_id,
            "baseCommit": rec.run.worktree_commit,
            "ageMs": created.map(|c| now.saturating_sub(c)),
            "approxBytes": copy.get("approxBytes").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Apply a finished run's patch to the user's ORIGINAL folder. Only reachable from the
    /// native backend after a native confirmation; ownership-checked; all-or-nothing;
    /// refuses a changed folder or a refreshed project; audited.
    pub(crate) fn project_adopt(&self, client: &str, run_id: &str) -> CmdResult {
        let env = self.cfg.project_env().ok_or((
            "not-available",
            "this broker cannot adopt patches".to_owned(),
        ))?;
        let rec = self.owned(client, run_id)?;
        if rec.run.intent_type != nexus_contracts::intent::INTENT_REPO_CODE || !rec.run.terminal {
            return Err(("not-ready", "only a finished coding run has a patch".into()));
        }
        let (ws, task) = match (
            rec.run.workspace_id.clone(),
            rec.run.task_instance_id.clone(),
        ) {
            (Some(w), Some(t)) => (w, t),
            _ => return Err(("not-found", "this run has no working copy".into())),
        };
        let reg = nexus_tools::registry::load(env.registry_dir, env.trust)
            .map_err(|e| ("registry", e.to_string()))?;
        let p = reg
            .get(&ws)
            .filter(|p| p.managed)
            .ok_or((
                "not-adoptable",
                "only projects opened in Nexus can receive a patch automatically".to_owned(),
            ))?
            .clone();
        if rec.run.worktree_commit.as_deref() != Some(p.pinned_commit.as_str()) {
            return Err((
                "project-refreshed",
                "the project was refreshed after this run; copy the patch and apply it by hand"
                    .into(),
            ));
        }
        let (origin, fp) = (
            p.origin.clone().unwrap_or_default(),
            p.snapshot_fingerprint.clone().unwrap_or_default(),
        );
        let resp = pipeline::daemon(self, "worktree-diff", json!({ "taskInstanceId": task }))
            .map_err(|e| {
                (
                    "internal",
                    format!("the change set could not be read ({})", e.code),
                )
            })?;
        let d = resp.get("diff").cloned().unwrap_or_default();
        if d.get("diffTruncated") == Some(&Value::Bool(true)) {
            return Err((
                "too-large",
                "the patch is too large to apply automatically; export it with the operator tools"
                    .into(),
            ));
        }
        let text = d.get("diff").and_then(|v| v.as_str()).unwrap_or("");
        let files = nexus_tools::snapshot::apply_patch(
            std::path::Path::new(&origin),
            &fp,
            text,
            &nexus_tools::snapshot::SnapshotLimits::default(),
        )
        .map_err(|e| ("adopt-refused", e.to_string()))?;
        crate::consent::audit(
            &self.cfg.state_dir,
            json!({"atMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                   "kind": "patch-adopted", "runId": run_id, "project": ws, "files": files,
                   "diffDigest": d.get("diffDigest"), "client": client}),
        );
        Ok(json!({ "applied": files }))
    }

    fn project_verb(&self, cmd: &str, params: &Value) -> CmdResult {
        let env = self.cfg.project_env().ok_or((
            "not-available",
            "this broker cannot open projects (not in the interactive profile)".to_owned(),
        ))?;
        let s = |k: &str| params.get(k).and_then(|v| v.as_str()).unwrap_or("");
        match cmd {
            "project-open" => crate::projects::open(&env, s("path")),
            "project-list" => crate::projects::list(
                &env,
                params
                    .get("changes")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            ),
            "project-forget" => crate::projects::forget(&env, s("projectId")),
            "project-policy" => crate::projects::set_policy(
                &env,
                s("projectId"),
                params.get("installs").and_then(|v| v.as_bool()),
                params.get("trusted").and_then(|v| v.as_bool()),
            ),
            _ => {
                // refresh = re-open the recorded origin folder (re-validated)
                let f = nexus_tools::registry::load(env.registry_dir, env.trust)
                    .map_err(|e| ("registry", e.to_string()))?;
                let p = f
                    .get(s("projectId"))
                    .ok_or(("not-found", "no such project".to_owned()))?;
                let origin = p
                    .origin
                    .clone()
                    .ok_or(("not-found", "that project has no origin folder".to_owned()))?;
                crate::projects::open(&env, &origin)
            }
        }
    }

    /// The consent the user has given (if any) plus the exact text a new consent
    /// must present. Interactive profile only.
    fn consent_status(&self) -> CmdResult {
        if !self.cfg.interactive {
            return Ok(json!({ "interactive": false }));
        }
        // before the provider is connected there is no verified route yet: say so
        // instead of failing (the Desktop then shows the connection step)
        let not_ready = json!({ "interactive": true, "providerReady": false, "consent": null });
        let Ok(m) = self.models() else {
            return Ok(not_ready);
        };
        let Some(first) = m.first() else {
            return Ok(not_ready);
        };
        let text = crate::consent::consent_text(&first.provider_id, &first.remote_model_id);
        Ok(json!({
            "interactive": true,
            "providerId": first.provider_id, "remoteModelId": first.remote_model_id,
            "endpointKind": first.endpoint_kind,
            "text": text, "textSha256": crate::live_auth::prompt_digest(&text),
            "consent": crate::consent::status(&self.cfg.state_dir),
        }))
    }

    fn consent_grant(&self, client: &str, params: &Value) -> CmdResult {
        if !self.cfg.interactive {
            return Err((
                "not-available",
                "this broker is not in the interactive profile".into(),
            ));
        }
        let s = |k: &str| {
            params
                .get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        let m = self.models()?;
        let (p, r) = (s("providerId"), s("remoteModelId"));
        if !m
            .iter()
            .any(|x| x.provider_id == p && x.remote_model_id == r)
        {
            return Err((
                "bad-request",
                "that provider/model is not configured".into(),
            ));
        }
        let kinds: Vec<String> = params
            .get("intentTypes")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_else(|| vec!["repo-code".to_owned(), "repo-inspect".to_owned()]);
        crate::consent::grant(
            &self.cfg.state_dir,
            &p,
            &r,
            &kinds,
            &s("textSha256"),
            client,
        )
        .map(|c| json!({ "consent": c }))
        .map_err(|e| ("bad-request", e))
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
            "intent-resume" => self.resume_run(client, run_id, false),
            "intent-status" => {
                let rec = self.owned(client, run_id)?;
                Ok(json!({ "run": self.view_light(&rec) }))
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
                    .map(|r| self.view_light(r))
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
            "thread-send" => crate::threads::send(self, client, params),
            "thread-list" => crate::threads::list(self, client, params),
            "thread-get" => crate::threads::get(self, client, params),
            "thread-create" => crate::threads::create(self, client, params),
            "thread-update" => crate::threads::update(self, client, params),
            "intent-models" => {
                Ok(json!({ "models": self.models()?, "targets": self.registry_targets()? }))
            }
            "intent-code-sources" => Ok(json!({
                // identities plus the operator's read-only restrictions (never a path)
                "sources": crate::inspect::code_sources_for(&self.cfg, client)
                    .into_iter()
                    .map(|id| {
                        let pool = self.cfg.effective_code_sources();
                        let spec = pool.iter().find(|w| w.id == id);
                        let mut v = json!({ "sourceId": id });
                        if let Some((dir, trust)) = &self.cfg.project_registry {
                            if let Some(r) = nexus_tools::registry::load(dir, trust)
                                .ok()
                                .and_then(|f| f.get(&id).cloned())
                            {
                                v["label"] = json!(r.label.clone().unwrap_or_else(|| r.id.clone()));
                                v["managed"] = json!(r.managed);
                                v["kinds"] = json!(r.kinds);
                            }
                        }
                        if let Some(c) = spec.and_then(|w| w.pinned_commit.as_ref()) {
                            v["pinnedCommit"] = json!(c);
                        }
                        if let Some(w) = spec.filter(|w| !w.write_allow.is_empty()) {
                            v["writeAllow"] = json!(w.write_allow);
                        }
                        v
                    })
                    .collect::<Vec<_>>(),
            })),
            "intent-diff" => self.diff(client, run_id),
            "intent-copy" => self.copy_info(client, run_id),
            "project-open" | "project-list" | "project-forget" | "project-refresh"
            | "project-policy" => self.project_verb(cmd, params),
            "project-adopt" => self.project_adopt(client, run_id),
            "provider-consent-status" => self.consent_status(),
            "provider-consent-grant" => self.consent_grant(client, params),
            "provider-consent-revoke" => {
                if !self.cfg.interactive {
                    return Err((
                        "not-available",
                        "this broker is not in the interactive profile".into(),
                    ));
                }
                Ok(json!({ "revoked": crate::consent::revoke(&self.cfg.state_dir, client) }))
            }
            "intent-limits-set" => {
                // The user's own, LOWER limits (Settings). Each field is optional; null or
                // absent resets it. Values are clamped to 1..=the built-in maximum.
                let base = self.cfg.code_caps.effective(self.cfg.interactive);
                let mut out = serde_json::Map::new();
                for (k, max) in [
                    ("maxTurns", u64::from(base.max_turns)),
                    ("maxToolCalls", u64::from(base.max_tool_calls)),
                    ("maxEdits", u64::from(base.max_edits)),
                    ("maxTests", u64::from(base.max_tests)),
                    ("maxRuntimeSecs", base.max_runtime_secs),
                ] {
                    if let Some(n) = params.get(k).and_then(|v| v.as_u64()) {
                        out.insert(k.to_owned(), json!(n.clamp(1, max)));
                    }
                }
                let path = self.cfg.state_dir.join(crate::config::USER_LIMITS_FILE);
                if out.is_empty() {
                    let _ = std::fs::remove_file(&path);
                } else {
                    std::fs::write(&path, serde_json::Value::Object(out).to_string())
                        .map_err(|e| ("internal", format!("cannot save limits: {e}")))?;
                }
                Ok(json!({
                    "limits": self.cfg.code_caps.with_user_limits(&self.cfg.state_dir).effective(self.cfg.interactive),
                    "builtIn": base,
                }))
            }
            "intent-code-config" => Ok(json!({
                "builtIn": self.cfg.code_caps.effective(self.cfg.interactive),
                "limits": self
                    .cfg
                    .code_caps
                    .with_user_limits(&self.cfg.state_dir)
                    .effective(self.cfg.interactive),
                "approvalLifetimeSecs": self
                    .cfg
                    .approval_ttl_ms
                    .unwrap_or(crate::code::APPROVAL_TTL_MS)
                    .clamp(1_000, crate::code::APPROVAL_TTL_MS)
                    / 1000,
            })),
            "intent-workspaces" => Ok(json!({
                "workspaces": crate::inspect::workspaces_for(&self.cfg, client)
                    .into_iter()
                    .map(|id| json!({ "workspaceId": id }))
                    .collect::<Vec<_>>(),
            })),
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
                        if r.run.intent_type == nexus_contracts::intent::INTENT_REPO_CODE {
                            r.run.pending_approval = None;
                            if let Some(ti) = r.run.task_instance_id.clone() {
                                let rc = crate::code::recover_code_run(
                                    b,
                                    r.run.task_id.as_deref(),
                                    &ti,
                                    r.run.turn,
                                );
                                if !rc.uncertain.is_empty() {
                                    // A write/process was in flight: its outcome is
                                    // UNKNOWN. Never assume failure or success.
                                    r.run.state = "uncertain".into();
                                    r.run.terminal = true;
                                    r.run.error_code = Some("tool-outcome-uncertain".into());
                                    r.run.error_message = Some(format!(
                                        "the broker restarted while {} was running; its effect is unknown. Nothing was repeated and no approval remains usable. Review `nexus intent diff {}` and re-verify before trusting the working copy",
                                        rc.uncertain.join(", "),
                                        r.run.run_id
                                    ));
                                }
                            }
                        }
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
pub fn start(mut cfg: BrokerConfig) -> Result<BrokerHandle, String> {
    use std::os::unix::fs::PermissionsExt;
    let store = Store::open(&cfg.state_dir).map_err(|e| format!("state dir: {e}"))?;
    let threads = crate::threads::ThreadStore::open(&cfg.state_dir)
        .map_err(|e| format!("conversation store: {e}"))?;
    let lock = crate::state_lock::StateLock::acquire(&cfg.state_dir)?;
    cfg.code_caps.validate(cfg.interactive)?;
    if cfg.project_registry.is_some() && !cfg.code_sources.is_empty() {
        return Err("--project-registry and --code-source are mutually exclusive".into());
    }
    if let Some((dir, trust)) = &cfg.project_registry {
        nexus_tools::registry::load(dir, trust)
            .map_err(|e| format!("project registry refused: {e}"))?;
    }
    let (workspaces, code_sources) = crate::inspect::validate_code_sources(&cfg)?;
    cfg.workspaces = workspaces;
    cfg.code_sources = code_sources;
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
    // Bind inside a private (0700) scratch directory, fix the mode there, then
    // rename into place: the socket is never reachable at its final path with
    // a looser mode, and no PROCESS-WIDE umask is touched (a temporary umask
    // races every other thread's file creation, which made unrelated
    // directories appear with mode 0600 whenever brokers started concurrently).
    use std::os::unix::fs::DirBuilderExt;
    let parent = cfg
        .socket_path
        .parent()
        .ok_or_else(|| "socket path has no parent directory".to_owned())?;
    let scratch = parent.join(format!(
        ".nexus-bind-{}-{}",
        std::process::id(),
        rand_hex(6)
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&scratch)
        .map_err(|e| format!("bind scratch: {e}"))?;
    let tmp_sock = scratch.join("s");
    let mode = if cfg.socket_group.is_some() {
        0o660
    } else {
        0o600
    };
    let setup = (|| -> Result<UnixListener, String> {
        let listener = UnixListener::bind(&tmp_sock).map_err(|e| format!("bind: {e}"))?;
        std::fs::set_permissions(&tmp_sock, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("socket mode: {e}"))?;
        if let Some(gid) = cfg.socket_group {
            use std::os::unix::ffi::OsStrExt;
            let c = std::ffi::CString::new(tmp_sock.as_os_str().as_bytes())
                .map_err(|e| e.to_string())?;
            if unsafe { libc::chown(c.as_ptr(), u32::MAX, gid) } != 0 {
                return Err("cannot set the socket group".into());
            }
        }
        std::fs::rename(&tmp_sock, &cfg.socket_path).map_err(|e| format!("socket publish: {e}"))?;
        Ok(listener)
    })();
    let _ = std::fs::remove_file(&tmp_sock);
    let _ = std::fs::remove_dir(&scratch);
    let listener = setup?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let socket = cfg.socket_path.clone();
    let cfg_max_active = cfg.max_active;
    let broker = Arc::new(Broker {
        cfg,
        store,
        threads,
        cap_hex: std::sync::RwLock::new(cap_hex),
        node_abs,
        worker_slots: Arc::new(crate::engine::worker_bridge::WorkerSlots::for_max_active(
            cfg_max_active,
        )),
        cancel_flags: Mutex::new(HashMap::new()),
        bridge_lock: Mutex::new(()),
        shutdown: AtomicBool::new(false),
        conns: AtomicUsize::new(0),
        unauth_conns: AtomicUsize::new(0),
        workers: Mutex::new(Vec::new()),
        models: Mutex::new(None),
        registry_targets: Mutex::new(None),
        _lock: lock,
    });
    let interrupted: Vec<String> = broker
        .store
        .all()
        .into_iter()
        .filter(|r| !r.run.terminal)
        .map(|r| r.run.run_id)
        .collect();
    recover(&broker);
    crate::threads::startup(&broker);
    if broker.cfg.interactive && !interrupted.is_empty() {
        // Autonomy: work that was running when the runtime went down is continued, not
        // abandoned. Runs the user cancelled, or that made no progress, are left alone.
        let b3 = Arc::clone(&broker);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            for id in interrupted {
                let Some(rec) = b3.store.load(&id) else {
                    continue;
                };
                if !rec.run.terminal || rec.run.state == "completed" {
                    continue;
                }
                for _ in 0..30 {
                    match b3.resume_run(&rec.run.client_id.clone(), &id, true) {
                        Err((c, _)) if c == "busy" || c == "rate-limited" => {
                            std::thread::sleep(std::time::Duration::from_secs(20));
                        }
                        _ => break,
                    }
                }
            }
        });
    }
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
