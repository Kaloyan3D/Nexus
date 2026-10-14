//! Transactional SQLite kernel store.
//! Every mutating operation commits atomically: concurrent losers observe
//! either the full winner state or nothing, then classify idempotent vs
//! conflict by re-reading inside the contention window.

use crate::schema::{DDL_V1, DDL_V2, STORE_SCHEMA_VERSION};
use nexus_contracts::{generation_key, KernelError, KernelErrorCode, KernelResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

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

fn db_fail(action: &str, err: impl std::fmt::Display) -> KernelError {
    KernelError::new(
        KernelErrorCode::StoreError,
        ["store ", action, " failed: ", &err.to_string()].concat(),
    )
}

fn sqlite_fail(action: &str, err: rusqlite::Error) -> KernelError {
    match err.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
            KernelError::new(
                KernelErrorCode::StoreCorrupt,
                [
                    "store ",
                    action,
                    " detected corruption; failing closed: ",
                    &err.to_string(),
                ]
                .concat(),
            )
        }
        _ => db_fail(action, err),
    }
}

pub struct GenerationInfo {
    pub epoch: u64,
    pub incarnation: String,
    pub witness_protected: bool,
}

pub enum SealOutcome {
    Created,
    Identical,
}

pub struct Store {
    conn: Connection,
    incarnation: String,
}

/// Outcome of one open attempt: either a transient lock-contention BUSY
/// (safe to retry) or a final error (fail closed at once).
enum OpenError {
    Busy,
    Fatal(KernelError),
}

impl From<KernelError> for OpenError {
    fn from(e: KernelError) -> Self {
        OpenError::Fatal(e)
    }
}

fn busy_or(action: &str, err: rusqlite::Error) -> OpenError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::DatabaseBusy => {
            OpenError::Busy
        }
        _ => OpenError::Fatal(sqlite_fail(action, err)),
    }
}

impl Store {
    pub fn open(path: &Path) -> KernelResult<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| db_fail("mkdir", e))?;
            }
        }
        // Concurrent first-open races (WAL setup, schema init) surface as
        // transient SQLITE_BUSY: lock-upgrade deadlocks bypass the
        // per-connection busy_timeout. Retry those boundedly; corruption,
        // incompatibility, and every other failure still fail closed at once.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match Self::open_once(path) {
                Ok(store) => return Ok(store),
                Err(OpenError::Busy) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(db_fail("open-contended", "database is locked"));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(OpenError::Fatal(e)) => return Err(e),
            }
        }
    }

    fn open_once(path: &Path) -> Result<Self, OpenError> {
        let conn = Connection::open(path).map_err(|e| busy_or("open", e))?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| sqlite_fail("busy_timeout", e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| busy_or("pragmas", e))?;
        let check: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| busy_or("integrity_check", e))?;
        if check != "ok" {
            return Err(OpenError::Fatal(KernelError::new(
                KernelErrorCode::StoreCorrupt,
                "kernel store integrity_check failed; failing closed",
            )));
        }
        conn.execute_batch(DDL_V1)
            .and_then(|_| conn.execute_batch(DDL_V2))
            .map_err(|e| busy_or("migrate", e))?;
        let version: Option<i64> = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .map_err(|e| busy_or("version", e))?;
        // Concurrent openers may stamp the schema row simultaneously: INSERT OR
        // IGNORE lets exactly one win; the re-read below converges losers with
        // the winner instead of failing on a uniqueness race.
        if version.is_none() {
            conn.execute(
                "INSERT OR IGNORE INTO schema_version (version, applied_at_utc) VALUES (?1, ?2)",
                params![STORE_SCHEMA_VERSION, now_utc()],
            )
            .map_err(|e| busy_or("version", e))?;
        }
        let version: Option<i64> = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .map_err(|e| busy_or("version", e))?;
        match version {
            Some(v) if v == STORE_SCHEMA_VERSION => {}
            Some(1) => {
                // A2.3 forward migration: v1 rows are preserved untouched;
                // only the version row advances (new tables arrived via
                // CREATE IF NOT EXISTS above). Concurrent migrators issue
                // the same idempotent UPDATE.
                conn.execute(
                    "UPDATE schema_version SET version = ?1, applied_at_utc = ?2 WHERE version = 1",
                    params![STORE_SCHEMA_VERSION, now_utc()],
                )
                .map_err(|e| busy_or("migrate", e))?;
            }
            Some(v) => {
                return Err(OpenError::Fatal(KernelError::new(
                    KernelErrorCode::StoreIncompatible,
                    [
                        "incompatible store schema version ",
                        &v.to_string(),
                        "; failing closed",
                    ]
                    .concat(),
                )));
            }
            // Our stamp was ignored yet no row is visible: the winner has not
            // committed yet. Retry rather than invent a version.
            None => return Err(OpenError::Busy),
        }
        let incarnation: Option<String> = conn
            .query_row(
                "SELECT value FROM store_meta WHERE key = 'store_incarnation'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| busy_or("identity", e))?;
        let incarnation = match incarnation {
            Some(s) => s,
            None => {
                // Same stamp race as schema_version (mirrors the issuance_key
                // pattern below): exactly one opener wins; losers adopt the
                // winner's incarnation instead of failing on uniqueness.
                let id = uuid::Uuid::new_v4().to_string();
                let applied = conn
                    .execute(
                        "INSERT OR IGNORE INTO store_meta (key, value) VALUES ('store_incarnation', ?1)",
                        params![id],
                    )
                    .map_err(|e| busy_or("identity", e))?;
                if applied == 1 {
                    id
                } else {
                    conn.query_row(
                        "SELECT value FROM store_meta WHERE key = 'store_incarnation'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| busy_or("identity", e))?
                }
            }
        };
        Ok(Self { conn, incarnation })
    }

    pub fn incarnation(&self) -> &str {
        &self.incarnation
    }

    pub fn issuance_key_hex(&mut self) -> KernelResult<String> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM store_meta WHERE key = 'issuance_key'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail("key", e))?;
        if let Some(k) = existing {
            return Ok(k);
        }
        let mut bytes = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut entropy| entropy.read_exact(&mut bytes))
            .map_err(|e| db_fail("entropy", e))?;
        let hexkey = hex::encode(bytes);
        let applied = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO store_meta (key, value) VALUES ('issuance_key', ?1)",
                params![hexkey],
            )
            .map_err(|e| db_fail("key", e))?;
        if applied == 1 {
            return Ok(hexkey);
        }
        let winner: String = self
            .conn
            .query_row(
                "SELECT value FROM store_meta WHERE key = 'issuance_key'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| db_fail("key", e))?;
        Ok(winner)
    }

    pub fn current_generation(
        &self,
        task: &str,
        backend: &str,
    ) -> KernelResult<Option<GenerationInfo>> {
        let gkey = generation_key(task, backend);
        let row: Option<(i64, String, i64)> = self.conn.query_row(
            "SELECT epoch, store_incarnation, witness_protected FROM generations WHERE generation_key = ?1",
            params![gkey], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional().map_err(|e| db_fail("read generation", e))?;
        Ok(row.map(|(e, i, w)| GenerationInfo {
            epoch: e as u64,
            incarnation: i,
            witness_protected: w != 0,
        }))
    }

    pub fn acquire_generation(
        &mut self,
        task: &str,
        backend: &str,
        witness_max: Option<u64>,
        mark_protected: bool,
    ) -> KernelResult<(u64, String)> {
        let gkey = generation_key(task, backend);
        let incarnation = self.incarnation.clone();
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let cur: Option<(i64, i64)> = tx
            .query_row(
                "SELECT epoch, witness_protected FROM generations WHERE generation_key = ?1",
                params![gkey],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        let mut next: u64 = match cur {
            Some((e, _)) => (e as u64) + 1,
            None => 1,
        };
        if let Some(wm) = witness_max {
            if wm + 1 > next {
                next = wm + 1;
            }
        }
        let already: i64 = cur.map(|(_, w)| w).unwrap_or(0);
        let prot: i64 = if mark_protected || already != 0 { 1 } else { 0 };
        tx.execute("INSERT INTO generations (generation_key, task_instance_id, backend, epoch, store_incarnation, witness_protected, acquired_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (generation_key) DO UPDATE SET epoch = excluded.epoch, witness_protected = excluded.witness_protected, acquired_at_utc = excluded.acquired_at_utc",
            params![gkey, task, backend, next as i64, incarnation, prot, now_utc()]).map_err(|e| db_fail("acquire", e))?;
        let payload = serde_json::json!({"taskInstanceId": task, "backend": backend, "leaseEpoch": next, "storeIncarnation": incarnation});
        let payload_json = serde_json::to_string(&payload).map_err(|e| db_fail("encode", e))?;
        tx.execute("INSERT INTO events (generation_key, kind, command_id, payload_json, recorded_at_utc) VALUES (?1, 'generation-acquired', NULL, ?2, ?3)", params![gkey, payload_json, now_utc()]).map_err(|e| db_fail("event", e))?;
        tx.commit().map_err(|e| db_fail("commit", e))?;
        Ok((next, incarnation))
    }

    pub fn seal_issuance(
        &mut self,
        issuance_id: &str,
        issued_json: &str,
        seal_hex: &str,
    ) -> KernelResult<SealOutcome> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT issued_json, seal_hex FROM sealed_issuances WHERE issuance_id = ?1",
                params![issuance_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        match existing {
            None => {
                tx.execute("INSERT INTO sealed_issuances (issuance_id, issued_json, seal_hex, created_at_utc) VALUES (?1, ?2, ?3, ?4)", params![issuance_id, issued_json, seal_hex, now_utc()]).map_err(|e| db_fail("seal", e))?;
                tx.commit().map_err(|e| db_fail("commit", e))?;
                Ok(SealOutcome::Created)
            }
            Some((stored_json, stored_seal)) => {
                let same = stored_seal == seal_hex && canonical_equal(&stored_json, issued_json);
                if same {
                    Ok(SealOutcome::Identical)
                } else {
                    Err(KernelError::new(
                        KernelErrorCode::IssuanceConflict,
                        "conflicting sealed issuance under the same issuance identity",
                    ))
                }
            }
        }
    }

    pub fn fetch_sealed(&self, issuance_id: &str) -> KernelResult<Option<(String, String)>> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT issued_json, seal_hex FROM sealed_issuances WHERE issuance_id = ?1",
                params![issuance_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        Ok(row)
    }

    pub fn seal_extension(
        &mut self,
        extension_digest: &str,
        extension_json: &str,
        seal_hex: &str,
    ) -> KernelResult<SealOutcome> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT extension_json, seal_hex FROM sealed_extensions WHERE extension_digest = ?1",
                params![extension_digest],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        match existing {
            None => {
                tx.execute("INSERT INTO sealed_extensions (extension_digest, extension_json, seal_hex, created_at_utc) VALUES (?1, ?2, ?3, ?4)", params![extension_digest, extension_json, seal_hex, now_utc()]).map_err(|e| db_fail("seal", e))?;
                tx.commit().map_err(|e| db_fail("commit", e))?;
                Ok(SealOutcome::Created)
            }
            Some((stored_json, stored_seal)) => {
                let same = stored_seal == seal_hex && canonical_equal(&stored_json, extension_json);
                if same {
                    Ok(SealOutcome::Identical)
                } else {
                    Err(KernelError::new(
                        KernelErrorCode::IssuanceConflict,
                        "conflicting sealed extension under the same digest identity",
                    ))
                }
            }
        }
    }

    pub fn fetch_extension(
        &self,
        extension_digest: &str,
    ) -> KernelResult<Option<(String, String)>> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT extension_json, seal_hex FROM sealed_extensions WHERE extension_digest = ?1",
                params![extension_digest],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        Ok(row)
    }

    pub fn publish_intent(
        &mut self,
        command_id: &str,
        intent_json: &str,
        seal_hex: &str,
    ) -> KernelResult<SealOutcome> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT intent_json, seal_hex, state FROM controller_intents WHERE command_id = ?1",
                params![command_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        match existing {
            None => {
                tx.execute("INSERT INTO controller_intents (command_id, intent_json, seal_hex, state, published_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?5)", params![command_id, intent_json, seal_hex, "published", now_utc()]).map_err(|e| db_fail("publish", e))?;
                tx.commit().map_err(|e| db_fail("commit", e))?;
                Ok(SealOutcome::Created)
            }
            Some((stored_json, stored_seal, state)) => {
                let same = state == "published"
                    && stored_seal == seal_hex
                    && canonical_equal(&stored_json, intent_json);
                if same {
                    Ok(SealOutcome::Identical)
                } else {
                    Err(KernelError::new(
                        KernelErrorCode::CommandConflict,
                        "conflicting or already-consumed intent under this command identity",
                    ))
                }
            }
        }
    }

    pub fn fetch_intent(&self, command_id: &str) -> KernelResult<Option<(String, String, String)>> {
        let row: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT intent_json, seal_hex, state FROM controller_intents WHERE command_id = ?1",
                params![command_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        Ok(row)
    }

    fn transition_intent(&mut self, command_id: &str, from: &str, to: &str) -> KernelResult<()> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let changed = tx
            .execute(
                "UPDATE controller_intents SET state = ?1, updated_at_utc = ?2 WHERE command_id = ?3 AND state = ?4",
                params![to, now_utc(), command_id, from],
            )
            .map_err(|e| db_fail("transition", e))?;
        if changed == 1 {
            tx.commit().map_err(|e| db_fail("commit", e))?;
            return Ok(());
        }
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM controller_intents WHERE command_id = ?1",
                params![command_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        match state {
            None => Err(KernelError::new(
                KernelErrorCode::IntentUnknown,
                "no published intent for this command identity",
            )),
            Some(s) => Err(KernelError::new(
                KernelErrorCode::CommandConflict,
                ["intent is ", &s, "; transition refused"].concat(),
            )),
        }
    }

    pub fn fence_intent(&mut self, command_id: &str) -> KernelResult<()> {
        match self.transition_intent(command_id, "published", "cancelled") {
            Ok(()) => Ok(()),
            Err(e) if e.code == KernelErrorCode::IntentUnknown => Err(e),
            Err(_) => Err(KernelError::new(
                KernelErrorCode::IntentFenced,
                "intent is not published; fencing refused",
            )),
        }
    }

    pub fn mark_intent_executed(&mut self, command_id: &str) -> KernelResult<()> {
        self.transition_intent(command_id, "published", "executed")
    }
}

impl Store {
    pub(crate) fn conn_ref(&self) -> &rusqlite::Connection {
        &self.conn
    }
    #[allow(mismatched_lifetime_syntaxes)]
    pub(crate) fn conn_mut(&mut self) -> &mut rusqlite::Connection {
        &mut self.conn
    }
    #[allow(mismatched_lifetime_syntaxes)]
    pub(crate) fn conn_tx(&mut self) -> rusqlite::Result<rusqlite::Transaction> {
        self.conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
    }
}

pub(crate) fn now_utc_pub() -> String {
    now_utc()
}
pub(crate) fn db_fail_pub(action: &str, err: impl std::fmt::Display) -> KernelError {
    db_fail(action, err)
}
fn canonical_equal(a_json: &str, b_json: &str) -> bool {
    let a: serde_json::Value = match serde_json::from_str(a_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let b: serde_json::Value = match serde_json::from_str(b_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    nexus_contracts::canonical_json(&a) == nexus_contracts::canonical_json(&b)
}
