//! A4.2 durable human-approval records.
//!
//! `approvals` holds one immutable, sealed request per row (the request
//! JSON and its digest never change after insertion) plus a small mutable
//! lifecycle block. `approval_events` is the append-only, hash-chained,
//! HMAC-sealed audit trail. Credentials, passwords and raw authentication
//! material are never stored here.

use crate::store::{db_fail_pub, Store};
use nexus_contracts::{canonical_json, sha256_hex, KernelError, KernelErrorCode, KernelResult};
use rusqlite::{params, OptionalExtension};

pub const APPROVAL_GENESIS: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

pub const DDL_V4_APPROVALS: &str = "
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  task_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  store_incarnation TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_json TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  seal_hex TEXT NOT NULL,
  state TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  review_code TEXT NOT NULL,
  reviewed_ms INTEGER,
  decision_json TEXT,
  decided_ms INTEGER,
  grant_request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_command ON approvals (command_id, state);
CREATE TABLE IF NOT EXISTS approval_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  seal_hex TEXT NOT NULL,
  recorded_ms INTEGER NOT NULL
);
";

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRow {
    pub approval_id: String,
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub tool_id: String,
    pub scope: String,
    pub request_json: String,
    pub request_digest: String,
    pub state: String,
    pub created_ms: i64,
    pub expires_ms: i64,
    pub review_code: String,
    pub reviewed_ms: Option<i64>,
    pub decision_json: Option<String>,
    pub decided_ms: Option<i64>,
    pub grant_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalEvent {
    pub seq: i64,
    pub approval_id: String,
    pub event: String,
    pub payload: serde_json::Value,
    pub recorded_ms: i64,
}

/// Fields a lifecycle transition may set. Everything else is immutable.
#[derive(Debug, Clone, Default)]
pub struct ApprovalUpdate {
    pub reviewed_ms: Option<i64>,
    pub clear_reviewed: bool,
    pub decision_json: Option<String>,
    pub decided_ms: Option<i64>,
    pub grant_request_id: Option<String>,
}

const COLS: &str = "approval_id, command_id, task_instance_id, attempt_id, lease_epoch, store_incarnation, tool_id, scope, request_json, request_digest, seal_hex, state, created_ms, expires_ms, review_code, reviewed_ms, decision_json, decided_ms, grant_request_id";

fn hmac_hex(key_hex: &str, domain: &str, data: &str) -> KernelResult<String> {
    use hmac::Mac;
    let key = hex::decode(key_hex)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is corrupted"))?;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&key)
        .map_err(|_| KernelError::new(KernelErrorCode::StoreError, "issuance key is invalid"))?;
    mac.update(domain.as_bytes());
    mac.update(b"|");
    mac.update(data.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn request_seal(key_hex: &str, id: &str, command: &str, digest: &str) -> KernelResult<String> {
    hmac_hex(
        key_hex,
        "nexus-approval-request/v1",
        &format!("{id}|{command}|{digest}"),
    )
}

fn event_hash(prev: &str, id: &str, event: &str, payload: &str, at: i64) -> String {
    sha256_hex(&canonical_json(&serde_json::json!({
        "prev": prev, "approvalId": id, "event": event,
        "payload": payload, "recordedMs": at,
    })))
}

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ApprovalRow, String)> {
    Ok((
        ApprovalRow {
            approval_id: r.get(0)?,
            command_id: r.get(1)?,
            task_instance_id: r.get(2)?,
            attempt_id: r.get(3)?,
            lease_epoch: r.get::<_, i64>(4)? as u64,
            store_incarnation: r.get(5)?,
            tool_id: r.get(6)?,
            scope: r.get(7)?,
            request_json: r.get(8)?,
            request_digest: r.get(9)?,
            state: r.get(11)?,
            created_ms: r.get(12)?,
            expires_ms: r.get(13)?,
            review_code: r.get(14)?,
            reviewed_ms: r.get(15)?,
            decision_json: r.get(16)?,
            decided_ms: r.get(17)?,
            grant_request_id: r.get(18)?,
        },
        r.get::<_, String>(10)?,
    ))
}

fn corrupt(msg: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StoreCorrupt, msg)
}

fn append_event(
    tx: &rusqlite::Transaction<'_>,
    key_hex: &str,
    id: &str,
    event: &str,
    payload: &serde_json::Value,
    at: i64,
) -> KernelResult<i64> {
    let prev: Option<String> = tx
        .query_row(
            "SELECT entry_hash FROM approval_events ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_fail_pub("read approval tail", e))?;
    let prev = prev.unwrap_or_else(|| APPROVAL_GENESIS.to_owned());
    let payload_json = canonical_json(payload);
    let hash = event_hash(&prev, id, event, &payload_json, at);
    let seal = hmac_hex(key_hex, "nexus-approval-event/v1", &hash)?;
    tx.execute(
        "INSERT INTO approval_events (approval_id, event, payload_json, prev_hash, entry_hash, seal_hex, recorded_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, event, payload_json, prev, hash, seal, at],
    )
    .map_err(|e| db_fail_pub("append approval event", e))?;
    Ok(tx.last_insert_rowid())
}

impl Store {
    /// Persistent approval-policy latch (store_meta). Raised, never lowered.
    pub fn approval_policy_get(&self) -> KernelResult<Option<String>> {
        self.conn_ref()
            .query_row(
                "SELECT value FROM store_meta WHERE key = 'approval_policy'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read approval policy", e))
    }

    pub fn approval_policy_set(&mut self, value: &str) -> KernelResult<()> {
        self.conn_ref()
            .execute(
                "INSERT INTO store_meta (key, value) VALUES ('approval_policy', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![value],
            )
            .map_err(|e| db_fail_pub("write approval policy", e))?;
        Ok(())
    }

    /// Insert a new request in state `pending`, journaling `requested` and
    /// `pending` atomically. The request JSON/digest are sealed here and
    /// never updated afterwards.
    #[allow(clippy::too_many_arguments)]
    pub fn approval_insert(
        &mut self,
        row: &ApprovalRow,
        requested_payload: &serde_json::Value,
        now_ms: i64,
    ) -> KernelResult<()> {
        if sha256_hex(&row.request_json) != row.request_digest {
            return Err(corrupt("approval request digest does not match its bytes"));
        }
        let key = self.issuance_key_hex()?;
        let seal = request_seal(&key, &row.approval_id, &row.command_id, &row.request_digest)?;
        let tx = self.conn_tx().map_err(|e| db_fail_pub("begin", e))?;
        tx.execute(
            "INSERT INTO approvals (approval_id, command_id, task_instance_id, attempt_id, lease_epoch, store_incarnation, tool_id, scope, request_json, request_digest, seal_hex, state, created_ms, expires_ms, review_code) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending',?12,?13,?14)",
            params![
                row.approval_id, row.command_id, row.task_instance_id, row.attempt_id,
                row.lease_epoch as i64, row.store_incarnation, row.tool_id, row.scope,
                row.request_json, row.request_digest, seal, row.created_ms, row.expires_ms,
                row.review_code
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                KernelError::new(
                    KernelErrorCode::CommandConflict,
                    "approval id already exists; duplicate refused",
                )
            } else {
                db_fail_pub("insert approval", e)
            }
        })?;
        append_event(
            &tx,
            &key,
            &row.approval_id,
            "requested",
            requested_payload,
            now_ms,
        )?;
        append_event(
            &tx,
            &key,
            &row.approval_id,
            "pending",
            &serde_json::json!({ "expiresMs": row.expires_ms }),
            now_ms,
        )?;
        tx.commit().map_err(|e| db_fail_pub("commit", e))
    }

    /// Verified read: the sealed request must still match its digest/seal.
    pub fn approval_fetch(&mut self, id: &str) -> KernelResult<Option<ApprovalRow>> {
        let key = self.issuance_key_hex()?;
        let got = self
            .conn_ref()
            .query_row(
                &format!("SELECT {COLS} FROM approvals WHERE approval_id = ?1"),
                params![id],
                read_row,
            )
            .optional()
            .map_err(|e| db_fail_pub("read approval", e))?;
        match got {
            None => Ok(None),
            Some((row, seal)) => Self::verify_approval_row(&key, row, &seal).map(Some),
        }
    }

    fn verify_approval_row(key: &str, row: ApprovalRow, seal: &str) -> KernelResult<ApprovalRow> {
        let want = request_seal(key, &row.approval_id, &row.command_id, &row.request_digest)?;
        if want != seal || sha256_hex(&row.request_json) != row.request_digest {
            return Err(corrupt(
                "approval request failed seal verification; failing closed",
            ));
        }
        Ok(row)
    }

    /// All approvals (optionally for one task), newest first, bounded.
    pub fn approval_list(
        &mut self,
        task: Option<&str>,
        limit: usize,
    ) -> KernelResult<Vec<ApprovalRow>> {
        let key = self.issuance_key_hex()?;
        let (sql, bound): (String, Option<String>) = match task {
            Some(t) => (
                format!("SELECT {COLS} FROM approvals WHERE task_instance_id = ?1 ORDER BY created_ms DESC, approval_id LIMIT {limit}"),
                Some(t.to_owned()),
            ),
            None => (
                format!("SELECT {COLS} FROM approvals ORDER BY created_ms DESC, approval_id LIMIT {limit}"),
                None,
            ),
        };
        let mut stmt = self
            .conn_ref()
            .prepare(&sql)
            .map_err(|e| db_fail_pub("prepare", e))?;
        let rows = match bound {
            Some(t) => stmt
                .query_map(params![t], read_row)
                .map_err(|e| db_fail_pub("query", e))?
                .collect::<Result<Vec<_>, _>>(),
            None => stmt
                .query_map([], read_row)
                .map_err(|e| db_fail_pub("query", e))?
                .collect::<Result<Vec<_>, _>>(),
        }
        .map_err(|e| db_fail_pub("rows", e))?;
        rows.into_iter()
            .map(|(r, s)| Self::verify_approval_row(&key, r, &s))
            .collect()
    }

    /// Approvals of one command in the given states (verified).
    pub fn approvals_for_command(
        &mut self,
        command_id: &str,
        states: &[&str],
    ) -> KernelResult<Vec<ApprovalRow>> {
        let key = self.issuance_key_hex()?;
        let mut stmt = self
            .conn_ref()
            .prepare(&format!(
                "SELECT {COLS} FROM approvals WHERE command_id = ?1 ORDER BY created_ms, approval_id"
            ))
            .map_err(|e| db_fail_pub("prepare", e))?;
        let rows = stmt
            .query_map(params![command_id], read_row)
            .map_err(|e| db_fail_pub("query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail_pub("rows", e))?;
        let mut out = Vec::new();
        for (r, s) in rows {
            let r = Self::verify_approval_row(&key, r, &s)?;
            if states.contains(&r.state.as_str()) {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// Approvals currently in one of `states`, across all commands.
    pub fn approvals_in_states(&mut self, states: &[&str]) -> KernelResult<Vec<ApprovalRow>> {
        let all = self.approval_list(None, 100_000)?;
        Ok(all
            .into_iter()
            .filter(|r| states.contains(&r.state.as_str()))
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    /// Atomic compare-and-set lifecycle transition with its audit event.
    /// Returns `Ok(false)` (and writes nothing) when the row is not in one
    /// of `from`, which is how concurrent/duplicate decisions lose.
    pub fn approval_transition(
        &mut self,
        id: &str,
        from: &[&str],
        to: &str,
        upd: &ApprovalUpdate,
        event: &str,
        payload: &serde_json::Value,
        now_ms: i64,
    ) -> KernelResult<bool> {
        let key = self.issuance_key_hex()?;
        let tx = self.conn_tx().map_err(|e| db_fail_pub("begin", e))?;
        let cur: Option<String> = tx
            .query_row(
                "SELECT state FROM approvals WHERE approval_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_fail_pub("read", e))?;
        match cur {
            Some(s) if from.contains(&s.as_str()) => {}
            _ => return Ok(false),
        }
        tx.execute(
            "UPDATE approvals SET state = ?2,
               reviewed_ms = CASE WHEN ?3 = 1 THEN NULL WHEN ?4 IS NOT NULL THEN ?4 ELSE reviewed_ms END,
               decision_json = COALESCE(?5, decision_json),
               decided_ms = COALESCE(?6, decided_ms),
               grant_request_id = COALESCE(?7, grant_request_id)
             WHERE approval_id = ?1",
            params![
                id,
                to,
                upd.clear_reviewed as i64,
                upd.reviewed_ms,
                upd.decision_json,
                upd.decided_ms,
                upd.grant_request_id
            ],
        )
        .map_err(|e| db_fail_pub("update approval", e))?;
        append_event(&tx, &key, id, event, payload, now_ms)?;
        tx.commit().map_err(|e| db_fail_pub("commit", e))?;
        Ok(true)
    }

    /// Record a non-transition audit event (e.g. `reviewed`).
    pub fn approval_note(
        &mut self,
        id: &str,
        event: &str,
        payload: &serde_json::Value,
        now_ms: i64,
    ) -> KernelResult<()> {
        let key = self.issuance_key_hex()?;
        let tx = self.conn_tx().map_err(|e| db_fail_pub("begin", e))?;
        append_event(&tx, &key, id, event, payload, now_ms)?;
        tx.commit().map_err(|e| db_fail_pub("commit", e))
    }

    pub fn approval_events(&mut self, id: &str) -> KernelResult<Vec<ApprovalEvent>> {
        let mut stmt = self
            .conn_ref()
            .prepare("SELECT seq, approval_id, event, payload_json, recorded_ms FROM approval_events WHERE approval_id = ?1 ORDER BY seq")
            .map_err(|e| db_fail_pub("prepare", e))?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| db_fail_pub("query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail_pub("rows", e))?;
        rows.into_iter()
            .map(|(seq, approval_id, event, p, recorded_ms)| {
                Ok(ApprovalEvent {
                    seq,
                    approval_id,
                    event,
                    payload: serde_json::from_str(&p)
                        .map_err(|_| corrupt("approval event payload is not JSON"))?,
                    recorded_ms,
                })
            })
            .collect()
    }

    /// Verify the whole approval event chain and seals; returns row count.
    pub fn approval_verify_chain(&mut self) -> KernelResult<u64> {
        let key = self.issuance_key_hex()?;
        let mut stmt = self
            .conn_ref()
            .prepare("SELECT approval_id, event, payload_json, prev_hash, entry_hash, seal_hex, recorded_ms FROM approval_events ORDER BY seq")
            .map_err(|e| db_fail_pub("prepare", e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| db_fail_pub("query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_fail_pub("rows", e))?;
        let mut prev = APPROVAL_GENESIS.to_owned();
        let mut n = 0u64;
        for (id, ev, payload, p, h, seal, at) in rows {
            if p != prev
                || event_hash(&p, &id, &ev, &payload, at) != h
                || hmac_hex(&key, "nexus-approval-event/v1", &h)? != seal
            {
                return Err(corrupt("approval event chain verification failed"));
            }
            prev = h;
            n += 1;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str) -> ApprovalRow {
        let request_json = canonical_json(&serde_json::json!({"approvalId": id, "x": 1}));
        ApprovalRow {
            approval_id: id.to_owned(),
            command_id: "c".into(),
            task_instance_id: "t".into(),
            attempt_id: "a".into(),
            lease_epoch: 1,
            store_incarnation: "i".into(),
            tool_id: "fs.write".into(),
            scope: "write".into(),
            request_digest: sha256_hex(&request_json),
            request_json,
            state: "pending".into(),
            created_ms: 1,
            expires_ms: 2,
            review_code: "abcd1234".into(),
            reviewed_ms: None,
            decision_json: None,
            decided_ms: None,
            grant_request_id: None,
        }
    }

    #[test]
    fn transitions_are_compare_and_set_and_the_chain_detects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(&dir.path().join("k.db")).unwrap();
        s.approval_insert(&row("a1"), &serde_json::json!({}), 10)
            .unwrap();
        // Duplicate id is a conflict, never an overwrite.
        assert!(s
            .approval_insert(&row("a1"), &serde_json::json!({}), 11)
            .is_err());
        let upd = ApprovalUpdate::default();
        let p = serde_json::json!({});
        assert!(s
            .approval_transition("a1", &["pending"], "denied", &upd, "denied", &p, 12)
            .unwrap());
        // Terminal: neither a second decision nor revival can win.
        for to in ["approved", "pending", "expired"] {
            assert!(!s
                .approval_transition("a1", &["pending"], to, &upd, "x", &p, 13)
                .unwrap());
        }
        assert_eq!(s.approval_fetch("a1").unwrap().unwrap().state, "denied");
        assert_eq!(s.approval_verify_chain().unwrap(), 3);
        // Tamper with an audit row and with the sealed request.
        s.conn_ref()
            .execute(
                "UPDATE approval_events SET payload_json = '{\"x\":1}' WHERE seq = 1",
                [],
            )
            .unwrap();
        assert!(s.approval_verify_chain().is_err());
        s.conn_ref()
            .execute(
                "UPDATE approvals SET request_json = '{\"approvalId\":\"a1\",\"x\":2}'",
                [],
            )
            .unwrap();
        assert!(s.approval_fetch("a1").is_err());
    }
}
