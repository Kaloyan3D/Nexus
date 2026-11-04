//! A4.3 journal integrity: external-witness anchoring and verification.
//!
//! Durability contract (also in `native/A4.3-EVIDENCE.md`):
//! 1. a security-critical transition appends to the local journal;
//! 2. the new `(count, tail)` is committed to the independent witness;
//! 3. only after the acknowledgement may the transition authorize or be
//!    reported (grant minting, approval returned, execution started).
//!
//! A crash or witness outage between 1 and 2 leaves a locally appended but
//! unwitnessed tail. That state is deterministic and recoverable (the next
//! gate re-commits the continuation) and fail-closed: while it exists
//! no approval can be consumed and no grant can be minted.

use crate::Kernel;
use nexus_contracts::{KernelError, KernelErrorCode, KernelResult};
use nexus_store::ext_witness::{WitnessFailure, JOURNAL_APPROVAL, JOURNAL_TOOL};
use nexus_store::{Store, WitnessStore};

pub fn failure_to_kernel(f: &WitnessFailure) -> KernelError {
    let code = match f {
        WitnessFailure::Unavailable(_) => KernelErrorCode::WitnessRequired,
        WitnessFailure::Refused { .. } => KernelErrorCode::RollbackDetected,
        WitnessFailure::Unanchored(_) => KernelErrorCode::ReconciliationRequired,
    };
    KernelError::new(code, format!("independent witness: {f}"))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalIntegrity {
    pub journal: String,
    pub local_count: u64,
    pub witness_count: Option<u64>,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    /// verified | unanchored-legacy | witness-unavailable |
    /// recovery-required | integrity-mismatch | not-configured
    pub state: String,
    pub scope: String,
    pub configured: bool,
    pub journals: Vec<JournalIntegrity>,
    pub detail: String,
}

fn rank(s: &str) -> u8 {
    match s {
        "integrity-mismatch" => 5,
        "witness-unavailable" => 4,
        "unanchored-legacy" => 3,
        "recovery-required" => 2,
        "verified" => 1,
        _ => 0,
    }
}

pub const SCOPE: &str = "detects rollback, truncation, edits and store substitution relative to commitments \
    accepted by a separate same-host witness identity; does not resist root, a compromised witness UID, \
    or an attacker who controls the daemon before first anchoring";

fn tails(store: &Store) -> KernelResult<[(&'static str, u64, String); 2]> {
    let (tn, tt) = store.tool_journal_tail()?;
    let (an, at) = store.approval_tail()?;
    Ok([(JOURNAL_TOOL, tn, tt), (JOURNAL_APPROVAL, an, at)])
}

fn hash_at(store: &Store, journal: &str, pos: u64) -> Option<String> {
    match journal {
        JOURNAL_TOOL => store.tool_entry_hash_at(pos).ok().flatten(),
        _ => store.approval_hash_at(pos).ok().flatten(),
    }
}

impl Kernel {
    /// Attach the independent witness (requires the local witness store).
    pub fn attach_external_witness(
        &mut self,
        r: nexus_store::ext_witness::RemoteWitness,
    ) -> KernelResult<()> {
        match self.witness.as_mut() {
            Some(w) => {
                w.set_remote(r);
                Ok(())
            }
            None => Err(KernelError::new(
                KernelErrorCode::WitnessRequired,
                "an external witness requires the local witness store as well",
            )),
        }
    }

    /// Persistent latch: a store that has been anchored externally cannot
    /// be served for privileged operations without the witness again.
    /// Returns whether the store was ALREADY latched before this call
    /// (used to refuse legacy adoption onto an already-anchored store).
    pub fn enforce_witness_latch(&mut self, configured: bool) -> KernelResult<bool> {
        let cur = self.store.meta_get("external_witness")?;
        if configured {
            // The latch is only set by `mark_anchored` once the witness
            // actually holds this store's history (never on mere config).
            return Ok(cur.is_some());
        }
        if cur.is_some() {
            return Err(KernelError::new(
                KernelErrorCode::WitnessRequired,
                "witness-downgrade-refused: this store was anchored to an external witness",
            ));
        }
        Ok(false)
    }

    /// Record that the witness holds this store's history. From now on the
    /// store refuses privileged operation without the witness, and legacy
    /// adoption onto a different/fresh witness is refused.
    pub fn mark_anchored(&mut self) -> KernelResult<()> {
        if self.store.meta_get("external_witness")?.is_none() {
            self.store.meta_set("external_witness", "required")?;
        }
        Ok(())
    }

    /// Persistent security-profile latch. A store that has run under a
    /// named profile refuses privileged classes when started without it.
    pub fn enforce_security_profile(&mut self, requested: Option<&str>) -> KernelResult<()> {
        let cur = self.store.meta_get("security_profile")?;
        match (requested, cur.as_deref()) {
            (Some(r), None) => self.store.meta_set("security_profile", r),
            (Some(r), Some(c)) if r == c => Ok(()),
            (Some(r), Some(c)) => Err(KernelError::new(
                KernelErrorCode::ScopeRefused,
                format!("profile-downgrade-refused: store is bound to {c}, requested {r}"),
            )),
            (None, Some(c)) => Err(KernelError::new(
                KernelErrorCode::ScopeRefused,
                format!("profile-downgrade-refused: store is bound to security profile {c}"),
            )),
            (None, None) => Ok(()),
        }
    }

    pub fn external_witness_configured(&self) -> bool {
        self.witness.as_ref().is_some_and(|w| w.remote().is_some())
    }

    /// Commit the current tail of every journal (catch-up / gate). A
    /// no-op without an external witness. Fail-closed on any failure.
    pub(crate) fn anchor_all(store: &Store, witness: Option<&WitnessStore>) -> KernelResult<()> {
        let Some(r) = witness.and_then(|w| w.remote()) else {
            return Ok(());
        };
        for (name, n, tail) in tails(store)? {
            r.commit(name, n, &tail, &|p| hash_at(store, name, p))
                .map_err(|f| failure_to_kernel(&f))?;
        }
        Ok(())
    }

    /// Anchor around a result: an op that succeeded locally but cannot be
    /// witnessed is reported as failed (its effect stays unauthorized).
    pub(crate) fn anchored<T>(&mut self, r: KernelResult<T>) -> KernelResult<T> {
        if !self.external_witness_configured() {
            return r;
        }
        let a = Self::critical(&self.lock_file, &self.in_process, || {
            Self::anchor_all(&self.store, self.witness.as_ref())
        });
        match (r, a) {
            (Ok(v), Ok(())) => Ok(v),
            (Ok(_), Err(e)) => Err(e),
            (Err(e), _) => Err(e),
        }
    }

    pub(crate) fn anchor_gate(&mut self) -> KernelResult<()> {
        if !self.external_witness_configured() {
            return Ok(());
        }
        Self::critical(&self.lock_file, &self.in_process, || {
            Self::anchor_all(&self.store, self.witness.as_ref())
        })
    }

    /// Verify local chains and compare them with the witness. Never
    /// mutates authoritative history. With `recover`, an unwitnessed but
    /// consistent tail is committed and the block cleared when fully
    /// verified; mismatches are never cleared.
    pub fn integrity_report(&mut self, recover: bool) -> IntegrityReport {
        let scope = SCOPE.to_owned();
        let Some(w) = self.witness.as_ref().filter(|w| w.remote().is_some()) else {
            let chain = self
                .store
                .verify_tool_journal()
                .and_then(|_| self.store.approval_verify_chain());
            return IntegrityReport {
                state: if chain.is_ok() { "not-configured" } else { "integrity-mismatch" }.into(),
                scope: "local hash chains and seals only; NO independent anchor, tail truncation is not detectable".into(),
                configured: false,
                journals: Vec::new(),
                detail: match chain {
                    Ok(_) => "no external witness configured".into(),
                    Err(e) => e.message,
                },
            };
        };
        let _ = w;
        let mut out = IntegrityReport {
            state: "verified".into(),
            scope,
            configured: true,
            journals: Vec::new(),
            detail: String::new(),
        };
        let mut worst = "verified";
        let mut note = |state: &str, detail: &str, out: &mut IntegrityReport| {
            if rank(state) > rank(worst) {
                worst = match state {
                    "integrity-mismatch" => "integrity-mismatch",
                    "witness-unavailable" => "witness-unavailable",
                    "unanchored-legacy" => "unanchored-legacy",
                    "recovery-required" => "recovery-required",
                    _ => "verified",
                };
                out.detail = detail.to_owned();
            }
        };
        if let Err(e) = self.store.verify_tool_journal() {
            note(
                "integrity-mismatch",
                &format!("tool journal: {}", e.message),
                &mut out,
            );
        }
        if let Err(e) = self.store.approval_verify_chain() {
            note(
                "integrity-mismatch",
                &format!("approval events: {}", e.message),
                &mut out,
            );
        }
        let tl = match tails(&self.store) {
            Ok(t) => t,
            Err(e) => {
                out.state = "integrity-mismatch".into();
                out.detail = e.message;
                return out;
            }
        };
        for (name, n, tail) in tl.iter() {
            let r = self
                .witness
                .as_ref()
                .and_then(|w| w.remote())
                .map(|r| r.query(name));
            let (status, detail, wc) = match r {
                Some(Ok(Some(ws))) => {
                    if *n < ws.count {
                        (
                            "integrity-mismatch",
                            "local journal is behind the witness (rollback/truncation)".to_owned(),
                            Some(ws.count),
                        )
                    } else if hash_at(&self.store, name, ws.count).as_deref()
                        != Some(ws.tail.as_str())
                    {
                        (
                            "integrity-mismatch",
                            "local journal diverges from the witnessed tail (edit/fork/swap)"
                                .to_owned(),
                            Some(ws.count),
                        )
                    } else if *n > ws.count {
                        (
                            "recovery-required",
                            format!("{} local entries are not yet witnessed", n - ws.count),
                            Some(ws.count),
                        )
                    } else {
                        let _ = tail;
                        (
                            "verified",
                            "matches the witnessed tail".to_owned(),
                            Some(ws.count),
                        )
                    }
                }
                Some(Ok(None)) if *n == 0 => (
                    "recovery-required",
                    "empty journal not yet anchored".to_owned(),
                    None,
                ),
                Some(Ok(None)) => (
                    "unanchored-legacy",
                    format!(
                        "{n} entries predate any witness commitment; explicit adoption required"
                    ),
                    None,
                ),
                Some(Err(WitnessFailure::Refused { code, message })) => {
                    ("integrity-mismatch", format!("{code}: {message}"), None)
                }
                Some(Err(f)) => ("witness-unavailable", f.to_string(), None),
                None => ("witness-unavailable", "no witness".to_owned(), None),
            };
            note(status, &format!("{name}: {detail}"), &mut out);
            out.journals.push(JournalIntegrity {
                journal: (*name).to_owned(),
                local_count: *n,
                witness_count: wc,
                status: status.to_owned(),
                detail,
            });
        }
        out.state = worst.to_owned();
        if recover && matches!(worst, "recovery-required" | "unanchored-legacy") {
            let committed = Self::critical(&self.lock_file, &self.in_process, || {
                Self::anchor_all(&self.store, self.witness.as_ref())
            });
            if committed.is_ok() {
                return self.integrity_report(false).with_recovered();
            }
        }
        if let Some(w) = self.witness.as_mut() {
            match out.state.as_str() {
                "verified" => w.set_blocked(None),
                s => w.set_blocked(Some(format!("{s}: {}", out.detail))),
            }
        }
        out
    }
}

impl IntegrityReport {
    fn with_recovered(mut self) -> Self {
        if self.state == "verified" {
            self.detail =
                "recovered: unwitnessed tail was committed as a strict continuation".into();
        }
        self
    }
}
