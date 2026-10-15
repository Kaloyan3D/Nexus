//! A3.1 durable tool-execution journal.
//!
//! Append-only and tamper-evident: every entry carries the hash of its
//! predecessor and an HMAC seal under the store's issuance key, so a
//! forged, edited, reordered or mid-chain-deleted row fails
//! `verify_tool_journal`. (Truncating the *tail* is not detectable without
//! an external witness; documented as a limitation.)
//!
//! Each `(request_id, phase)` pair exists at most once, which makes every
//! lifecycle transition (authorized / started / completed) exactly-once.

use crate::store::{db_fail_pub, now_utc_pub, Store};
use nexus_contracts::{canonical_json, sha256_hex, KernelError, KernelErrorCode, KernelResult};
use rusqlite::{params, OptionalExtension};

pub const TOOL_JOURNAL_GENESIS: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone)]
pub struct ToolEntryInput {
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub phase: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolJournalEntry {
    pub seq: i64,
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub phase: String,
    pub payload: serde_json::Value,
    pub prev_hash: String,
    pub entry_hash: String,
    pub recorded_at_utc: String,
}

fn entry_hash_of(prev: &str, input: &ToolEntryInput, recorded_at: &str) -> String {
    let v = serde_json::json!({
        "prev": prev,
        "requestId": input.request_id,
        "executionId": input.execution_id,
        "taskInstanceId": input.task_instance_id,
        "attemptId": input.attempt_id,
        "commandId": input.command_id,
        "phase": input.phase,
        "payload": input.payload,
        "recordedAtUtc": recorded_at,
    });
    sha256_hex(&canonical_json(&v))
}

fn seal_of(key_hex: &str, entry_hash: &str) -> KernelResult<String> {
    use hmac::Mac;
    let key = hex::decode(key_hex)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is corrupted"))?;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&key)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is invalid"))?;
    mac.update(b"nexus-tool-journal/v1|");
    mac.update(entry_hash.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

type Row = (
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

const COLS: &str = "seq, request_id, execution_id, task_instance_id, attempt_id, command_id, phase, payload_json, prev_hash, entry_hash, seal_hex, recorded_at_utc";

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
        r.get(11)?,
    ))
}

fn entry_of(row: Row) -> KernelResult<(ToolJournalEntry, String)> {
    let payload: serde_json::Value = serde_json::from_str(&row.7).map_err(|_| {
        KernelError::new(
            KernelErrorCode::StoreCorrupt,
            "tool journal payload is not JSON",
        )
    })?;
    Ok((
        ToolJournalEntry {
            seq: row.0,
            request_id: row.1,
            execution_id: row.2,
            task_instance_id: row.3,
            attempt_id: row.4,
            command_id: row.5,
            phase: row.6,
            payload,
            prev_hash: row.8,
            entry_hash: row.9,
            recorded_at_utc: row.11,
        },
        row.10,
    ))
}

impl Store {
    /// Append one entry. A second entry for the same `(request, phase)` is
    /// a `command-conflict` (replay / duplicate execution).
    pub fn append_tool_entry(&mut self, input: &ToolEntryInput) -> KernelResult<ToolJournalEntry> {
        let key_hex = self.issuance_key_hex()?;
        let tx = self.conn_tx().map_err(|e| db_fail_pub("begin", e))?;
        let dup: Option<i64> = tx
            .query_row(
                "SELECT seq FROM tool_journal WHERE request_id = ?1 AND phase = ?2",
                params![input.request_id, input.phase],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read", e))?;
        if dup.is_some() {
            return Err(KernelError::new(
                KernelErrorCode::CommandConflict,
                ["tool request already recorded in phase ", &input.phase].concat(),
            ));
        }
        let prev: Option<String> = tx
            .query_row(
                "SELECT entry_hash FROM tool_journal ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read tail", e))?;
        let prev = prev.unwrap_or_else(|| TOOL_JOURNAL_GENESIS.to_owned());
        let at = now_utc_pub();
        let hash = entry_hash_of(&prev, input, &at);
        let seal = seal_of(&key_hex, &hash)?;
        let payload_json = canonical_json(&input.payload);
        tx.execute(
            "INSERT INTO tool_journal (request_id, execution_id, task_instance_id, attempt_id, command_id, phase, payload_json, prev_hash, entry_hash, seal_hex, recorded_at_utc) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![input.request_id, input.execution_id, input.task_instance_id, input.attempt_id, input.command_id, input.phase, payload_json, prev, hash, seal, at],
        )
        .map_err(|e| db_fail_pub("append tool entry", e))?;
        let seq = tx.last_insert_rowid();
        tx.commit().map_err(|e| db_fail_pub("commit", e))?;
        Ok(ToolJournalEntry {
            seq,
            request_id: input.request_id.clone(),
            execution_id: input.execution_id.clone(),
            task_instance_id: input.task_instance_id.clone(),
            attempt_id: input.attempt_id.clone(),
            command_id: input.command_id.clone(),
            phase: input.phase.clone(),
            payload: input.payload.clone(),
            prev_hash: prev,
            entry_hash: hash,
            recorded_at_utc: at,
        })
    }

    /// `(row count, tail entry hash)`; genesis hash when empty.
    pub fn tool_journal_tail(&self) -> KernelResult<(u64, String)> {
        let n: i64 = self
            .conn_ref()
            .query_row("SELECT COUNT(*) FROM tool_journal", [], |r| r.get(0))
            .map_err(|e| db_fail_pub("count", e))?;
        let tail: Option<String> = self
            .conn_ref()
            .query_row(
                "SELECT entry_hash FROM tool_journal ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read tail", e))?;
        Ok((
            n as u64,
            tail.unwrap_or_else(|| TOOL_JOURNAL_GENESIS.to_owned()),
        ))
    }

    /// Public seal helper so the Kernel can authenticate checkpoints with
    /// the same key domain.
    pub fn tool_checkpoint_seal(&mut self, count: u64, tail: &str) -> KernelResult<String> {
        let key_hex = self.issuance_key_hex()?;
        seal_of(&key_hex, &format!("checkpoint|{count}|{tail}"))
    }

    /// True when the phase row exists for the request.
    pub fn tool_phase_recorded(&self, request_id: &str, phase: &str) -> KernelResult<bool> {
        let n: Option<i64> = self
            .conn_ref()
            .query_row(
                "SELECT seq FROM tool_journal WHERE request_id = ?1 AND phase = ?2",
                params![request_id, phase],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read", e))?;
        Ok(n.is_some())
    }

    /// Entries in append order; `task` filters to one task instance.
    pub fn list_tool_entries(&self, task: Option<&str>) -> KernelResult<Vec<ToolJournalEntry>> {
        let conn = self.conn_ref();
        let mut out = Vec::new();
        let sql = match task {
            Some(_) => {
                format!("SELECT {COLS} FROM tool_journal WHERE task_instance_id = ?1 ORDER BY seq")
            }
            None => format!("SELECT {COLS} FROM tool_journal ORDER BY seq"),
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| db_fail_pub("prepare", e))?;
        let rows = match task {
            Some(t) => stmt
                .query_map(params![t], row_of)
                .map_err(|e| db_fail_pub("query", e))?
                .collect::<Result<Vec<_>, _>>(),
            None => stmt
                .query_map([], row_of)
                .map_err(|e| db_fail_pub("query", e))?
                .collect::<Result<Vec<_>, _>>(),
        }
        .map_err(|e| db_fail_pub("rows", e))?;
        for r in rows {
            out.push(entry_of(r)?.0);
        }
        Ok(out)
    }

    /// Recompute the whole chain and every seal. Returns the entry count or
    /// `store-corrupt` at the first inconsistency.
    pub fn verify_tool_journal(&mut self) -> KernelResult<u64> {
        let key_hex = self.issuance_key_hex()?;
        let conn = self.conn_ref();
        let mut stmt = conn
            .prepare(&format!("SELECT {COLS} FROM tool_journal ORDER BY seq"))
            .map_err(|e| db_fail_pub("prepare", e))?;
        let rows = stmt
            .query_map([], row_of)
            .map_err(|e| db_fail_pub("query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail_pub("rows", e))?;
        let mut prev = TOOL_JOURNAL_GENESIS.to_owned();
        let mut count = 0u64;
        for r in rows {
            let (e, seal) = entry_of(r)?;
            let input = ToolEntryInput {
                request_id: e.request_id.clone(),
                execution_id: e.execution_id.clone(),
                task_instance_id: e.task_instance_id.clone(),
                attempt_id: e.attempt_id.clone(),
                command_id: e.command_id.clone(),
                phase: e.phase.clone(),
                payload: e.payload.clone(),
            };
            let corrupt = |m: &str| KernelError::new(KernelErrorCode::StoreCorrupt, m);
            if e.prev_hash != prev {
                return Err(corrupt("tool journal chain broken (prev hash mismatch)"));
            }
            if entry_hash_of(&prev, &input, &e.recorded_at_utc) != e.entry_hash {
                return Err(corrupt(
                    "tool journal entry content does not match its hash",
                ));
            }
            if seal_of(&key_hex, &e.entry_hash)? != seal {
                return Err(corrupt("tool journal entry seal mismatch"));
            }
            prev = e.entry_hash;
            count += 1;
        }
        Ok(count)
    }
}
