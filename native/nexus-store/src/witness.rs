//! Independent rollback witness (separate SQLite file, separate failure domain).
//! Tracks monotonic maxEpoch plus accepted-receipt progress per generation.
//! Same-DB counters cannot detect rollback; this file must live outside the
//! restored store to detect it. All reads are fail-closed: corruption maps
//! to reconciliation-required, never a raw error and never a silent skip.

use crate::schema::{WITNESS_DDL_V1, WITNESS_DDL_V2, WITNESS_SCHEMA_VERSION};
use nexus_contracts::{KernelError, KernelErrorCode, KernelResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcceptedEntry {
    pub command_digest: String,
    pub lease_epoch: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WitnessRecord {
    pub generation_key: String,
    pub max_epoch: u64,
    pub store_incarnation: String,
    pub accepted: BTreeMap<String, AcceptedEntry>,
    pub baseline_json: Option<String>,
}

/// A2.0 dispatch-reservation lifecycle: unseen -> prepared -> acknowledged.
/// `abandoned` is the safe terminal non-success state for expired prepared
/// reservations (never execution evidence, never replayable without
/// re-preparation). Acknowledged reservations are never pruned while their
/// generation lives; only abandoned rows may be deleted explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservationState {
    Prepared,
    Acknowledged,
    Abandoned,
}

impl ReservationState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Acknowledged => "acknowledged",
            Self::Abandoned => "abandoned",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "prepared" => Some(Self::Prepared),
            "acknowledged" => Some(Self::Acknowledged),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservationRecord {
    pub command_id: String,
    pub generation_key: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub command_digest: String,
    pub issuance_id: String,
    pub state: ReservationState,
    pub prepared_at_utc: String,
    pub acknowledged_at_utc: Option<String>,
}

/// One dispatch_reservations row: (generation_key, task_instance_id,
/// attempt_id, store_incarnation, lease_epoch, command_digest, issuance_id,
/// state, prepared_at_utc, acknowledged_at_utc).
type ReservationRow = (
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    String,
    Option<String>,
);

fn prepared_secs(stamp: &str) -> Option<u64> {
    stamp.split('.').next()?.parse::<u64>().ok()
}

pub struct WitnessStore {
    conn: Connection,
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

fn db_fail(action: &str, err: impl std::fmt::Display) -> KernelError {
    KernelError::new(
        KernelErrorCode::StoreError,
        ["witness ", action, " failed: ", &err.to_string()].concat(),
    )
}

impl WitnessStore {
    pub fn open(path: &Path) -> KernelResult<Self> {
        let existed = path.exists();
        let conn = Connection::open(path).map_err(|e| {
            if existed {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness store is unreadable; rollback protection cannot be verified",
                )
            } else {
                db_fail("open", e)
            }
        })?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| db_fail("busy_timeout", e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| {
            if existed {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness store is unreadable; rollback protection cannot be verified",
                )
            } else {
                db_fail("pragmas", e)
            }
        })?;
        conn.execute_batch(WITNESS_DDL_V1).map_err(|e| {
            if existed {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness store is corrupted; rollback protection cannot be verified",
                )
            } else {
                db_fail("migrate", e)
            }
        })?;
        // A2.0 v2 migration: additive only, preserves all v1 state.
        conn.execute_batch(WITNESS_DDL_V2).map_err(|e| {
            if existed {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness store is corrupted; rollback protection cannot be verified",
                )
            } else {
                db_fail("migrate-reservations", e)
            }
        })?;
        let version: Option<i64> = conn
            .query_row(
                "SELECT value FROM witness_meta WHERE key = 'witness_schema_version'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| db_fail("version", e))?
            .and_then(|s| s.parse::<i64>().ok());
        match version {
            None => {
                conn.execute(
                    "INSERT OR REPLACE INTO witness_meta (key, value) VALUES ('witness_schema_version', ?1)",
                    params![WITNESS_SCHEMA_VERSION.to_string()],
                )
                .map_err(|e| db_fail("version", e))?;
            }
            Some(v) if v == WITNESS_SCHEMA_VERSION => {}
            Some(v) if v < WITNESS_SCHEMA_VERSION => {
                conn.execute(
                    "INSERT OR REPLACE INTO witness_meta (key, value) VALUES ('witness_schema_version', ?1)",
                    params![WITNESS_SCHEMA_VERSION.to_string()],
                )
                .map_err(|e| db_fail("version", e))?;
            }
            Some(_) => {
                return Err(KernelError::new(
                    KernelErrorCode::StoreIncompatible,
                    "incompatible witness schema version; failing closed",
                ));
            }
        }
        Ok(Self { conn })
    }

    /// Opaque key/value cell in `witness_meta` (used for the A3.1 tool
    /// journal checkpoint). Keys are namespaced by the caller.
    pub fn get_meta(&self, key: &str) -> KernelResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT value FROM witness_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail("read meta", e))
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> KernelResult<()> {
        self.conn
            .execute(
                "INSERT INTO witness_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| db_fail("write meta", e))?;
        Ok(())
    }

    pub fn read(&self, generation_key: &str) -> KernelResult<Option<WitnessRecord>> {
        let row: Option<(i64, String, String, Option<String>)> = self.conn.query_row(
            "SELECT max_epoch, store_incarnation, accepted_json, baseline_json FROM witness_state WHERE generation_key = ?1",
            params![generation_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional().map_err(|_| KernelError::new(KernelErrorCode::ReconciliationRequired, "witness record is corrupted; rollback protection cannot be verified"))?;
        match row {
            None => Ok(None),
            Some((max_epoch, incarnation, accepted_json, baseline_json)) => {
                if max_epoch < 0 {
                    return Err(KernelError::new(
                        KernelErrorCode::ReconciliationRequired,
                        "witness record is malformed",
                    ));
                }
                let accepted: BTreeMap<String, AcceptedEntry> =
                    serde_json::from_str(&accepted_json).map_err(|_| {
                        KernelError::new(
                            KernelErrorCode::ReconciliationRequired,
                            "witness record is corrupted; rollback protection cannot be verified",
                        )
                    })?;
                Ok(Some(WitnessRecord {
                    generation_key: generation_key.to_owned(),
                    max_epoch: max_epoch as u64,
                    store_incarnation: incarnation,
                    accepted,
                    baseline_json,
                }))
            }
        }
    }

    pub fn note_epoch(
        &mut self,
        generation_key: &str,
        epoch: u64,
        incarnation: &str,
        accepted: Option<(&str, &str, u64)>,
    ) -> KernelResult<WitnessRecord> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let existing: Option<(i64, String, String, Option<String>)> = tx.query_row(
            "SELECT max_epoch, store_incarnation, accepted_json, baseline_json FROM witness_state WHERE generation_key = ?1",
            params![generation_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional().map_err(|e| db_fail("read", e))?;
        let mut map: BTreeMap<String, AcceptedEntry> = BTreeMap::new();
        let mut max_epoch: u64 = 0;
        let mut base_incarnation = incarnation.to_owned();
        let mut baseline: Option<String> = None;
        if let Some((me, si, aj, bl)) = existing {
            max_epoch = me.max(0) as u64;
            base_incarnation = si;
            baseline = bl;
            map = serde_json::from_str(&aj).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness record is corrupted; refusing to overwrite blindly",
                )
            })?;
        }
        if epoch > max_epoch {
            max_epoch = epoch;
        }
        if let Some((cid, digest, le)) = accepted {
            map.insert(
                cid.to_owned(),
                AcceptedEntry {
                    command_digest: digest.to_owned(),
                    lease_epoch: le,
                },
            );
        }
        let accepted_json = serde_json::to_string(&map).map_err(|e| db_fail("encode", e))?;
        tx.execute("INSERT INTO witness_state (generation_key, max_epoch, store_incarnation, accepted_json, baseline_json, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (generation_key) DO UPDATE SET max_epoch = excluded.max_epoch, accepted_json = excluded.accepted_json, updated_at_utc = excluded.updated_at_utc",
            params![generation_key, max_epoch as i64, base_incarnation, accepted_json, baseline, now_utc()]).map_err(|e| db_fail("write", e))?;
        tx.commit().map_err(|e| db_fail("commit", e))?;
        Ok(WitnessRecord {
            generation_key: generation_key.to_owned(),
            max_epoch,
            store_incarnation: base_incarnation,
            accepted: map,
            baseline_json: baseline,
        })
    }

    pub fn write_recovery_baseline(
        &mut self,
        generation_key: &str,
        baseline: &serde_json::Value,
        fenced_epoch: u64,
        incarnation: &str,
    ) -> KernelResult<()> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let existing: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT accepted_json, baseline_json FROM witness_state WHERE generation_key = ?1",
                params![generation_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail("read", e))?;
        let accepted_json = match existing {
            Some((aj, _)) => aj,
            None => "{}".to_owned(),
        };
        let baseline_json = serde_json::to_string(baseline).map_err(|e| db_fail("encode", e))?;
        tx.execute("INSERT INTO witness_state (generation_key, max_epoch, store_incarnation, accepted_json, baseline_json, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (generation_key) DO UPDATE SET max_epoch = excluded.max_epoch, baseline_json = excluded.baseline_json, updated_at_utc = excluded.updated_at_utc",
            params![generation_key, fenced_epoch as i64, incarnation, accepted_json, baseline_json, now_utc()]).map_err(|e| db_fail("write", e))?;
        tx.commit().map_err(|e| db_fail("commit", e))?;
        Ok(())
    }

    /// A2.0: durable independent reservation. Called BEFORE the main-store
    /// commit; binds commandId + attemptId + generation + lease epoch +
    /// incarnation + immutable command digest + issuance. Idempotent for a
    /// byte-identical binding; any binding difference fails closed with
    /// command-conflict so prior authority is never overwritten.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_reservation(
        &mut self,
        generation_key: &str,
        task_instance_id: &str,
        attempt_id: &str,
        command_id: &str,
        lease_epoch: u64,
        store_incarnation: &str,
        command_digest: &str,
        issuance_id: &str,
    ) -> KernelResult<ReservationRecord> {
        if command_id.is_empty() || command_digest.is_empty() || issuance_id.is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "reservation binding is required",
            ));
        }
        if let Some(existing) = self.read_reservation(command_id)? {
            let identical = existing.generation_key == generation_key
                && existing.task_instance_id == task_instance_id
                && existing.attempt_id == attempt_id
                && existing.lease_epoch == lease_epoch
                && existing.store_incarnation == store_incarnation
                && existing.command_digest == command_digest
                && existing.issuance_id == issuance_id;
            if !identical {
                return Err(KernelError::new(
                    KernelErrorCode::CommandConflict,
                    "commandId reuses a different immutable reservation binding",
                ));
            }
            if existing.state == ReservationState::Abandoned {
                // Identical re-preparation after expiry re-arms the
                // reservation; it invents no execution success.
                let now = now_utc();
                self.conn.execute(
                    "UPDATE dispatch_reservations SET state = 'prepared', prepared_at_utc = ?1, acknowledged_at_utc = NULL, updated_at_utc = ?1 WHERE command_id = ?2",
                    params![now, command_id],
                ).map_err(|e| db_fail("re-prepare", e))?;
                return Ok(ReservationRecord {
                    state: ReservationState::Prepared,
                    ..existing
                });
            }
            return Ok(existing);
        }
        let now = now_utc();
        self.conn.execute(
            "INSERT INTO dispatch_reservations (command_id, generation_key, task_instance_id, attempt_id, lease_epoch, store_incarnation, command_digest, issuance_id, state, prepared_at_utc, acknowledged_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'prepared', ?9, NULL, ?9)",
            params![command_id, generation_key, task_instance_id, attempt_id, lease_epoch as i64, store_incarnation, command_digest, issuance_id, now],
        ).map_err(|e| db_fail("prepare", e))?;
        Ok(ReservationRecord {
            command_id: command_id.to_owned(),
            generation_key: generation_key.to_owned(),
            task_instance_id: task_instance_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            lease_epoch,
            store_incarnation: store_incarnation.to_owned(),
            command_digest: command_digest.to_owned(),
            issuance_id: issuance_id.to_owned(),
            state: ReservationState::Prepared,
            prepared_at_utc: now.clone(),
            acknowledged_at_utc: None,
        })
    }

    /// A2.0: acknowledge a prepared reservation AFTER the main-store commit.
    /// The witness accepted-map entry is written in the same witness
    /// transaction, so acknowledgement and replay protection move together.
    pub fn acknowledge_reservation(
        &mut self,
        command_id: &str,
        command_digest: &str,
        lease_epoch: u64,
    ) -> KernelResult<ReservationRecord> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| db_fail("begin", e))?;
        let row: Option<ReservationRow> = tx.query_row(
            "SELECT generation_key, task_instance_id, attempt_id, store_incarnation, lease_epoch, command_digest, issuance_id, state, prepared_at_utc, acknowledged_at_utc FROM dispatch_reservations WHERE command_id = ?1",
            params![command_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        ).optional().map_err(|e| db_fail("read", e))?;
        let (gkey, task, attempt, incarnation, epoch, digest, issuance, state_s, prepared_at, _ack) =
            match row {
                Some(v) => v,
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::ReconciliationRequired,
                        "witness reservation is missing; refusing to invent acknowledgement",
                    ));
                }
            };
        if digest != command_digest || epoch as u64 != lease_epoch {
            return Err(KernelError::new(
                KernelErrorCode::CommandConflict,
                "acknowledgement binding differs from the prepared reservation",
            ));
        }
        let state = ReservationState::parse(&state_s).ok_or_else(|| {
            KernelError::new(
                KernelErrorCode::ReconciliationRequired,
                "witness reservation is corrupted; rollback protection cannot be verified",
            )
        })?;
        if state == ReservationState::Abandoned {
            return Err(KernelError::new(
                KernelErrorCode::ReservationExpired,
                "reservation was abandoned after expiry; re-prepare before acknowledgement",
            ));
        }
        let now = now_utc();
        tx.execute(
            "UPDATE dispatch_reservations SET state = 'acknowledged', acknowledged_at_utc = ?1, updated_at_utc = ?1 WHERE command_id = ?2",
            params![now, command_id],
        ).map_err(|e| db_fail("acknowledge", e))?;
        // Move replay protection together with the acknowledgement.
        let existing: Option<(i64, String, String, Option<String>)> = tx.query_row(
            "SELECT max_epoch, store_incarnation, accepted_json, baseline_json FROM witness_state WHERE generation_key = ?1",
            params![gkey],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional().map_err(|e| db_fail("read", e))?;
        let mut map: BTreeMap<String, AcceptedEntry> = BTreeMap::new();
        let mut max_epoch: u64 = 0;
        let mut base_incarnation = incarnation.clone();
        let mut baseline: Option<String> = None;
        if let Some((me, si, aj, bl)) = existing {
            max_epoch = me.max(0) as u64;
            base_incarnation = si;
            baseline = bl;
            map = serde_json::from_str(&aj).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness record is corrupted; refusing to overwrite blindly",
                )
            })?;
        }
        if lease_epoch > max_epoch {
            max_epoch = lease_epoch;
        }
        map.insert(
            command_id.to_owned(),
            AcceptedEntry {
                command_digest: digest.clone(),
                lease_epoch,
            },
        );
        let accepted_json = serde_json::to_string(&map).map_err(|e| db_fail("encode", e))?;
        tx.execute("INSERT INTO witness_state (generation_key, max_epoch, store_incarnation, accepted_json, baseline_json, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (generation_key) DO UPDATE SET max_epoch = excluded.max_epoch, accepted_json = excluded.accepted_json, updated_at_utc = excluded.updated_at_utc",
            params![gkey, max_epoch as i64, base_incarnation, accepted_json, baseline, now]).map_err(|e| db_fail("write", e))?;
        tx.commit().map_err(|e| db_fail("commit", e))?;
        Ok(ReservationRecord {
            command_id: command_id.to_owned(),
            generation_key: gkey,
            task_instance_id: task,
            attempt_id: attempt,
            lease_epoch,
            store_incarnation: incarnation,
            command_digest: digest,
            issuance_id: issuance,
            state: ReservationState::Acknowledged,
            prepared_at_utc: prepared_at,
            acknowledged_at_utc: Some(now),
        })
    }

    pub fn read_reservation(&self, command_id: &str) -> KernelResult<Option<ReservationRecord>> {
        let row: Option<ReservationRow> = self.conn.query_row(
            "SELECT generation_key, task_instance_id, attempt_id, store_incarnation, lease_epoch, command_digest, issuance_id, state, prepared_at_utc, acknowledged_at_utc FROM dispatch_reservations WHERE command_id = ?1",
            params![command_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        ).optional().map_err(|_| KernelError::new(KernelErrorCode::ReconciliationRequired, "witness reservation record is corrupted; rollback protection cannot be verified"))?;
        match row {
            None => Ok(None),
            Some((
                gkey,
                task,
                attempt,
                incarnation,
                epoch,
                digest,
                issuance,
                state_s,
                prepared_at,
                ack_at,
            )) => {
                if epoch < 0 {
                    return Err(KernelError::new(
                        KernelErrorCode::ReconciliationRequired,
                        "witness reservation is malformed",
                    ));
                }
                let state = ReservationState::parse(&state_s).ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::ReconciliationRequired,
                        "witness reservation is corrupted; rollback protection cannot be verified",
                    )
                })?;
                Ok(Some(ReservationRecord {
                    command_id: command_id.to_owned(),
                    generation_key: gkey,
                    task_instance_id: task,
                    attempt_id: attempt,
                    lease_epoch: epoch as u64,
                    store_incarnation: incarnation,
                    command_digest: digest,
                    issuance_id: issuance,
                    state,
                    prepared_at_utc: prepared_at,
                    acknowledged_at_utc: ack_at,
                }))
            }
        }
    }

    pub fn reservations_for_generation(
        &self,
        generation_key: &str,
    ) -> KernelResult<Vec<ReservationRecord>> {
        let mut stmt = self.conn.prepare("SELECT command_id, task_instance_id, attempt_id, lease_epoch, store_incarnation, command_digest, issuance_id, state, prepared_at_utc, acknowledged_at_utc FROM dispatch_reservations WHERE generation_key = ?1 ORDER BY prepared_at_utc ASC").map_err(|e| db_fail("read", e))?;
        let rows = stmt
            .query_map(params![generation_key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|e| db_fail("read", e))?;
        let mut out = Vec::new();
        for row in rows {
            let (
                cid,
                task,
                attempt,
                epoch,
                incarnation,
                digest,
                issuance,
                state_s,
                prepared_at,
                ack_at,
            ) = row.map_err(|_| {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness reservation record is corrupted",
                )
            })?;
            let state = ReservationState::parse(&state_s).ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::ReconciliationRequired,
                    "witness reservation is corrupted",
                )
            })?;
            out.push(ReservationRecord {
                command_id: cid,
                generation_key: generation_key.to_owned(),
                task_instance_id: task,
                attempt_id: attempt,
                lease_epoch: epoch.max(0) as u64,
                store_incarnation: incarnation,
                command_digest: digest,
                issuance_id: issuance,
                state,
                prepared_at_utc: prepared_at,
                acknowledged_at_utc: ack_at,
            });
        }
        Ok(out)
    }

    /// Recover abandoned reservations without inventing execution success.
    /// Only `prepared` reservations older than `max_age_secs` transition to
    /// `abandoned`; acknowledged reservations and accepted-map entries are
    /// never touched. Abandoned is a safe terminal non-success state: the
    /// command was never accepted and never will be under this reservation.
    /// Retention rule: acknowledged reservations and accepted entries are
    /// retained while their generation lives and are NEVER pruned here;
    /// only abandoned rows may be deleted, explicitly, via
    /// `delete_abandoned`, and only after they exceed `retention_secs`.
    pub fn reap_abandoned(&mut self, max_age_secs: u64) -> KernelResult<u64> {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut stmt = self.conn.prepare("SELECT command_id, prepared_at_utc FROM dispatch_reservations WHERE state = 'prepared'").map_err(|e| db_fail("read", e))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| db_fail("read", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail("read", e))?;
        drop(stmt);
        let mut reaped = 0u64;
        for (cid, prepared_at) in rows {
            let age = prepared_secs(&prepared_at)
                .map(|t| now_secs.saturating_sub(t))
                .unwrap_or(u64::MAX);
            if age >= max_age_secs {
                let now = now_utc();
                self.conn.execute("UPDATE dispatch_reservations SET state = 'abandoned', updated_at_utc = ?1 WHERE command_id = ?2 AND state = 'prepared'", params![now, cid]).map_err(|e| db_fail("reap", e))?;
                reaped += 1;
            }
        }
        Ok(reaped)
    }

    /// Delete only abandoned reservations older than `retention_secs`.
    /// Prepared and acknowledged rows are never deleted; returns the number
    /// removed. Replay protection lives in the accepted-map, which this
    /// function cannot erase by construction.
    pub fn delete_abandoned(&mut self, retention_secs: u64) -> KernelResult<u64> {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut stmt = self.conn.prepare("SELECT command_id, updated_at_utc FROM dispatch_reservations WHERE state = 'abandoned'").map_err(|e| db_fail("read", e))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| db_fail("read", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail("read", e))?;
        drop(stmt);
        let mut removed = 0u64;
        for (cid, updated_at) in rows {
            let age = prepared_secs(&updated_at)
                .map(|t| now_secs.saturating_sub(t))
                .unwrap_or(0);
            if age >= retention_secs {
                self.conn.execute("DELETE FROM dispatch_reservations WHERE command_id = ?1 AND state = 'abandoned'", params![cid]).map_err(|e| db_fail("prune", e))?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}
