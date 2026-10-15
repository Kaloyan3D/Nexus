//! Schema migrations and durability pragmas.
//! journal_mode=WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000.

pub const STORE_SCHEMA_VERSION: i64 = 2;

pub const DDL_V1: &str = "
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generations (generation_key TEXT PRIMARY KEY, task_instance_id TEXT NOT NULL, backend TEXT NOT NULL, epoch INTEGER NOT NULL, store_incarnation TEXT NOT NULL, witness_protected INTEGER NOT NULL DEFAULT 0, acquired_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sealed_issuances (issuance_id TEXT PRIMARY KEY, issued_json TEXT NOT NULL, seal_hex TEXT NOT NULL, created_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commands (command_id TEXT PRIMARY KEY, task_instance_id TEXT NOT NULL, attempt_id TEXT NOT NULL, backend TEXT NOT NULL, controller_revision INTEGER NOT NULL, role TEXT NOT NULL, mode_id TEXT NOT NULL, mode_config_revision_json TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, intent_digest TEXT NOT NULL, target_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL, target_digest TEXT NOT NULL, issuance_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, store_incarnation TEXT NOT NULL, command_digest TEXT NOT NULL, created_at_utc TEXT NOT NULL, FOREIGN KEY (issuance_id) REFERENCES sealed_issuances (issuance_id));
CREATE TABLE IF NOT EXISTS receipts (command_id TEXT PRIMARY KEY, command_digest TEXT NOT NULL, task_instance_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, store_incarnation TEXT NOT NULL, target_digest TEXT NOT NULL, snapshot_digest TEXT NOT NULL, issuance_id TEXT NOT NULL, status TEXT NOT NULL, event_seq INTEGER NOT NULL, accepted_at_utc TEXT NOT NULL, FOREIGN KEY (command_id) REFERENCES commands (command_id));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, generation_key TEXT NOT NULL, kind TEXT NOT NULL, command_id TEXT, payload_json TEXT NOT NULL, recorded_at_utc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_generation ON events (generation_key, seq);
";

pub const WITNESS_DDL_V1: &str = "
CREATE TABLE IF NOT EXISTS witness_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS witness_state (generation_key TEXT PRIMARY KEY, max_epoch INTEGER NOT NULL, store_incarnation TEXT NOT NULL, accepted_json TEXT NOT NULL, baseline_json TEXT, updated_at_utc TEXT NOT NULL);
";

/// A2.0 witness-acknowledged dispatch-reservation protocol (migration v2).
/// Applied idempotently on every witness open; preserves all v1 state.
///
/// State machine per command: unseen -> prepared -> acknowledged.
/// `accepted` in the main store is the middle transition: prepare (witness)
/// precedes the store commit, acknowledge (witness) follows it. A crash at
/// any point resolves fail-closed: prepared-without-receipt may only heal
/// with a byte-identical binding, acknowledged-without-receipt is
/// reconciliation-required (never blind redispatch), and abandoned prepared
/// reservations are reaped explicitly without inventing execution success.
pub const WITNESS_DDL_V2: &str = "
CREATE TABLE IF NOT EXISTS dispatch_reservations (
  command_id TEXT PRIMARY KEY,
  generation_key TEXT NOT NULL,
  task_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  store_incarnation TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  issuance_id TEXT NOT NULL,
  state TEXT NOT NULL,
  prepared_at_utc TEXT NOT NULL,
  acknowledged_at_utc TEXT,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_generation ON dispatch_reservations (generation_key, state);
";

pub const WITNESS_SCHEMA_VERSION: i64 = 2;

/// A2.3 durable Controller intent + sealed V2 extensions (migration v2).
/// Applied idempotently on every store open; preserves all v1 state.
/// v1 stores migrate forward (version row 1 -> 2); unknown future versions
/// still refuse `store-incompatible` in `Store::open_once`.
///
/// `controller_intents` holds one published execution authority per
/// command: the canonical bundle plus its issuance-key seal and a small
/// explicit lifecycle (`published` -> `executed` | `cancelled`). No silent
/// transitions exist: execution consumes the intent exactly once, and
/// fencing is terminal. `sealed_extensions` carries Registry-issued V2
/// extension bytes under their own digest identity, sealed with the same
/// issuance key as V1 resolutions (same trust root, separate table so the
/// two vocabularies can never collide).
pub const DDL_V2: &str = "
CREATE TABLE IF NOT EXISTS sealed_extensions (extension_digest TEXT PRIMARY KEY, extension_json TEXT NOT NULL, seal_hex TEXT NOT NULL, created_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS controller_intents (command_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, seal_hex TEXT NOT NULL, state TEXT NOT NULL, published_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
";

/// A3.1 durable native tool-execution journal (additive; no version bump).
/// Append-only, hash-chained, HMAC-sealed. One row per
/// (request_id, phase) so each lifecycle phase is exactly-once.
pub const DDL_V3_TOOLS: &str = "
CREATE TABLE IF NOT EXISTS tool_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  seal_hex TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL,
  UNIQUE (request_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_tool_journal_task ON tool_journal (task_instance_id, attempt_id, seq);
CREATE TABLE IF NOT EXISTS workspace_bindings (command_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, seal_hex TEXT NOT NULL, created_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS write_scope_bindings (command_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, seal_hex TEXT NOT NULL, created_at_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tool_revocations (command_id TEXT PRIMARY KEY, reason TEXT NOT NULL, revoked_at_utc TEXT NOT NULL);
";
