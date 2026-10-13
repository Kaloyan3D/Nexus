//! Independent rollback witness (separate SQLite file, separate failure domain).
//! Tracks monotonic maxEpoch plus accepted-receipt progress per generation.
//! Same-DB counters cannot detect rollback; this file must live outside the
//! restored store to detect it. All reads are fail-closed: corruption maps
//! to reconciliation-required, never a raw error and never a silent skip.

use crate::schema::WITNESS_DDL_V1;
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
        Ok(Self { conn })
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
}
