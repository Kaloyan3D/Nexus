//! Nexus Native Core A1.1 kernel: lease fencing, sealed acceptance, replay.
//! A1.1 performs NO external effects. Accepted commands are reserved
//! durably with status accepted-reserved-dispatch-disabled; the only
//! dispatch authorization path always refuses with dispatch-disabled.
pub mod accept;
pub mod bridge;

pub use accept::{AcceptRequest, GenerationState};
use nexus_contracts::{
    generation_key, CommandReceiptV1, GenerationLeaseV1, KernelError, KernelErrorCode,
    KernelResult, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION,
};
use nexus_store::{Store, WitnessStore};
use std::path::Path;

pub struct Kernel {
    store: Store,
    witness: Option<WitnessStore>,
    lock_file: std::path::PathBuf,
    in_process: std::sync::Mutex<()>,
}

fn now_utc() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => [
            d.as_secs().to_string(),
            ".".to_owned(),
            format!("{:09}", d.subsec_nanos()),
            "Z".to_owned(),
        ]
        .concat(),
        Err(_) => "0.000000000Z".to_owned(),
    }
}

pub fn hmac_seal_hex(key_hex: &str, canonical: &str) -> KernelResult<String> {
    use hmac::Mac;
    let key = hex::decode(key_hex)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is corrupted"))?;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&key)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is invalid"))?;
    mac.update(canonical.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

impl Kernel {
    pub fn open(db_path: &Path, witness_path: Option<&Path>) -> KernelResult<Self> {
        let store = Store::open(db_path)?;
        let witness = match witness_path {
            Some(p) => Some(WitnessStore::open(p)?),
            None => None,
        };
        let lock_file = match db_path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.join("kernel.lock"),
            _ => std::path::PathBuf::from("kernel.lock"),
        };
        Ok(Self {
            store,
            witness,
            lock_file,
            in_process: std::sync::Mutex::new(()),
        })
    }

    /// Cross-thread and cross-process critical section for every
    /// check-act-note sequence (acquire, accept, fenced recovery).
    /// SQLite IMMEDIATE transactions serialize the store writes, but the
    /// witness note lives in a separate file: without this mutex a
    /// concurrent acquirer could observe a protected store generation whose
    /// witness note has not landed yet and wrongly conclude loss.
    /// Fail-closed: if the lock cannot be taken, refuse rather than proceed
    /// without mutual exclusion.
    pub(crate) fn critical<T>(
        lock_file: &Path,
        gate: &std::sync::Mutex<()>,
        op: impl FnOnce() -> KernelResult<T>,
    ) -> KernelResult<T> {
        let _threads = gate.lock().map_err(|_| {
            KernelError::new(
                KernelErrorCode::StoreError,
                "kernel mutex is poisoned; failing closed",
            )
        })?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(lock_file)
            .map_err(|e| {
                KernelError::new(
                    KernelErrorCode::StoreError,
                    ["kernel lock file unavailable: ", &e.to_string()].concat(),
                )
            })?;
        fs2::FileExt::lock_exclusive(&file).map_err(|e| {
            KernelError::new(
                KernelErrorCode::StoreError,
                ["kernel lock acquisition failed: ", &e.to_string()].concat(),
            )
        })?;
        let result = op();
        fs2::FileExt::unlock(&file).map_err(|e| {
            KernelError::new(
                KernelErrorCode::StoreError,
                ["kernel lock release failed: ", &e.to_string()].concat(),
            )
        })?;
        result
    }

    pub fn incarnation(&self) -> &str {
        self.store.incarnation()
    }

    pub fn acquire_generation(
        &mut self,
        task: &str,
        backend: &str,
    ) -> KernelResult<GenerationLeaseV1> {
        if task.is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::LeaseInvalid,
                "taskInstanceId is required",
            ));
        }
        if backend != "native" {
            return Err(KernelError::new(
                KernelErrorCode::LeaseBackendRefused,
                "only backend=native participates in A1.1",
            ));
        }
        Self::critical(&self.lock_file, &self.in_process, || {
            let gkey = generation_key(task, backend);
            let current = self.store.current_generation(task, backend)?;
            let protected = current
                .as_ref()
                .map(|g| g.witness_protected)
                .unwrap_or(false);
            let witness_max: Option<u64> = match self.witness.as_ref() {
                Some(w) => match w.read(&gkey)? {
                    Some(rec) => Some(rec.max_epoch),
                    None => {
                        if protected {
                            return Err(KernelError::new(
                                KernelErrorCode::ReconciliationRequired,
                                "witness record lost after protection was established",
                            ));
                        }
                        None
                    }
                },
                None => {
                    if protected {
                        return Err(KernelError::new(
                            KernelErrorCode::WitnessRequired,
                            "generation is witness-protected; witness must not be omitted",
                        ));
                    }
                    None
                }
            };
            let (epoch, incarnation) = self.store.acquire_generation(
                task,
                backend,
                witness_max,
                self.witness.is_some(),
            )?;
            if let Some(w) = self.witness.as_mut() {
                w.note_epoch(&gkey, epoch, &incarnation, None)?;
            }
            Ok(GenerationLeaseV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                task_instance_id: task.to_owned(),
                backend: backend.to_owned(),
                lease_epoch: epoch,
                store_incarnation: incarnation,
                witness_protected: self.witness.is_some(),
                acquired_at_utc: now_utc(),
            })
        })
    }

    pub fn seal_issuance(&mut self, issued: &RegistryResolutionV1) -> KernelResult<String> {
        if issued.schema_version != CONTRACT_SCHEMA_VERSION {
            return Err(KernelError::new(
                KernelErrorCode::UnsupportedSchema,
                "unsupported resolution schemaVersion",
            ));
        }
        issued.target.validate_complete()?;
        let computed = issued.issuance_id_of();
        if computed != issued.provenance.issuance_id {
            return Err(KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "issuanceId does not match issuance content",
            ));
        }
        let key_hex = self.store.issuance_key_hex()?;
        let issued_value = serde_json::to_value(issued).map_err(|_| {
            KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "resolution is not JSON-representable",
            )
        })?;
        let canonical = nexus_contracts::canonical_json(&issued_value);
        let seal = hmac_seal_hex(&key_hex, &canonical)?;
        match self.store.seal_issuance(&computed, &canonical, &seal)? {
            nexus_store::SealOutcome::Created => Ok(computed),
            nexus_store::SealOutcome::Identical => Ok(computed),
        }
    }

    pub fn read_receipt(&self, command_id: &str) -> KernelResult<Option<CommandReceiptV1>> {
        self.store.read_receipt(command_id)
    }
    pub fn list_events(
        &self,
        task: &str,
        backend: &str,
    ) -> KernelResult<Vec<nexus_contracts::KernelEventV1>> {
        self.store.list_events(&generation_key(task, backend))
    }
    pub fn list_all_events(&self) -> KernelResult<Vec<nexus_contracts::KernelEventV1>> {
        self.store.list_all_events()
    }
    pub fn count_commands(&self) -> KernelResult<i64> {
        self.store.count_commands()
    }
    pub fn count_receipts(&self) -> KernelResult<i64> {
        self.store.count_receipts()
    }

    pub fn authorize_dispatch(&self, command_id: &str) -> KernelResult<()> {
        let _ = command_id;
        Err(KernelError::new(KernelErrorCode::DispatchDisabled, "A1.1 leaves external dispatch disabled: acceptance only reserves intent, never authorizes effects"))
    }

    pub fn dispatch_enabled() -> bool {
        false
    }
}

/// Path of the daemon lifetime lock for a kernel database. Shared with
/// `nexusd`: while a daemon holds this lock, CLI mutations must refuse
/// rather than bypass daemon authorization (A1.3.3).
pub fn daemon_lock_path_for(db_path: &Path) -> std::path::PathBuf {
    match db_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join("daemon.lock"),
        _ => std::path::PathBuf::from("daemon.lock"),
    }
}

/// Fail closed when a live daemon owns the store: tries a non-blocking
/// exclusive lock on the daemon lock file. If the lock is held elsewhere
/// (or cannot be proven free), the caller must NOT touch the store.
/// Read-only commands do not need this guard; mutations do.
pub fn ensure_no_live_daemon(db_path: &Path) -> Result<(), String> {
    let lock_path = daemon_lock_path_for(db_path);
    if !lock_path.exists() {
        return Ok(());
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&lock_path)
        .map_err(|e| format!("daemon lock unreadable; failing closed: {e}"))?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            let _ = fs2::FileExt::unlock(&file);
            Ok(())
        }
        Err(_) => Err([
            "daemon-owns-store: a live nexusd daemon owns this store; legacy CLI mutations are refused while the daemon runs (use the daemon IPC surface instead)",
        ].concat()),
    }
}
