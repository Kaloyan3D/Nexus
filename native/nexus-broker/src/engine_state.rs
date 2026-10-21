//! EM-03: durable, task-owned Engineering Mode state.
//!
//! The broker (the Core's run owner) is the ONLY writer. Engines propose; `EngineHost`
//! validates; this store makes an accepted state durable before any of its effects (a model
//! attempt, guidance sent to the model, the end of the run). One record per task generation:
//! `<state_dir>/engine/<taskInstanceId>.json`, written atomically (temp file, fsync, rename,
//! directory fsync) and authenticated with HMAC-SHA256 under a broker-local key
//! (`<state_dir>/engine-state.key`, 0600, created once). Records are bounded; they hold no model
//! text, prompts or secrets (engines persist digests, see `EngineExtension::persist_state`).
//!
//! What is persisted per record: task generation, run, mode and engine identity, engine contract
//! and state schema, the EM-02 task-binding digest, the default effort, the monotonic state
//! revision, the last accepted proposal id (ids are contiguous, so every id <= it is a replay),
//! the effort selection in force, the attempts with the target each executed, the continuation
//! lineage, the engine payload and a bounded event history.
//!
//! Failure is explicit: a record that cannot be written stops the run before its next effect
//! (`engine-state-unpersisted`); a record that cannot be authenticated, parsed, or does not belong
//! to the task/engine/mode it is loaded for is refused (`engine-state-*`), never reinterpreted.

use crate::engine::EffortSelection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const RECORD_SCHEMA: u32 = 1;
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_EVENTS: usize = 64;
pub const MAX_ATTEMPTS: usize = 32;
const KEY_FILE: &str = "engine-state.key";

/// A refused load or a failed write; the caller fails closed with `code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> StateError {
    StateError {
        code,
        message: message.into(),
    }
}

/// One model attempt and the target it executed (write-ahead: recorded before dispatch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptRecord {
    pub ordinal: u32,
    pub attempt_id: String,
    pub effort: String,
    pub issuance_id: String,
    pub extension_digest: String,
    /// `bound` (durable before dispatch), then `answered` / `uncertain` / `failed`.
    pub state: String,
}

/// How a continuation's record relates to the interrupted run's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lineage {
    pub predecessor_run: String,
    pub predecessor_task: Option<String>,
    pub predecessor_revision: Option<u64>,
    /// Payload carried over (only for engines that declare `inherits_state`).
    pub inherited: bool,
    /// The rule applied: `inherited`, `fresh-engine-does-not-inherit`, `pre-em03-no-state`.
    pub rule: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineEvent {
    pub seq: u64,
    pub kind: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineStateRecord {
    pub schema_version: u32,
    pub run_id: String,
    pub task_instance_id: String,
    pub mode_id: String,
    pub engine_id: String,
    pub engine_contract: u32,
    pub state_schema: u32,
    pub task_binding_digest: String,
    pub default_effort: String,
    pub revision: u64,
    pub last_proposal_id: u64,
    pub effort: Option<EffortSelection>,
    pub payload: Value,
    pub attempts: Vec<AttemptRecord>,
    pub lineage: Option<Lineage>,
    pub events: Vec<EngineEvent>,
    pub next_event_seq: u64,
    #[serde(default)]
    pub mac: String,
}

impl EngineStateRecord {
    /// Append one event (bounded history: the oldest is dropped; `seq` stays monotonic).
    pub fn event(
        &mut self,
        kind: &str,
        proposal_id: Option<u64>,
        attempt: Option<u32>,
        effort: Option<&str>,
        detail: Option<&str>,
    ) {
        self.events.push(EngineEvent {
            seq: self.next_event_seq,
            kind: kind.to_owned(),
            revision: self.revision,
            proposal_id,
            attempt,
            effort: effort.map(str::to_owned),
            detail: detail.map(|d| d.chars().take(200).collect()),
        });
        self.next_event_seq += 1;
        if self.events.len() > MAX_EVENTS {
            let drop = self.events.len() - MAX_EVENTS;
            self.events.drain(..drop);
        }
    }

    /// Record (or update) attempt `ordinal` (bounded: the oldest is dropped).
    pub fn attempt(&mut self, a: AttemptRecord) {
        if let Some(x) = self.attempts.iter_mut().find(|x| x.ordinal == a.ordinal) {
            *x = a;
        } else {
            self.attempts.push(a);
        }
        if self.attempts.len() > MAX_ATTEMPTS {
            let drop = self.attempts.len() - MAX_ATTEMPTS;
            self.attempts.drain(..drop);
        }
    }

    pub fn set_attempt_state(&mut self, ordinal: u32, state: &str) {
        if let Some(x) = self.attempts.iter_mut().find(|x| x.ordinal == ordinal) {
            x.state = state.to_owned();
        }
    }

    fn mac_input(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.remove("mac");
        }
        nexus_contracts::canonical_json(&v)
    }

    /// Digest of the authenticated content (what a successor records as its lineage anchor).
    pub fn content_digest(&self) -> String {
        nexus_contracts::sha256_hex(&self.mac_input())
    }
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
        && !id.starts_with('.')
}

/// The broker's engine state store (one per state directory).
pub struct EngineStateStore {
    dir: PathBuf,
    key: [u8; 32],
}

impl EngineStateStore {
    /// Open (creating the directory and the key on first use). The key is never regenerated: a
    /// lost or replaced key makes every existing record unauthenticated (fail closed).
    pub fn open(state_dir: &Path) -> Result<Self, StateError> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        let dir = state_dir.join("engine");
        let dir_existed = dir.is_dir();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| {
                err(
                    "engine-state-unpersisted",
                    format!("engine state directory: {e}"),
                )
            })?;
        if !dir_existed {
            // the new directory entry itself must survive a power loss
            fsync_dir(state_dir).map_err(|e| {
                err(
                    "engine-state-unpersisted",
                    format!("engine state directory: {e}"),
                )
            })?;
        }
        let key_path = state_dir.join(KEY_FILE);
        let key_hex = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&key_path)
        {
            Ok(mut f) => {
                let md = f
                    .metadata()
                    .map_err(|e| err("engine-state-unauthenticated", e.to_string()))?;
                use std::os::unix::fs::MetadataExt;
                if !md.is_file()
                    || md.permissions().mode() & 0o077 != 0
                    || md.uid() != unsafe { libc::geteuid() }
                {
                    return Err(err(
                        "engine-state-unauthenticated",
                        "the engine state key is not a private (0600) regular file owned by this broker",
                    ));
                }
                let mut s = String::new();
                f.read_to_string(&mut s)
                    .map_err(|e| err("engine-state-unauthenticated", e.to_string()))?;
                s.trim().to_owned()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A key is created only for a state root WITHOUT engine records. Records without
                // their key mean the key was lost or removed: refuse instead of silently minting a
                // new key that would orphan them.
                let has_records = std::fs::read_dir(&dir)
                    .map(|rd| {
                        rd.flatten()
                            .any(|e| e.file_name().to_string_lossy().ends_with(".json"))
                    })
                    .unwrap_or(true);
                if has_records {
                    return Err(err(
                        "engine-state-unauthenticated",
                        "engine state records exist but their key is missing; refusing to create a new key",
                    ));
                }
                let mut b = [0u8; 32];
                std::fs::File::open("/dev/urandom")
                    .and_then(|mut f| f.read_exact(&mut b))
                    .map_err(|e| {
                        err(
                            "engine-state-unpersisted",
                            format!("no randomness for the engine state key: {e}"),
                        )
                    })?;
                let hex_key = hex::encode(b);
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&key_path)
                    .map_err(|e| {
                        err("engine-state-unpersisted", format!("engine state key: {e}"))
                    })?;
                f.write_all(hex_key.as_bytes())
                    .and_then(|_| f.sync_all())
                    .and_then(|_| fsync_dir(state_dir))
                    .map_err(|e| {
                        err("engine-state-unpersisted", format!("engine state key: {e}"))
                    })?;
                hex_key
            }
            Err(e) => {
                return Err(err(
                    "engine-state-unauthenticated",
                    format!("engine state key: {e}"),
                ))
            }
        };
        let raw = hex::decode(&key_hex)
            .map_err(|_| err("engine-state-unauthenticated", "malformed engine state key"))?;
        let key: [u8; 32] = raw
            .try_into()
            .map_err(|_| err("engine-state-unauthenticated", "malformed engine state key"))?;
        if !key_admissible(&key, cfg!(feature = "test-engines")) {
            return Err(err(
                "engine-state-key-refused",
                "the engine state key is a published test fixture key; a production broker never uses it",
            ));
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        Ok(Self { dir, key })
    }

    fn path(&self, task: &str) -> Result<PathBuf, StateError> {
        if !valid_id(task) {
            return Err(err("engine-state-identity", "invalid task instance id"));
        }
        Ok(self.dir.join(format!("{task}.json")))
    }

    fn mac(&self, rec: &EngineStateRecord) -> String {
        hex::encode(hmac_sha256(&self.key, rec.mac_input().as_bytes()))
    }

    /// Make `rec` durable (authenticated, bounded). Any failure: the caller must not perform the
    /// effect this state authorizes.
    pub fn commit(&self, rec: &mut EngineStateRecord) -> Result<(), StateError> {
        #[cfg(feature = "test-engines")]
        if crate::engine::test_faults::fail_persist(&rec.task_instance_id) {
            return Err(err(
                "engine-state-unpersisted",
                "[injected] engine state could not be written",
            ));
        }
        let payload_len = serde_json::to_vec(&rec.payload)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if payload_len > MAX_PAYLOAD_BYTES {
            return Err(err(
                "engine-state-oversized",
                "the engine payload exceeds its bound",
            ));
        }
        rec.mac = self.mac(rec);
        let bytes =
            serde_json::to_vec(rec).map_err(|e| err("engine-state-unpersisted", e.to_string()))?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(err(
                "engine-state-oversized",
                "the engine state record exceeds its bound",
            ));
        }
        let path = self.path(&rec.task_instance_id)?;
        write_atomic_unique(&path, &bytes).map_err(|e| {
            err(
                "engine-state-unpersisted",
                format!("engine state could not be written: {e}"),
            )
        })
    }

    /// Create a task generation's first record. Never overwrites: a record for the task must not
    /// already exist (a task generation starts once).
    pub fn create(&self, rec: &mut EngineStateRecord) -> Result<(), StateError> {
        let path = self.path(&rec.task_instance_id)?;
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err(err(
                "engine-state-identity",
                "an engine state record already exists for this task generation",
            ));
        }
        self.commit(rec)
    }

    /// Load and authenticate the record of `task`; `None` when none was ever written.
    pub fn load(&self, task: &str) -> Result<Option<EngineStateRecord>, StateError> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = self.path(task)?;
        let mut f = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(err(
                    "engine-state-corrupt",
                    format!("engine state unreadable: {e}"),
                ))
            }
        };
        let mut bytes = Vec::new();
        (&mut f)
            .take(MAX_RECORD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| err("engine-state-corrupt", e.to_string()))?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(err(
                "engine-state-oversized",
                "the engine state record exceeds its bound",
            ));
        }
        let raw: Value = serde_json::from_slice(&bytes)
            .map_err(|_| err("engine-state-corrupt", "engine state is not JSON"))?;
        if raw.get("schemaVersion").and_then(|v| v.as_u64()) != Some(RECORD_SCHEMA as u64) {
            return Err(err(
                "engine-state-version",
                "unsupported engine state schema version; refusing to interpret it",
            ));
        }
        let rec: EngineStateRecord = serde_json::from_value(raw).map_err(|_| {
            err(
                "engine-state-corrupt",
                "engine state does not match its schema",
            )
        })?;
        let want = self.mac(&rec);
        let ok =
            hex::decode(&rec.mac).is_ok_and(|m| ct_eq(&m, &hex::decode(&want).unwrap_or_default()));
        if !ok {
            return Err(err(
                "engine-state-unauthenticated",
                "engine state failed authentication (tampered or foreign)",
            ));
        }
        if rec.task_instance_id != task {
            return Err(err(
                "engine-state-identity",
                "engine state belongs to another task generation",
            ));
        }
        Ok(Some(rec))
    }
}

/// EM-03: one run's engine host together with its durable record. The ONLY way the turn loop
/// talks to its engine; it keeps the record in step with the host and commits it at the
/// transaction boundaries (see the EM-03 architecture):
///
/// * an accepted effort change is committed BEFORE the Registry is asked to authorize it;
/// * the attempt -> target association is committed BEFORE the attempt is dispatched;
/// * the run's end is committed after it.
///
/// A rejected proposal leaves host and record untouched; a failed commit stops the run before the
/// effect it would have authorized.
pub struct EngineRun {
    pub host: crate::engine::EngineHost,
    pub rec: EngineStateRecord,
    store: EngineStateStore,
    /// EM-04A: capabilities lent to the engine at every consultation.
    pub env: crate::engine::EngineEnv,
}

/// What a continuation knows about the run it continues.
pub struct Predecessor {
    pub run_id: String,
    pub task_instance_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
impl EngineRun {
    /// Start the engine state of a NEW task generation (fresh or continuing `predecessor`).
    pub fn start(
        store: EngineStateStore,
        ext: &'static dyn crate::engine::EngineExtension,
        run_id: &str,
        task_instance_id: &str,
        mode_id: &str,
        task_binding_digest: &str,
        default_effort: &str,
        predecessor: Option<Predecessor>,
    ) -> Result<Self, StateError> {
        let d = ext.descriptor();
        let Examined {
            initial,
            lineage,
            notes,
        } = examine_predecessor(&store, ext, mode_id, predecessor)?;
        let mut rec = EngineStateRecord {
            schema_version: RECORD_SCHEMA,
            run_id: run_id.to_owned(),
            task_instance_id: task_instance_id.to_owned(),
            mode_id: mode_id.to_owned(),
            engine_id: d.engine_id.to_owned(),
            engine_contract: crate::engine::ENGINE_CONTRACT_VERSION,
            state_schema: d.state_schema,
            task_binding_digest: task_binding_digest.to_owned(),
            default_effort: default_effort.to_owned(),
            revision: initial.revision,
            last_proposal_id: 0,
            effort: None,
            payload: ext.persist_state(&initial),
            attempts: Vec::new(),
            lineage,
            events: Vec::new(),
            next_event_seq: 1,
            mac: String::new(),
        };
        rec.event("created", None, None, Some(default_effort), None);
        for (kind, attempt, effort, detail) in &notes {
            rec.event(kind, None, *attempt, effort.as_deref(), Some(detail));
        }
        store.create(&mut rec)?;
        let host = crate::engine::EngineHost::restored(ext, initial, 0, None);
        Ok(Self {
            host,
            rec,
            store,
            env: crate::engine::EngineEnv::default(),
        })
    }

    fn stage(&mut self) {
        let st = self.host.state();
        self.rec.revision = st.revision;
        self.rec.last_proposal_id = self.host.next_proposal_id() - 1;
        self.rec.effort = self.host.effort_selection().cloned();
        self.rec.payload = self.host.extension().persist_state(st);
    }

    pub fn commit(&mut self) -> Result<(), StateError> {
        self.stage();
        self.store.commit(&mut self.rec)
    }

    /// Consult the engine. An accepted effort change is made durable before this returns, so it
    /// is never authorized or dispatched from an uncommitted decision.
    pub fn consult(
        &mut self,
        hook: crate::engine::Hook,
        snapshot: &crate::engine::EngineSnapshot,
    ) -> Result<crate::engine::EngineDecision, StateError> {
        let before = self.host.effort_selection().cloned();
        let decision = self
            .host
            .consult_in(hook, snapshot, &self.env)
            .map_err(|r| err(r.code, r.message))?;
        if self.host.effort_selection() != before.as_ref() {
            let sel = self
                .host
                .effort_selection()
                .cloned()
                .expect("changed to a selection");
            self.stage();
            self.rec.event(
                "effort-selected",
                Some(sel.proposal_id),
                Some(sel.from_attempt),
                Some(&sel.effort),
                None,
            );
            self.store.commit(&mut self.rec)?;
        }
        Ok(decision)
    }

    /// EM-04B: accept the newest reasoning signal of `snapshot`. The engine's answer is validated
    /// by the host, then the new state and a `signal-accepted` event (with the dispatch key) are
    /// committed DURABLY; only then is the acknowledgement returned for the model. A refusal or a
    /// failed commit returns an error and the model receives no acknowledgement.
    pub fn consult_signal(
        &mut self,
        snapshot: &crate::engine::EngineSnapshot,
    ) -> Result<String, StateError> {
        let ack = self
            .host
            .consult_signal(snapshot, &self.env)
            .map_err(|r| err(r.code, r.message))?;
        #[cfg(feature = "test-engines")]
        if crate::engine::test_faults::armed_for_task(&self.rec.task_instance_id, "persist-signal")
        {
            return Err(err(
                "engine-state-unpersisted",
                "[injected] the accepted signal could not be written",
            ));
        }
        self.stage();
        let key = snapshot.signals.last().map(|x| x.dispatch_key.as_str());
        let id = self.host.next_proposal_id() - 1;
        self.rec.event("signal-accepted", Some(id), None, None, key);
        self.store.commit(&mut self.rec)?;
        Ok(ack)
    }

    /// Write-ahead before dispatch: attempt `ordinal` executes `effort` under issuance
    /// `issuance_id` / extension `extension_digest`.
    pub fn bind_attempt(
        &mut self,
        ordinal: u32,
        attempt_id: &str,
        effort: &str,
        issuance_id: &str,
        extension_digest: &str,
    ) -> Result<(), StateError> {
        self.stage();
        self.rec.attempt(AttemptRecord {
            ordinal,
            attempt_id: attempt_id.to_owned(),
            effort: effort.to_owned(),
            issuance_id: issuance_id.to_owned(),
            extension_digest: extension_digest.to_owned(),
            state: "bound".into(),
        });
        self.rec
            .event("attempt-bound", None, Some(ordinal), Some(effort), None);
        self.store.commit(&mut self.rec)
    }

    /// The outcome of a dispatched attempt (durable with the next commit).
    pub fn attempt_outcome(&mut self, ordinal: u32, state: &str) {
        self.rec.set_attempt_state(ordinal, state);
    }

    /// The end of the run (after its outcome is decided).
    pub fn finish(&mut self, how: &str) -> Result<(), StateError> {
        #[cfg(feature = "test-engines")]
        if crate::engine::test_faults::armed_for_task(&self.rec.task_instance_id, "persist-final") {
            return Err(err(
                "engine-state-unpersisted",
                "[injected] the end of the run could not be written",
            ));
        }
        self.stage();
        self.rec.event("run-ended", None, None, None, Some(how));
        self.store.commit(&mut self.rec)
    }
}

/// What a continuation starts from (see `EngineRun::start`).
pub struct Examined {
    pub initial: crate::engine::EngineState,
    pub lineage: Option<Lineage>,
    notes: Vec<(String, Option<u32>, Option<String>, String)>,
}

/// Examine the interrupted run's engine state for a continuation: authenticate it, refuse it if
/// it belongs to another engine, mode, contract or schema, restore an inheriting engine's payload
/// and collect the explicit continuation events. Pure with respect to the store (reads only), so
/// it can run before a continuation creates anything.
pub fn examine_predecessor(
    store: &EngineStateStore,
    ext: &'static dyn crate::engine::EngineExtension,
    mode_id: &str,
    predecessor: Option<Predecessor>,
) -> Result<Examined, StateError> {
    let d = ext.descriptor();
    let mut initial = ext.initial_state();
    let mut lineage = None;
    let mut notes: Vec<(String, Option<u32>, Option<String>, String)> = Vec::new();
    if let Some(p) = predecessor {
        let prev = match &p.task_instance_id {
            Some(t) => store.load(t)?,
            None => None,
        };
        match prev {
            // a run from before EM-03 (or one that never reached its task): its engine was
            // already checked equal by the EM-01 continuity rule; nothing to inherit
            None => {
                lineage = Some(Lineage {
                    predecessor_run: p.run_id.clone(),
                    predecessor_task: p.task_instance_id.clone(),
                    predecessor_revision: None,
                    inherited: false,
                    rule: "pre-em03-no-state".into(),
                });
                notes.push(("continued-without-predecessor-state".into(), None, None, "the interrupted run has no engine state (pre-EM-03); this task starts from the engine's initial state at the default effort".into()));
            }
            Some(prev) => {
                if prev.engine_id != d.engine_id || prev.mode_id != mode_id {
                    return Err(err("engine-state-identity", "the interrupted run's engine state belongs to another engine or mode; refusing to reinterpret it"));
                }
                if prev.engine_contract != crate::engine::ENGINE_CONTRACT_VERSION
                    || prev.state_schema != d.state_schema
                {
                    return Err(err("engine-state-version", "the interrupted run's engine state has another contract or schema version; refusing to reinterpret it"));
                }
                for a in prev.attempts.iter().filter(|a| a.state == "bound") {
                    notes.push(("predecessor-attempt-unresolved".into(), Some(a.ordinal), Some(a.effort.clone()), "the interrupted run's attempt was bound but its outcome was never recorded; it is never re-sent".into()));
                }
                if d.inherits_state {
                    initial = ext.restore_state(&prev.payload, 0).ok_or_else(|| {
                        err(
                            "engine-state-corrupt",
                            "the interrupted run's engine payload is not valid for this engine",
                        )
                    })?;
                }
                if let Some(sel) = prev
                    .effort
                    .as_ref()
                    .filter(|e| e.effort != prev.default_effort)
                {
                    notes.push(("effort-reset-continuation".into(), None, Some(sel.effort.clone()), "the continuation starts at the default effort under its own task binding; another effort needs a new proposal and a new authorization".into()));
                }
                lineage = Some(Lineage {
                    predecessor_run: p.run_id.clone(),
                    predecessor_task: p.task_instance_id.clone(),
                    predecessor_revision: Some(prev.revision),
                    inherited: d.inherits_state,
                    rule: if d.inherits_state {
                        "inherited"
                    } else {
                        "fresh-engine-does-not-inherit"
                    }
                    .into(),
                });
            }
        }
    }
    Ok(Examined {
        initial,
        lineage,
        notes,
    })
}

fn write_atomic_unique(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{n}", std::process::id()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // the rename itself is durable only once the directory is synced (power loss)
    match path.parent() {
        Some(p) => fsync_dir(p),
        None => Ok(()),
    }
}

/// fsync a directory (its entries: created and renamed files). Errors are returned: the caller
/// must not treat an unsynced entry as durable.
fn fsync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(task: &str) -> EngineStateRecord {
        EngineStateRecord {
            schema_version: RECORD_SCHEMA,
            run_id: "run_x".into(),
            task_instance_id: task.into(),
            mode_id: "engineering-v2".into(),
            engine_id: "muse-v0".into(),
            engine_contract: 2,
            state_schema: 1,
            task_binding_digest: "b".repeat(64),
            default_effort: "low".into(),
            revision: 0,
            last_proposal_id: 0,
            effort: None,
            payload: serde_json::json!({"nudges": 0}),
            attempts: Vec::new(),
            lineage: None,
            events: Vec::new(),
            next_event_seq: 1,
            mac: String::new(),
        }
    }

    #[test]
    fn a_record_round_trips_authenticated_and_is_never_overwritten_by_create() {
        let d = tempfile::tempdir().unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        let mut r = rec("task-1");
        r.event("created", None, None, Some("low"), None);
        s.create(&mut r).unwrap();
        assert_eq!(s.load("task-1").unwrap().unwrap(), r);
        assert_eq!(
            s.create(&mut rec("task-1")).unwrap_err().code,
            "engine-state-identity"
        );
        assert!(s.load("task-2").unwrap().is_none());
        // the key survives a reopen (and is private)
        let s2 = EngineStateStore::open(d.path()).unwrap();
        assert_eq!(s2.load("task-1").unwrap().unwrap(), r);
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(d.path().join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(m & 0o777, 0o600);
    }

    #[test]
    fn tampered_foreign_versioned_or_oversized_records_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        let mut r = rec("task-1");
        s.create(&mut r).unwrap();
        let p = d.path().join("engine/task-1.json");
        let good = std::fs::read(&p).unwrap();
        // tampered: an escalated selection
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["effort"] = serde_json::json!({"effort": "high", "fromAttempt": 1, "proposalId": 1});
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(
            s.load("task-1").unwrap_err().code,
            "engine-state-unauthenticated"
        );
        // another schema version
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["schemaVersion"] = 2.into();
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(s.load("task-1").unwrap_err().code, "engine-state-version");
        // unknown field
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["governor"] = 1.into();
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(s.load("task-1").unwrap_err().code, "engine-state-corrupt");
        // another task's (authentic) record copied under this task's name
        let mut other = rec("task-2");
        s.create(&mut other).unwrap();
        std::fs::copy(d.path().join("engine/task-2.json"), &p).unwrap();
        assert_eq!(s.load("task-1").unwrap_err().code, "engine-state-identity");
        // a record authenticated under another broker's key
        let d2 = tempfile::tempdir().unwrap();
        let s2 = EngineStateStore::open(d2.path()).unwrap();
        let mut r2 = rec("task-1");
        s2.create(&mut r2).unwrap();
        std::fs::copy(d2.path().join("engine/task-1.json"), &p).unwrap();
        assert_eq!(
            s.load("task-1").unwrap_err().code,
            "engine-state-unauthenticated"
        );
        // oversized payload is refused at commit, the stored record is untouched
        std::fs::write(&p, &good).unwrap();
        let mut big = rec("task-1");
        big.payload = serde_json::json!({"x": "y".repeat(MAX_PAYLOAD_BYTES)});
        assert_eq!(
            s.commit(&mut big).unwrap_err().code,
            "engine-state-oversized"
        );
        assert_eq!(s.load("task-1").unwrap().unwrap().payload, r.payload);
        // garbage and traversal
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(s.load("task-1").unwrap_err().code, "engine-state-corrupt");
        assert_eq!(s.load("../x").unwrap_err().code, "engine-state-identity");
    }

    #[test]
    fn history_is_bounded_and_sequence_stays_monotonic() {
        let mut r = rec("task-1");
        for i in 0..200 {
            r.event("tick", Some(i), None, None, Some(&"d".repeat(500)));
        }
        assert_eq!(r.events.len(), MAX_EVENTS);
        assert_eq!(r.events.last().unwrap().seq, 200);
        assert!(r.events.windows(2).all(|w| w[1].seq == w[0].seq + 1));
        assert!(r
            .events
            .iter()
            .all(|e| e.detail.as_ref().unwrap().len() == 200));
        for i in 0..100 {
            r.attempt(AttemptRecord {
                ordinal: i,
                attempt_id: format!("A{i}"),
                effort: "low".into(),
                issuance_id: "i".into(),
                extension_digest: "e".into(),
                state: "bound".into(),
            });
        }
        assert_eq!(r.attempts.len(), MAX_ATTEMPTS);
        assert_eq!(r.attempts[0].ordinal, 100 - MAX_ATTEMPTS as u32);
    }

    // ---------------------------------------------------------- continuation rules (EngineRun)

    fn start(
        dir: &Path,
        ext: &'static dyn crate::engine::EngineExtension,
        task: &str,
        pred: Option<(&str, Option<&str>)>,
    ) -> Result<EngineRun, StateError> {
        EngineRun::start(
            EngineStateStore::open(dir).unwrap(),
            ext,
            &format!("run_{task}"),
            task,
            "engineering-v2",
            &"b".repeat(64),
            "low",
            pred.map(|(r, t)| Predecessor {
                run_id: r.into(),
                task_instance_id: t.map(str::to_owned),
            }),
        )
    }

    #[cfg(feature = "test-engines")]
    #[test]
    fn continuations_inherit_reset_or_refuse_exactly_by_rule() {
        use crate::engine::muse_v0::MUSE_V0;
        use crate::engine::test_engine::EFFORT_TEST_V0;
        use crate::engine::{EffortProposal, EngineAction, EngineExtension, EngineSnapshot, Hook};
        let d = tempfile::tempdir().unwrap();
        // a test-engine task that selected "high" and bound attempt 2 without an outcome
        let mut a = start(d.path(), &EFFORT_TEST_V0, "task-a", None).unwrap();
        let snap = EngineSnapshot {
            attempts_dispatched: 1,
            current_effort: "low".into(),
            authorized_efforts: vec!["high".into(), "low".into()],
            ..Default::default()
        };
        let mut p = EFFORT_TEST_V0.propose(Hook::BeforeRequest, &snap, a.host.state(), 1);
        p.effort = EffortProposal::Change("high".into());
        p.action = EngineAction::Continue;
        a.host.accept(Hook::BeforeRequest, &snap, p).unwrap();
        a.bind_attempt(2, "A2", "high", "iss", "ext").unwrap();
        let prev_rev = a.rec.revision;
        // inherited: lineage, the unresolved attempt and the effort reset are explicit events
        let b = start(
            d.path(),
            &EFFORT_TEST_V0,
            "task-b",
            Some(("run_task-a", Some("task-a"))),
        )
        .unwrap();
        let l = b.rec.lineage.clone().unwrap();
        assert_eq!(
            (l.rule.as_str(), l.inherited, l.predecessor_revision),
            ("inherited", true, Some(prev_rev))
        );
        let kinds: Vec<&str> = b.rec.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "created",
                "predecessor-attempt-unresolved",
                "effort-reset-continuation"
            ]
        );
        assert!(
            b.host.effort_selection().is_none(),
            "never escalated by a restart"
        );
        assert_eq!(b.host.next_proposal_id(), 1);
        // the same task generation cannot start twice
        assert_eq!(
            start(d.path(), &EFFORT_TEST_V0, "task-b", None)
                .err()
                .unwrap()
                .code,
            "engine-state-identity"
        );
        // a predecessor of another engine is never reinterpreted
        assert_eq!(
            start(
                d.path(),
                &MUSE_V0,
                "task-c",
                Some(("run_task-a", Some("task-a")))
            )
            .err()
            .unwrap()
            .code,
            "engine-state-identity"
        );
        // muse-v0 continuing a muse-v0 task: fresh state, rule recorded
        let _m = start(d.path(), &MUSE_V0, "task-m", None).unwrap();
        let m2 = start(
            d.path(),
            &MUSE_V0,
            "task-m2",
            Some(("run_task-m", Some("task-m"))),
        )
        .unwrap();
        assert_eq!(
            m2.rec.lineage.unwrap().rule,
            "fresh-engine-does-not-inherit"
        );
        // a pre-EM-03 predecessor (no record) and one that never reached its task
        let p1 = start(
            d.path(),
            &MUSE_V0,
            "task-p1",
            Some(("run_old", Some("task-old"))),
        )
        .unwrap();
        assert_eq!(p1.rec.lineage.clone().unwrap().rule, "pre-em03-no-state");
        assert_eq!(p1.rec.events[1].kind, "continued-without-predecessor-state");
        let p2 = start(d.path(), &MUSE_V0, "task-p2", Some(("run_old", None))).unwrap();
        assert_eq!(p2.rec.lineage.unwrap().rule, "pre-em03-no-state");
        // tampered, other version, invalid payload: refused
        let path = d.path().join("engine/task-a.json");
        let good = std::fs::read(&path).unwrap();
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["defaultEffort"] = "high".into();
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(
            start(
                d.path(),
                &EFFORT_TEST_V0,
                "task-d",
                Some(("run_task-a", Some("task-a")))
            )
            .err()
            .unwrap()
            .code,
            "engine-state-unauthenticated"
        );
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["schemaVersion"] = 7.into();
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(
            start(
                d.path(),
                &EFFORT_TEST_V0,
                "task-e",
                Some(("run_task-a", Some("task-a")))
            )
            .err()
            .unwrap()
            .code,
            "engine-state-version"
        );
        // an authentic record with another contract version
        std::fs::write(&path, &good).unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        let mut r = s.load("task-a").unwrap().unwrap();
        r.engine_contract = 1;
        s.commit(&mut r).unwrap();
        assert_eq!(
            start(
                d.path(),
                &EFFORT_TEST_V0,
                "task-f",
                Some(("run_task-a", Some("task-a")))
            )
            .err()
            .unwrap()
            .code,
            "engine-state-version"
        );
        // an authentic record whose payload this engine refuses
        r.engine_contract = crate::engine::ENGINE_CONTRACT_VERSION;
        r.payload = serde_json::json!({"proposals": "many"});
        s.commit(&mut r).unwrap();
        assert_eq!(
            start(
                d.path(),
                &EFFORT_TEST_V0,
                "task-g",
                Some(("run_task-a", Some("task-a")))
            )
            .err()
            .unwrap()
            .code,
            "engine-state-corrupt"
        );
    }

    /// Offline cost of one durable commit (authenticated, fsync'd atomic write) of a realistic
    /// record (full attempt and event history). Measured, not asserted.
    #[test]
    fn commit_cost_is_measured() {
        let d = tempfile::tempdir().unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        let mut r = rec("task-perf");
        r.payload = serde_json::json!({"nudges": 3, "narrationDigests": vec!["a".repeat(64); 4]});
        for i in 0..MAX_ATTEMPTS as u32 {
            r.attempt(AttemptRecord {
                ordinal: i,
                attempt_id: format!("INTENT-00001-A{i}"),
                effort: "low".into(),
                issuance_id: "i".repeat(64),
                extension_digest: "e".repeat(64),
                state: "answered".into(),
            });
        }
        for i in 0..MAX_EVENTS as u64 {
            r.event("attempt-bound", None, Some(i as u32), Some("low"), None);
        }
        s.create(&mut r).unwrap();
        let mut ms = Vec::new();
        for _ in 0..100 {
            let t = std::time::Instant::now();
            s.commit(&mut r).unwrap();
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let bytes = std::fs::metadata(d.path().join("engine/task-perf.json"))
            .unwrap()
            .len();
        println!(
            "EM03-PERF commit median {:.2} ms, p95 {:.2} ms (n=100, record {} B)",
            ms[50], ms[95], bytes
        );
    }

    /// The key is created once per state root, never regenerated for existing records, and only
    /// accepted as a private regular file of this user (no symlink, no group/other access).
    #[test]
    fn the_key_is_never_regenerated_replaced_or_followed() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        let mut r = rec("task-1");
        s.create(&mut r).unwrap();
        let key = d.path().join(KEY_FILE);
        let original = std::fs::read(&key).unwrap();
        // reopening keeps the same key and the record authenticates
        for _ in 0..3 {
            let s = EngineStateStore::open(d.path()).unwrap();
            assert!(s.load("task-1").unwrap().is_some());
        }
        assert_eq!(std::fs::read(&key).unwrap(), original);
        // a lost key with existing records: refused, no new key minted
        std::fs::remove_file(&key).unwrap();
        assert_eq!(
            EngineStateStore::open(d.path()).err().unwrap().code,
            "engine-state-unauthenticated"
        );
        assert!(!key.exists(), "no key was regenerated");
        // a symlinked key: refused (never followed)
        let elsewhere = d.path().join("other.key");
        std::fs::write(&elsewhere, &original).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &key).unwrap();
        assert_eq!(
            EngineStateStore::open(d.path()).err().unwrap().code,
            "engine-state-unauthenticated"
        );
        std::fs::remove_file(&key).unwrap();
        // group-readable or malformed key: refused
        std::fs::write(&key, &original).unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            EngineStateStore::open(d.path()).err().unwrap().code,
            "engine-state-unauthenticated"
        );
        std::fs::write(&key, b"not-hex").unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            EngineStateStore::open(d.path()).err().unwrap().code,
            "engine-state-unauthenticated"
        );
        // the genuine key restored: everything authenticates again
        std::fs::write(&key, &original).unwrap();
        let s = EngineStateStore::open(d.path()).unwrap();
        assert!(s.load("task-1").unwrap().is_some());
        // a fresh state root (no records) gets a fresh key
        let d2 = tempfile::tempdir().unwrap();
        EngineStateStore::open(d2.path()).unwrap();
        assert_ne!(std::fs::read(d2.path().join(KEY_FILE)).unwrap(), original);
    }
}

/// SHA-256 of the throwaway HMAC key published with the EM-03 compatibility fixtures
/// (`tests/fixtures/em03-engine-state/TEST-ONLY-throwaway-em03-hmac-key.hex`, hex text of the key).
/// Anyone can read it, so records under it are forgeable: only `test-engines` builds accept it.
pub const PUBLISHED_TEST_KEY_SHA256: &str =
    "e5d9a803ae250616755e6d8c00befa4625f4e3bd6282dd449017902c5af1dcd7";

/// EM-04B: whether `key` may authenticate engine state in this build.
pub fn key_admissible(key: &[u8; 32], test_build: bool) -> bool {
    test_build || nexus_contracts::sha256_hex(&hex::encode(key)) != PUBLISHED_TEST_KEY_SHA256
}

/// EM-04A compatibility: records WRITTEN BY THE EM-03 COMMIT (`b5a939a`, real code, captured in
/// `tests/fixtures/em03-engine-state` with their broker-local test key) are reopened, authenticated
/// and continued by this build. The persisted schema (record schema 1, engine contract 2) is
/// unchanged by EM-04A; only Rust API types grew additively, so no migration exists or is needed.
#[cfg(all(test, feature = "test-engines"))]
mod em03_records_compatibility {
    use super::*;
    use crate::engine::muse_v0::MUSE_V0;
    use crate::engine::muse_v1::MUSE_V1;
    use crate::engine::test_engine::EFFORT_TEST_V0;
    use crate::engine::{EngineSnapshot, Hook, RunKind};
    use std::os::unix::fs::PermissionsExt;

    const TASKS: [&str; 3] = ["task_em03_muse", "task_em03_effort", "task_em03_done"];

    /// A broker state directory holding the EM-03 key and records (permissions as the broker
    /// writes them; git does not keep them).
    fn em03_state_dir() -> tempfile::TempDir {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/em03-engine-state");
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("engine")).unwrap();
        // the throwaway key of the directory the EM-03 code wrote these records in (README.md)
        std::fs::copy(
            src.join("TEST-ONLY-throwaway-em03-hmac-key.hex"),
            d.path().join("engine-state.key"),
        )
        .unwrap();
        std::fs::set_permissions(
            d.path().join("engine-state.key"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        for t in TASKS {
            let to = d.path().join(format!("engine/{t}.json"));
            std::fs::copy(src.join(format!("engine/{t}.json")), &to).unwrap();
            std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        std::fs::set_permissions(
            d.path().join("engine"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        d
    }

    fn cont(
        dir: &Path,
        ext: &'static dyn crate::engine::EngineExtension,
        task: &str,
        pred: &str,
    ) -> Result<EngineRun, StateError> {
        EngineRun::start(
            EngineStateStore::open(dir).unwrap(),
            ext,
            &format!("run_{task}"),
            task,
            "engineering-v2",
            &"b".repeat(64),
            "low",
            Some(Predecessor {
                run_id: format!("run_{pred}"),
                task_instance_id: Some(pred.to_owned()),
            }),
        )
    }

    fn snap(dispatched: u32) -> EngineSnapshot {
        EngineSnapshot {
            kind: Some(RunKind::Code),
            interactive: true,
            attempts_dispatched: dispatched,
            current_effort: "low".into(),
            authorized_efforts: vec!["high".into(), "low".into()],
            generation: "gen-new".into(),
            ..Default::default()
        }
    }

    #[test]
    fn em03_records_reopen_byte_for_byte_and_authenticate() {
        let d = em03_state_dir();
        let key_before = std::fs::read(d.path().join("engine-state.key")).unwrap();
        let store = EngineStateStore::open(d.path()).expect("the EM-03 key is accepted");
        assert_eq!(
            std::fs::read(d.path().join("engine-state.key")).unwrap(),
            key_before,
            "never regenerated"
        );
        for t in TASKS {
            let bytes = std::fs::read(d.path().join(format!("engine/{t}.json"))).unwrap();
            let rec = store.load(t).expect("authentic").expect("present");
            assert_eq!(rec.schema_version, RECORD_SCHEMA);
            assert_eq!(rec.engine_contract, crate::engine::ENGINE_CONTRACT_VERSION);
            // lossless: this build's types serialize the EM-03 record to the identical bytes
            assert_eq!(serde_json::to_vec(&rec).unwrap(), bytes, "{t}");
        }
        // tampering with an EM-03 record is still refused
        let p = d.path().join("engine/task_em03_done.json");
        let mut v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        v["defaultEffort"] = "high".into();
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(
            store.load("task_em03_done").err().unwrap().code,
            "engine-state-unauthenticated"
        );
    }

    #[test]
    fn an_interrupted_em03_muse_v0_task_is_continued_safely() {
        let d = em03_state_dir();
        let old = std::fs::read(d.path().join("engine/task_em03_muse.json")).unwrap();
        let mut r = cont(d.path(), &MUSE_V0, "task_new_muse", "task_em03_muse").unwrap();
        let l = r.rec.lineage.clone().unwrap();
        assert_eq!(l.rule, "fresh-engine-does-not-inherit");
        let old_rev = serde_json::from_slice::<Value>(&old).unwrap()["revision"].as_u64();
        assert_eq!(
            l.predecessor_revision, old_rev,
            "lineage names the durable revision"
        );
        let ev: Vec<(&str, Option<u32>)> = r
            .rec
            .events
            .iter()
            .map(|e| (e.kind.as_str(), e.attempt))
            .collect();
        assert_eq!(
            ev,
            [
                ("created", None),
                ("predecessor-attempt-unresolved", Some(2))
            ],
            "the interrupted attempt is recorded, never re-sent"
        );
        // the continuation runs under this build: consult (EM-04A snapshot), bind, finish
        r.consult(Hook::BeforeRequest, &snap(0)).unwrap();
        r.bind_attempt(1, "att_n1", "low", "iss_low", "ext_low")
            .unwrap();
        r.attempt_outcome(1, "answered");
        r.finish("completed").unwrap();
        let store = EngineStateStore::open(d.path()).unwrap();
        let back = store.load("task_new_muse").unwrap().unwrap();
        assert_eq!(back.attempts.len(), 1);
        assert_eq!(back.events.last().unwrap().kind, "run-ended");
        assert_eq!(
            std::fs::read(d.path().join("engine/task_em03_muse.json")).unwrap(),
            old,
            "the predecessor record is never rewritten"
        );
        // a completed EM-03 run continues with nothing unresolved
        let c = cont(d.path(), &MUSE_V0, "task_new_done", "task_em03_done").unwrap();
        assert_eq!(
            c.rec
                .events
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["created"]
        );
    }

    #[test]
    fn an_em03_effort_selection_is_inherited_reset_and_reauthorized_never_escalated() {
        let d = em03_state_dir();
        let mut r = cont(
            d.path(),
            &EFFORT_TEST_V0,
            "task_new_effort",
            "task_em03_effort",
        )
        .unwrap();
        assert_eq!(r.rec.lineage.clone().unwrap().rule, "inherited");
        let ev: Vec<(&str, Option<u32>, Option<&str>)> = r
            .rec
            .events
            .iter()
            .map(|e| (e.kind.as_str(), e.attempt, e.effort.as_deref()))
            .collect();
        assert_eq!(
            ev,
            [
                ("created", None, Some("low")),
                ("predecessor-attempt-unresolved", Some(2), Some("high")),
                ("effort-reset-continuation", None, Some("high")),
            ]
        );
        assert!(
            r.host.effort_selection().is_none(),
            "restarts at the default"
        );
        assert_eq!(r.host.effort_for_attempt(1), None);
        // the inherited payload drives the next proposal; it is durable before its attempt
        r.consult(Hook::BeforeRequest, &snap(0)).unwrap();
        let sel = r
            .host
            .effort_selection()
            .cloned()
            .expect("re-proposed under the new binding");
        assert_eq!((sel.effort.as_str(), sel.from_attempt), ("high", 1));
        r.bind_attempt(1, "att_n1", "high", "iss_high_new", "ext_high_new")
            .unwrap();
        let back = EngineStateStore::open(d.path())
            .unwrap()
            .load("task_new_effort")
            .unwrap()
            .unwrap();
        let kinds: Vec<&str> = back.events.iter().map(|e| e.kind.as_str()).collect();
        let sel_at = kinds.iter().position(|k| *k == "effort-selected").unwrap();
        let bound_at = kinds.iter().position(|k| *k == "attempt-bound").unwrap();
        assert!(sel_at < bound_at);
    }

    #[test]
    fn the_published_fixture_key_is_refused_by_a_production_build() {
        let hex_key = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/em03-engine-state/TEST-ONLY-throwaway-em03-hmac-key.hex"),
        )
        .unwrap();
        let key: [u8; 32] = hex::decode(hex_key.trim()).unwrap().try_into().unwrap();
        assert_eq!(
            nexus_contracts::sha256_hex(&hex_key),
            PUBLISHED_TEST_KEY_SHA256,
            "the fingerprint is the fixture file's"
        );
        assert!(!key_admissible(&key, false), "production refuses it");
        assert!(key_admissible(&key, true), "only test builds accept it");
        // any other key is admissible in production
        assert!(key_admissible(&[7u8; 32], false));
    }

    #[test]
    fn an_em03_record_is_never_reinterpreted_by_the_shadow_engine() {
        let d = em03_state_dir();
        let e = cont(d.path(), &MUSE_V1, "task_new_shadow", "task_em03_muse")
            .err()
            .unwrap();
        assert_eq!(e.code, "engine-state-identity");
    }
}

/// MEASUREMENT (explicit: `--ignored --nocapture em04b_measure`): one reasoning signal end to end
/// at the engine boundary: Core validation + dispatch key, the historical path through the bridge,
/// host validation (Rust fold) and the durable commit.
#[cfg(all(test, feature = "test-engines"))]
mod em04b_measure {
    use super::*;
    use crate::engine::muse_v1::MUSE_V1_SIGNALS;
    use crate::engine::{EngineEnv, EngineSnapshot, SignalObservation};

    #[test]
    #[ignore]
    fn em04b_measure_signal_processing() {
        let d = tempfile::tempdir().unwrap();
        let mut run = EngineRun::start(
            EngineStateStore::open(d.path()).unwrap(),
            &MUSE_V1_SIGNALS,
            "run_m",
            "task_m",
            "engineering-v2",
            &"b".repeat(64),
            "low",
            None,
        )
        .unwrap();
        run.env = EngineEnv {
            governor: Some(std::sync::Arc::new(
                crate::engine::governor_bridge::NodeGovernorBridge::new("node".into()),
            )),
        };
        let mut snap = EngineSnapshot {
            current_effort: "low".into(),
            authorized_efforts: vec!["low".into(), "medium".into()],
            generation: "task_m".into(),
            ..Default::default()
        };
        let (mut core_us, mut total_ms) = (Vec::new(), Vec::new());
        for i in 1..=50u32 {
            let signal = serde_json::json!({"phase": if i % 2 == 0 { "verify" } else { "implement" },
                "recordImplementationFailure": i % 3 == 0});
            let t = std::time::Instant::now();
            crate::signals::validate(&signal, signal.to_string().len()).unwrap();
            let key = crate::signals::dispatch_key("task_m", 1, &format!("call_{i}"), &signal);
            core_us.push(t.elapsed().as_secs_f64() * 1e6);
            snap.signals.push(SignalObservation {
                seq: i,
                attempt: 1,
                generation: "task_m".into(),
                call_id: format!("call_{i}"),
                dispatch_key: key,
                signal,
            });
            let t = std::time::Instant::now();
            run.consult_signal(&snap).unwrap();
            total_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        core_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
        total_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "EM-04B signal: Core validation + key median {:.1} us; accept (bridge + host fold + durable commit) median {:.1} ms p95 {:.1} ms (n=50)",
            core_us[25], total_ms[25], total_ms[47]
        );
        // serialization: the catalog with and without the tool, as `prepare` canonicalizes it
        let (mut a, mut b) = (Vec::new(), Vec::new());
        for _ in 0..200 {
            let t = std::time::Instant::now();
            let x = nexus_contracts::canonical_json(&serde_json::Value::Array(
                nexus_model::repo_tools::definitions_for(nexus_model::ToolProfile::RepoCodeV1),
            ));
            a.push((t.elapsed().as_secs_f64() * 1e6, x.len()));
            let t = std::time::Instant::now();
            let y = nexus_contracts::canonical_json(&serde_json::Value::Array(
                nexus_model::repo_tools::definitions_for(
                    nexus_model::ToolProfile::RepoCodeMuseSignalsV1,
                ),
            ));
            b.push((t.elapsed().as_secs_f64() * 1e6, y.len()));
        }
        a.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
        b.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
        println!(
            "EM-04B catalog serialization: RepoCodeV1 {} B median {:.1} us; with signals {} B median {:.1} us",
            a[100].1, a[100].0, b[100].1, b[100].0
        );
    }
}
