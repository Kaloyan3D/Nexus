//! Atomic command acceptance, durable receipts and the event journal.
//! Acceptance is ONE SQLite transaction: command row + journal event +
//! receipt row commit together or not at all. Replay inside the same
//! contention window re-reads the winner and classifies idempotent vs
//! conflict without ever overwriting prior authority.

use crate::store::{db_fail_pub, now_utc_pub};
use nexus_contracts::{
    generation_key, CommandReceiptV1, KernelError, KernelErrorCode, KernelEventKind, KernelEventV1,
    KernelResult, ReceiptStatus, CONTRACT_SCHEMA_VERSION,
};
use rusqlite::{params, OptionalExtension};

pub struct AcceptInput {
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub backend: String,
    pub controller_revision: i64,
    pub role: String,
    pub mode_id: String,
    pub mode_config_revision_json: String,
    pub payload_json: String,
    pub payload_digest: String,
    pub intent_digest: String,
    pub target_json: String,
    pub snapshot_digest: String,
    pub target_digest: String,
    pub issuance_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub command_digest: String,
}

pub struct AcceptOutcome {
    pub receipt: CommandReceiptV1,
    pub created: bool,
}

type ReceiptRow = (
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
);

impl crate::store::Store {
    pub fn accept_command(&mut self, input: &AcceptInput) -> KernelResult<AcceptOutcome> {
        let gkey = generation_key(&input.task_instance_id, &input.backend);
        let incarnation = self.incarnation().to_owned();
        let tx = self.conn_tx().map_err(|e| db_fail_pub("begin", e))?;
        let sealed: Option<String> = tx
            .query_row(
                "SELECT seal_hex FROM sealed_issuances WHERE issuance_id = ?1",
                params![input.issuance_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read seal", e))?;
        if sealed.is_none() {
            return Err(KernelError::new(
                KernelErrorCode::ForgedIssuer,
                "no verified sealed issuance for this target",
            ));
        }
        let cur: Option<(i64, String)> = tx
            .query_row(
                "SELECT epoch, store_incarnation FROM generations WHERE generation_key = ?1",
                params![gkey],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| db_fail_pub("read generation", e))?;
        match cur {
            Some((epoch, si)) => {
                if epoch as u64 != input.lease_epoch
                    || si != input.store_incarnation
                    || si != incarnation
                {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "stale or superseded lease epoch",
                    ));
                }
            }
            None => {
                return Err(KernelError::new(
                    KernelErrorCode::StaleLease,
                    "missing lease authorization",
                ));
            }
        }
        let existing: Option<(String, String, String, String, i64, String)> = tx.query_row(
            "SELECT command_digest, intent_digest, target_digest, snapshot_digest, lease_epoch, issuance_id FROM commands WHERE command_id = ?1",
            params![input.command_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional().map_err(|e| db_fail_pub("read command", e))?;
        if let Some((digest, intent_d, target_d, snap_d, epoch, iss)) = existing {
            let identical = digest == input.command_digest
                && intent_d == input.intent_digest
                && target_d == input.target_digest
                && snap_d == input.snapshot_digest
                && epoch as u64 == input.lease_epoch
                && iss == input.issuance_id;
            if identical {
                let receipt = read_receipt_in(&tx, &input.command_id)?;
                tx.commit().map_err(|e| db_fail_pub("commit", e))?;
                return Ok(AcceptOutcome {
                    receipt,
                    created: false,
                });
            }
            return Err(KernelError::new(
                KernelErrorCode::CommandConflict,
                "commandId reuses a different immutable envelope",
            ));
        }
        tx.execute("INSERT INTO commands (command_id, task_instance_id, attempt_id, backend, controller_revision, role, mode_id, mode_config_revision_json, payload_json, payload_digest, intent_digest, target_json, snapshot_digest, target_digest, issuance_id, lease_epoch, store_incarnation, command_digest, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![input.command_id, input.task_instance_id, input.attempt_id, input.backend, input.controller_revision, input.role, input.mode_id, input.mode_config_revision_json, input.payload_json, input.payload_digest, input.intent_digest, input.target_json, input.snapshot_digest, input.target_digest, input.issuance_id, input.lease_epoch as i64, input.store_incarnation, input.command_digest, now_utc_pub()]).map_err(|e| db_fail_pub("insert command", e))?;
        let event_payload = [
            "{\"commandDigest\":\"",
            &input.command_digest,
            "\",\"commandId\":\"",
            &input.command_id,
            "\",\"leaseEpoch\":",
            &input.lease_epoch.to_string(),
            "}",
        ]
        .concat();
        tx.execute("INSERT INTO events (generation_key, kind, command_id, payload_json, recorded_at_utc) VALUES (?1, 'command-accepted', ?2, ?3, ?4)", params![gkey, input.command_id, event_payload, now_utc_pub()]).map_err(|e| db_fail_pub("event", e))?;
        let seq = tx.last_insert_rowid();
        let accepted_at = now_utc_pub();
        tx.execute("INSERT INTO receipts (command_id, command_digest, task_instance_id, attempt_id, lease_epoch, store_incarnation, target_digest, snapshot_digest, issuance_id, status, event_seq, accepted_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'accepted-reserved-dispatch-disabled', ?10, ?11)",
            params![input.command_id, input.command_digest, input.task_instance_id, input.attempt_id, input.lease_epoch as i64, input.store_incarnation, input.target_digest, input.snapshot_digest, input.issuance_id, seq, accepted_at]).map_err(|e| db_fail_pub("receipt", e))?;
        tx.commit().map_err(|e| db_fail_pub("commit", e))?;
        Ok(AcceptOutcome {
            receipt: CommandReceiptV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                command_id: input.command_id.clone(),
                command_digest: input.command_digest.clone(),
                task_instance_id: input.task_instance_id.clone(),
                attempt_id: input.attempt_id.clone(),
                lease_epoch: input.lease_epoch,
                store_incarnation: input.store_incarnation.clone(),
                target_digest: input.target_digest.clone(),
                snapshot_digest: input.snapshot_digest.clone(),
                issuance_id: input.issuance_id.clone(),
                status: ReceiptStatus::AcceptedReservedDispatchDisabled,
                event_seq: seq,
                accepted_at_utc: accepted_at,
            },
            created: true,
        })
    }

    pub fn read_receipt(&self, command_id: &str) -> KernelResult<Option<CommandReceiptV1>> {
        let row: Option<ReceiptRow> = self.conn_ref().query_row(
            "SELECT command_digest, task_instance_id, attempt_id, lease_epoch, store_incarnation, target_digest, snapshot_digest, issuance_id, status, event_seq, accepted_at_utc FROM receipts WHERE command_id = ?1",
            params![command_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
        ).optional().map_err(|e| db_fail_pub("read receipt", e))?;
        Ok(row.map(
            |(digest, task, attempt, epoch, si, td, sd, iss, _status, seq, at)| CommandReceiptV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                command_id: command_id.to_owned(),
                command_digest: digest,
                task_instance_id: task,
                attempt_id: attempt,
                lease_epoch: epoch as u64,
                store_incarnation: si,
                target_digest: td,
                snapshot_digest: sd,
                issuance_id: iss,
                status: ReceiptStatus::AcceptedReservedDispatchDisabled,
                event_seq: seq,
                accepted_at_utc: at,
            },
        ))
    }

    pub fn list_events(&self, generation: &str) -> KernelResult<Vec<KernelEventV1>> {
        let mut stmt = self.conn_ref().prepare("SELECT seq, generation_key, kind, command_id, payload_json, recorded_at_utc FROM events WHERE generation_key = ?1 ORDER BY seq ASC").map_err(|e| db_fail_pub("events", e))?;
        let rows = stmt
            .query_map(params![generation], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| db_fail_pub("events", e))?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, gkey, kind, command_id, payload_json, at) =
                row.map_err(|e| db_fail_pub("events", e))?;
            let kind = KernelEventKind::parse_kind(&kind).ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "unknown event kind in journal",
                )
            })?;
            let payload: serde_json::Value = serde_json::from_str(&payload_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "journal payload is corrupted",
                )
            })?;
            out.push(KernelEventV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                seq,
                generation_key: gkey,
                kind,
                command_id,
                payload,
                recorded_at_utc: at,
            });
        }
        Ok(out)
    }

    pub fn list_all_events(&self) -> KernelResult<Vec<KernelEventV1>> {
        let mut stmt = self.conn_ref().prepare("SELECT seq, generation_key, kind, command_id, payload_json, recorded_at_utc FROM events ORDER BY seq ASC").map_err(|e| db_fail_pub("events", e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| db_fail_pub("events", e))?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, gkey, kind, command_id, payload_json, at) =
                row.map_err(|e| db_fail_pub("events", e))?;
            let kind = KernelEventKind::parse_kind(&kind).ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "unknown event kind in journal",
                )
            })?;
            let payload: serde_json::Value = serde_json::from_str(&payload_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "journal payload is corrupted",
                )
            })?;
            out.push(KernelEventV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                seq,
                generation_key: gkey,
                kind,
                command_id,
                payload,
                recorded_at_utc: at,
            });
        }
        Ok(out)
    }

    pub fn count_commands(&self) -> KernelResult<i64> {
        self.conn_ref()
            .query_row("SELECT COUNT(*) FROM commands", [], |r| r.get(0))
            .map_err(|e| db_fail_pub("count", e))
    }

    pub fn count_receipts(&self) -> KernelResult<i64> {
        self.conn_ref()
            .query_row("SELECT COUNT(*) FROM receipts", [], |r| r.get(0))
            .map_err(|e| db_fail_pub("count", e))
    }
}

impl crate::store::Store {
    pub fn record_event(
        &mut self,
        generation: &str,
        kind: &str,
        command_id: Option<&str>,
        payload_json: &str,
    ) -> KernelResult<i64> {
        self.conn_mut().execute("INSERT INTO events (generation_key, kind, command_id, payload_json, recorded_at_utc) VALUES (?1, ?2, ?3, ?4, ?5)", rusqlite::params![generation, kind, command_id, payload_json, now_utc_pub()]).map_err(|e| db_fail_pub("event", e))?;
        Ok(self.conn_mut().last_insert_rowid())
    }
}
#[allow(mismatched_lifetime_syntaxes)]
fn read_receipt_in(tx: &rusqlite::Transaction, command_id: &str) -> KernelResult<CommandReceiptV1> {
    let row: Option<ReceiptRow> = tx.query_row(
        "SELECT command_digest, task_instance_id, attempt_id, lease_epoch, store_incarnation, target_digest, snapshot_digest, issuance_id, status, event_seq, accepted_at_utc FROM receipts WHERE command_id = ?1",
        params![command_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
    ).optional().map_err(|e| db_fail_pub("read receipt", e))?;
    match row {
        Some((digest, task, attempt, epoch, si, td, sd, iss, _status, seq, at)) => {
            Ok(CommandReceiptV1 {
                schema_version: CONTRACT_SCHEMA_VERSION,
                command_id: command_id.to_owned(),
                command_digest: digest,
                task_instance_id: task,
                attempt_id: attempt,
                lease_epoch: epoch as u64,
                store_incarnation: si,
                target_digest: td,
                snapshot_digest: sd,
                issuance_id: iss,
                status: ReceiptStatus::AcceptedReservedDispatchDisabled,
                event_seq: seq,
                accepted_at_utc: at,
            })
        }
        None => Err(db_fail_pub(
            "read receipt",
            "missing receipt for accepted command",
        )),
    }
}
