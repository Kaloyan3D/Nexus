//! A4.3 independent journal witness: protocol, authority core and client.
//!
//! The witness runs as its OWN Linux identity with state and a sealing key
//! the daemon UID cannot read or write. It never holds authority over
//! grants, approvals or task outcomes: it only remembers, per journal, the
//! highest `(count, tail)` the daemon committed and refuses anything that is
//! not a strict continuation of it (rollback, fork, replay, duplicate,
//! out-of-order, cross-journal, cross-store).
//!
//! Authentication is kernel-attested: the witness checks the connecting
//! daemon's SO_PEERCRED uid, and the client checks the *server's* uid on the
//! connected socket, so acknowledgements cannot be forged by any other
//! identity. This is daemon-UID isolation on one host; it does not resist
//! root or a compromised witness UID.

use nexus_contracts::{canonical_json, sha256_hex};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const WITNESS_PROTOCOL: u32 = 1;
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
pub const JOURNAL_TOOL: &str = "tool-journal";
pub const JOURNAL_APPROVAL: &str = "approval-events";
pub const JOURNALS: [&str; 2] = [JOURNAL_TOOL, JOURNAL_APPROVAL];

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JState {
    pub count: u64,
    pub tail: String,
    /// Witness-assigned monotonic sequence of the accepting commitment.
    pub seq: u64,
    /// True when history before `count` was adopted, not witnessed.
    pub adopted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StateFile {
    v: u32,
    store_id: Option<String>,
    commit_seq: u64,
    chain: String,
    violations: u64,
    journals: BTreeMap<String, JState>,
}

// ------------------------------------------------------------ authority core

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// Return an error before anything is persisted.
    FailPersist,
    /// Persist, then withhold the acknowledgement (lost ack).
    DropAckAfterPersist,
    /// Persist, then terminate the process.
    ExitAfterPersist,
    /// Accept `n` commitments normally, then fail every later persist.
    FailPersistAfter(u64),
    /// Accept `n` commitments normally, then persist-but-drop later acks.
    DropAckAfter(u64),
    /// Stall (test-only) before persisting, to open a crash window.
    HangBeforePersist,
}

pub struct WitnessCore {
    dir: PathBuf,
    key: Vec<u8>,
    st: StateFile,
    pub fault: Option<Fault>,
    accepted_this_run: u64,
}

fn mac_hex(key: &[u8], data: &str) -> String {
    use hmac::Mac;
    let mut m = hmac::Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac key");
    m.update(b"nexus-witness-state/v1|");
    m.update(data.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

fn refuse(code: &str, msg: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "code": code, "message": msg })
}

impl WitnessCore {
    /// Open (creating on first use) the protected state directory. The
    /// caller must have verified directory ownership/mode.
    pub fn open(dir: &Path) -> Result<Self, String> {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let key_path = dir.join("witness.key");
        let key = match std::fs::read_to_string(&key_path) {
            Ok(k) => hex::decode(k.trim()).map_err(|_| "witness key is corrupt".to_owned())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut k = [0u8; 32];
                std::fs::File::open("/dev/urandom")
                    .and_then(|mut f| f.read_exact(&mut k))
                    .map_err(|e| format!("entropy unavailable: {e}"))?;
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&key_path)
                    .map_err(|e| format!("cannot create witness key: {e}"))?;
                f.write_all(hex::encode(k).as_bytes())
                    .and_then(|_| f.sync_all())
                    .map_err(|e| format!("cannot persist witness key: {e}"))?;
                k.to_vec()
            }
            Err(e) => return Err(format!("cannot read witness key: {e}")),
        };
        if key.len() != 32 {
            return Err("witness key has the wrong length".to_owned());
        }
        let state_path = dir.join("state.json");
        let st = match std::fs::read_to_string(&state_path) {
            Ok(raw) => {
                let v: serde_json::Value = serde_json::from_str(&raw)
                    .map_err(|_| "witness state unparsable".to_owned())?;
                let mac = v
                    .get("mac")
                    .and_then(|m| m.as_str())
                    .ok_or("witness state is unsealed")?
                    .to_owned();
                let body = v.get("state").cloned().ok_or("witness state missing")?;
                if mac_hex(&key, &canonical_json(&body)) != mac {
                    return Err(
                        "witness state failed seal verification (tampered or key mismatch); refusing to serve"
                            .to_owned(),
                    );
                }
                serde_json::from_value::<StateFile>(body)
                    .map_err(|_| "witness state malformed".to_owned())?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A missing state next to an existing key is a reset
                // attempt, not a fresh witness.
                if dir.join("state.sealed").exists() {
                    return Err("witness state was removed; refusing to serve (reset)".to_owned());
                }
                StateFile {
                    v: 1,
                    chain: GENESIS.to_owned(),
                    ..Default::default()
                }
            }
            Err(e) => return Err(format!("cannot read witness state: {e}")),
        };
        Ok(Self {
            dir: dir.to_path_buf(),
            key,
            st,
            fault: None,
            accepted_this_run: 0,
        })
    }

    fn persist(&mut self) -> Result<(), String> {
        let body = serde_json::to_value(&self.st).map_err(|e| e.to_string())?;
        let doc = serde_json::json!({
            "state": body,
            "mac": mac_hex(&self.key, &canonical_json(&body)),
        });
        let tmp = self.dir.join("state.json.tmp");
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| format!("persist: {e}"))?;
            f.write_all(doc.to_string().as_bytes())
                .and_then(|_| f.sync_all())
                .map_err(|e| format!("persist: {e}"))?;
        }
        std::fs::rename(&tmp, self.dir.join("state.json")).map_err(|e| format!("persist: {e}"))?;
        // Marker so a deleted state.json is detected as a reset.
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("state.sealed"));
        std::fs::File::open(&self.dir)
            .and_then(|d| d.sync_all())
            .map_err(|e| format!("persist dir: {e}"))?;
        Ok(())
    }

    fn violation(&mut self) {
        self.st.violations += 1;
        let _ = self.persist();
    }

    pub fn violations(&self) -> u64 {
        self.st.violations
    }

    /// Process one decoded request. `Err(())`-like drop-ack is signalled by
    /// the `dropAck` marker so the transport can withhold the reply.
    pub fn handle(&mut self, req: &serde_json::Value) -> serde_json::Value {
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
        if req.get("v").and_then(|v| v.as_u64()) != Some(WITNESS_PROTOCOL as u64) {
            return refuse("bad-protocol", "unsupported witness protocol version");
        }
        let nonce = req
            .get("nonce")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if nonce.is_empty() || nonce.len() > 64 {
            return refuse("bad-request", "nonce is required");
        }
        let mut r = match op {
            "status" => serde_json::json!({
                "ok": true, "storeId": self.st.store_id, "commitSeq": self.st.commit_seq,
                "violations": self.st.violations, "journals": self.st.journals,
                "chain": self.st.chain,
            }),
            "query" | "commit" | "adopt" => self.journal_op(op, req),
            _ => refuse("bad-request", "unknown witness operation"),
        };
        if let Some(o) = r.as_object_mut() {
            o.insert("nonce".into(), serde_json::Value::String(nonce));
            o.insert("v".into(), serde_json::json!(WITNESS_PROTOCOL));
        }
        r
    }

    fn journal_op(&mut self, op: &str, req: &serde_json::Value) -> serde_json::Value {
        let s = |k: &str| req.get(k).and_then(|v| v.as_str()).unwrap_or("").to_owned();
        let u = |k: &str| req.get(k).and_then(|v| v.as_u64());
        let (store_id, journal) = (s("storeId"), s("journal"));
        if store_id.is_empty() || store_id.len() > 128 {
            return refuse("bad-request", "storeId is required");
        }
        if !JOURNALS.contains(&journal.as_str()) {
            return refuse("unknown-journal", "journal is not a witnessed domain");
        }
        // One witness pins one store identity.
        match &self.st.store_id {
            Some(pinned) if *pinned != store_id => {
                self.violation();
                return refuse(
                    "store-substitution",
                    "commitment names a different store than the one this witness is bound to",
                );
            }
            Some(_) => {}
            None => {
                if op == "query" {
                    return serde_json::json!({"ok": true, "journal": journal, "state": null, "bound": false});
                }
                self.st.store_id = Some(store_id.clone());
            }
        }
        let cur = self.st.journals.get(&journal).cloned();
        if op == "query" {
            return serde_json::json!({
                "ok": true, "journal": journal, "state": cur, "bound": true,
                "violations": self.st.violations,
            });
        }
        let (Some(count), tail) = (u("count"), s("tail")) else {
            return refuse("bad-request", "count is required");
        };
        if !is_hex64(&tail) {
            return refuse("bad-request", "tail must be 64 hex characters");
        }
        let mut adopted = false;
        match op {
            "adopt" => {
                if cur.is_some() || count == 0 {
                    self.violation();
                    return refuse(
                        "adopt-refused",
                        "adoption is only valid for a non-empty, never-witnessed journal",
                    );
                }
                adopted = true;
            }
            _ => {
                let (Some(pc), ptail) = (u("prevCount"), s("prevTail")) else {
                    return refuse("bad-request", "prevCount is required");
                };
                match &cur {
                    None => {
                        if pc != 0 || ptail != GENESIS {
                            self.violation();
                            return refuse(
                                "unanchored",
                                "journal has no witness state; a non-empty history must be adopted explicitly",
                            );
                        }
                    }
                    Some(c) if c.count == count && c.tail == tail => {
                        // Idempotent retry of an already accepted commitment.
                        return serde_json::json!({
                            "ok": true, "journal": journal, "count": c.count, "tail": c.tail,
                            "seq": c.seq, "commitSeq": self.st.commit_seq, "idempotent": true,
                        });
                    }
                    Some(c) => {
                        if pc != c.count || ptail != c.tail {
                            self.violation();
                            let code = if count < c.count {
                                "rollback"
                            } else if count == c.count {
                                "fork"
                            } else {
                                "out-of-order"
                            };
                            return refuse(
                                code,
                                "commitment is not a continuation of the accepted witness state",
                            );
                        }
                        if count <= c.count {
                            self.violation();
                            return refuse("duplicate-sequence", "count must strictly increase");
                        }
                    }
                }
                if count == 0 && cur.is_none() {
                    // Registering an empty journal anchors genesis.
                }
            }
        }
        match self.fault {
            Some(Fault::FailPersist) => {
                return refuse(
                    "witness-storage",
                    "injected persist failure; state unchanged",
                );
            }
            Some(Fault::FailPersistAfter(n)) if self.accepted_this_run >= n => {
                return refuse(
                    "witness-storage",
                    "injected persist failure; state unchanged",
                );
            }
            Some(Fault::HangBeforePersist) => {
                std::thread::sleep(std::time::Duration::from_secs(20));
            }
            _ => {}
        }
        let prev_state = self.st.clone();
        self.st.commit_seq += 1;
        let seq = self.st.commit_seq;
        self.st.chain = sha256_hex(&canonical_json(&serde_json::json!({
            "prev": self.st.chain, "journal": journal, "count": count,
            "tail": tail, "seq": seq,
        })));
        self.st.journals.insert(
            journal.clone(),
            JState {
                count,
                tail: tail.clone(),
                seq,
                adopted,
            },
        );
        if let Err(e) = self.persist() {
            self.st = prev_state;
            return refuse("witness-storage", &e);
        }
        self.accepted_this_run += 1;
        match self.fault {
            Some(Fault::DropAckAfterPersist) => {
                return serde_json::json!({"ok": false, "dropAck": true});
            }
            Some(Fault::DropAckAfter(n)) if self.accepted_this_run > n => {
                return serde_json::json!({"ok": false, "dropAck": true});
            }
            Some(Fault::ExitAfterPersist) => std::process::exit(86),
            _ => {}
        }
        serde_json::json!({
            "ok": true, "journal": journal, "count": count, "tail": tail,
            "seq": seq, "commitSeq": seq, "adopted": adopted, "chain": self.st.chain,
        })
    }
}

// --------------------------------------------------------------- client

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WitnessFailure {
    /// Witness not reachable or answered with the wrong identity/shape.
    Unavailable(String),
    /// Witness refused the commitment as rollback/fork/substitution/etc.
    Refused { code: String, message: String },
    /// Journal has history the witness never anchored.
    Unanchored(String),
}

impl std::fmt::Display for WitnessFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "witness unavailable: {m}"),
            Self::Refused { code, message } => write!(f, "witness refused ({code}): {message}"),
            Self::Unanchored(m) => write!(f, "unanchored legacy history: {m}"),
        }
    }
}

struct ClientInner {
    last: BTreeMap<String, JState>,
    last_commit_seq: u64,
}

pub struct RemoteWitness {
    socket: PathBuf,
    expect_uid: u32,
    store_id: String,
    adopt_legacy: bool,
    inner: Mutex<ClientInner>,
}

fn nonce() -> String {
    use std::io::Read;
    let mut b = [0u8; 12];
    let _ = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    hex::encode(b)
}

impl RemoteWitness {
    pub fn new(socket: PathBuf, expect_uid: u32, store_id: String, adopt_legacy: bool) -> Self {
        Self {
            socket,
            expect_uid,
            store_id,
            adopt_legacy,
            inner: Mutex::new(ClientInner {
                last: BTreeMap::new(),
                last_commit_seq: 0,
            }),
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub fn expected_uid(&self) -> u32 {
        self.expect_uid
    }

    fn call(&self, mut req: serde_json::Value) -> Result<serde_json::Value, WitnessFailure> {
        let n = nonce();
        req["v"] = serde_json::json!(WITNESS_PROTOCOL);
        req["nonce"] = serde_json::json!(n);
        let un = |m: String| WitnessFailure::Unavailable(m);
        let mut s = UnixStream::connect(&self.socket).map_err(|e| un(format!("connect: {e}")))?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        s.set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        // Kernel-attested server identity: the acknowledgement cannot come
        // from any UID other than the configured witness.
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
        if rc != 0 || cred.uid != self.expect_uid {
            return Err(un(format!(
                "server identity uid {} is not the configured witness uid {}",
                if rc == 0 { cred.uid as i64 } else { -1 },
                self.expect_uid
            )));
        }
        s.write_all(format!("{req}\n").as_bytes())
            .map_err(|e| un(format!("write: {e}")))?;
        let mut line = String::new();
        BufReader::new(s)
            .read_line(&mut line)
            .map_err(|e| un(format!("read: {e}")))?;
        if line.trim().is_empty() {
            return Err(un("empty acknowledgement (connection closed)".to_owned()));
        }
        let v: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|_| un("malformed acknowledgement".into()))?;
        if v.get("nonce").and_then(|x| x.as_str()) != Some(n.as_str()) {
            return Err(un(
                "acknowledgement nonce mismatch (replayed or foreign)".into()
            ));
        }
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            return Err(WitnessFailure::Refused {
                code: v
                    .get("code")
                    .and_then(|x| x.as_str())
                    .unwrap_or("refused")
                    .to_owned(),
                message: v
                    .get("message")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_owned(),
            });
        }
        Ok(v)
    }

    /// Current witness state of one journal (None = never anchored).
    pub fn query(&self, journal: &str) -> Result<Option<JState>, WitnessFailure> {
        let r = self.call(serde_json::json!({
            "op": "query", "storeId": self.store_id, "journal": journal,
        }))?;
        match r.get("state") {
            Some(serde_json::Value::Null) | None => Ok(None),
            Some(s) => serde_json::from_value(s.clone())
                .map(Some)
                .map_err(|_| WitnessFailure::Unavailable("malformed witness state".into())),
        }
    }

    pub fn status(&self) -> Result<serde_json::Value, WitnessFailure> {
        self.call(serde_json::json!({"op": "status"}))
    }

    /// Commit `(count, tail)` of one journal as a strict continuation of
    /// the last accepted state, adopting an unanchored non-empty history
    /// only when explicitly configured. Returns the acknowledged state.
    pub fn commit(
        &self,
        journal: &str,
        count: u64,
        tail: &str,
        hash_at: &dyn Fn(u64) -> Option<String>,
    ) -> Result<JState, WitnessFailure> {
        let known = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.last.get(journal).cloned()
        };
        let prev = match known {
            Some(p) => Some(p),
            None => self.query(journal)?,
        };
        if let Some(p) = &prev {
            // The local history must still contain the witnessed prefix:
            // fewer entries is rollback/truncation, a different hash at the
            // witnessed position is an edit or a fork.
            let refused = |code: &str, m: &str| WitnessFailure::Refused {
                code: code.to_owned(),
                message: m.to_owned(),
            };
            if count < p.count {
                self.reset_cache();
                return Err(refused(
                    "rollback",
                    "local journal has fewer entries than the witnessed state (rollback or truncation)",
                ));
            }
            if hash_at(p.count).as_deref() != Some(p.tail.as_str()) {
                self.reset_cache();
                return Err(refused(
                    "fork",
                    "local journal does not contain the witnessed entry at the witnessed position",
                ));
            }
            if p.count == count && p.tail == tail {
                self.remember(journal, p.clone(), 0);
                return Ok(p.clone());
            }
        }
        let (op, pc, pt) = match &prev {
            Some(p) => ("commit", p.count, p.tail.clone()),
            None if count == 0 || tail == GENESIS => ("commit", 0, GENESIS.to_owned()),
            None if self.adopt_legacy => ("adopt", 0, GENESIS.to_owned()),
            None => {
                return Err(WitnessFailure::Unanchored(format!(
                    "{journal} has {count} entries the witness never anchored; \
                     explicit adoption (--witness-adopt-legacy) is required"
                )))
            }
        };
        let r = match self.call(serde_json::json!({
            "op": op, "storeId": self.store_id, "journal": journal,
            "count": count, "tail": tail, "prevCount": pc, "prevTail": pt,
        })) {
            Ok(r) => r,
            Err(e) => {
                // A stale cache must not mask a refusal: drop it.
                let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                g.last.remove(journal);
                return Err(e);
            }
        };
        let st = JState {
            count: r.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
            tail: r
                .get("tail")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned(),
            seq: r.get("seq").and_then(|v| v.as_u64()).unwrap_or(0),
            adopted: r.get("adopted").and_then(|v| v.as_bool()).unwrap_or(false),
        };
        if st.count != count || st.tail != tail {
            return Err(WitnessFailure::Unavailable(
                "acknowledgement does not match the commitment".into(),
            ));
        }
        let cs = r.get("commitSeq").and_then(|v| v.as_u64()).unwrap_or(0);
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if cs != 0 && cs < g.last_commit_seq {
                return Err(WitnessFailure::Unavailable(
                    "acknowledgement sequence went backwards (replay)".into(),
                ));
            }
        }
        self.remember(journal, st.clone(), cs);
        Ok(st)
    }

    fn remember(&self, journal: &str, st: JState, commit_seq: u64) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.last.insert(journal.to_owned(), st);
        if commit_seq > g.last_commit_seq {
            g.last_commit_seq = commit_seq;
        }
    }

    /// Forget cached acknowledgements (after any failure/recovery).
    pub fn reset_cache(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.last.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn euid() -> u32 {
        unsafe { libc::geteuid() }
    }

    /// Serve exactly `replies.len()` connections with a scripted behaviour.
    fn fake_server(
        sock: PathBuf,
        script: impl Fn(&serde_json::Value) -> Option<String> + Send + 'static,
        n: usize,
    ) -> std::thread::JoinHandle<()> {
        let l = UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            for _ in 0..n {
                let (s, _) = l.accept().unwrap();
                let mut line = String::new();
                let _ = BufReader::new(&s).read_line(&mut line);
                let req: serde_json::Value =
                    serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                if let Some(r) = script(&req) {
                    let mut w = &s;
                    let _ = w.write_all(format!("{r}\n").as_bytes());
                }
            }
        })
    }

    fn h(c: u64) -> String {
        sha256_hex(&format!("e{c}"))
    }

    #[test]
    fn client_refuses_forged_replayed_and_wrongly_attributed_acknowledgements() {
        let d = tempfile::tempdir().unwrap();
        let sock = d.path().join("w.sock");
        // Forged: right shape, wrong nonce (an old/foreign acknowledgement).
        let t = fake_server(
            sock.clone(),
            |_| {
                Some(
                    serde_json::json!({"ok": true, "v": 1, "nonce": "0000", "state": null})
                        .to_string(),
                )
            },
            1,
        );
        let c = RemoteWitness::new(sock.clone(), euid(), "s".into(), false);
        assert!(
            matches!(c.query(JOURNAL_TOOL), Err(WitnessFailure::Unavailable(m)) if m.contains("nonce"))
        );
        t.join().unwrap();
        std::fs::remove_file(&sock).unwrap();
        // Wrong server identity: the connected peer is not the witness uid.
        let t = fake_server(sock.clone(), |_| None, 1);
        let c = RemoteWitness::new(sock.clone(), euid() + 1, "s".into(), false);
        assert!(
            matches!(c.query(JOURNAL_TOOL), Err(WitnessFailure::Unavailable(m)) if m.contains("identity"))
        );
        t.join().unwrap();
        std::fs::remove_file(&sock).unwrap();
        // Dropped acknowledgement: unavailable, never "success".
        let t = fake_server(sock.clone(), |_| None, 1);
        let c = RemoteWitness::new(sock.clone(), euid(), "s".into(), false);
        assert!(matches!(
            c.query(JOURNAL_TOOL),
            Err(WitnessFailure::Unavailable(_))
        ));
        t.join().unwrap();
    }

    #[test]
    fn core_enforces_monotonic_continuation_and_domain_separation() {
        let d = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut core = WitnessCore::open(d.path()).unwrap();
        let q = |op: &str, j: &str, count: u64, tail: &str, pc: u64, pt: &str| {
            serde_json::json!({"v":1,"op":op,"nonce":"n","storeId":"S","journal":j,
                "count":count,"tail":tail,"prevCount":pc,"prevTail":pt})
        };
        let ok = |r: &serde_json::Value| r["ok"] == true;
        // genesis -> 3
        assert!(ok(&core.handle(&q(
            "commit",
            JOURNAL_TOOL,
            3,
            &h(3),
            0,
            GENESIS
        ))));
        // idempotent retry
        assert!(ok(&core.handle(&q(
            "commit",
            JOURNAL_TOOL,
            3,
            &h(3),
            0,
            GENESIS
        ))));
        // out-of-order / skipped prev
        let r = core.handle(&q("commit", JOURNAL_TOOL, 9, &h(9), 5, &h(5)));
        assert_eq!(r["code"], "out-of-order");
        // rollback and fork
        assert_eq!(
            core.handle(&q("commit", JOURNAL_TOOL, 2, &h(2), 0, GENESIS))["code"],
            "rollback"
        );
        assert_eq!(
            core.handle(&q("commit", JOURNAL_TOOL, 3, &h(99), 2, &h(2)))["code"],
            "fork"
        );
        // duplicate sequence with a changed tail at the same prev
        assert_eq!(
            core.handle(&q("commit", JOURNAL_TOOL, 3, &h(7), 3, &h(3)))["code"],
            "duplicate-sequence"
        );
        // domains are independent: the approval journal starts at genesis
        assert!(ok(&core.handle(&q(
            "commit",
            JOURNAL_APPROVAL,
            1,
            &h(1),
            0,
            GENESIS
        ))));
        // unauthorized reset: adopting an already-anchored journal is refused
        assert_eq!(
            core.handle(&q("adopt", JOURNAL_TOOL, 1, &h(1), 0, GENESIS))["code"],
            "adopt-refused"
        );
        // survives reopen; tampered state is refused
        let v = core.violations();
        assert!(v >= 4);
        drop(core);
        let core = WitnessCore::open(d.path()).unwrap();
        assert_eq!(core.violations(), v);
        let sp = d.path().join("state.json");
        let raw = std::fs::read_to_string(&sp)
            .unwrap()
            .replace("\"count\":3", "\"count\":1");
        std::fs::write(&sp, raw).unwrap();
        assert!(WitnessCore::open(d.path()).is_err());
    }
}
