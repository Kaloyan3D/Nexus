//! Standing grants (permissions milestone): the user's durable, per-project authorization.
//!
//! A grant states, on three independent axes, what commands of a project's tasks may do:
//! filesystem scope, network scope and approval behaviour (see `exec_contract`). It is created, replaced,
//! revoked and cleared ONLY through the user-gated broker verbs (CLI, Desktop native dialog); nothing a
//! model, a tool argument or a renderer message contains can reach this module's writers.
//!
//! * **Versioned.** Replacing a grant keeps its `grant_id` and bumps `version`; the digest binds project,
//!   id, version, the three axes and the expiry. Every change is also appended to an audit log.
//! * **Immutable per task.** A task freezes the effective values (and the grant's identity) into its
//!   identity record when it is created. Later edits only affect NEW tasks.
//! * **Can only shrink while running.** A running task stays valid until its grant lineage is revoked,
//!   cleared or expires (its frozen expiry, or a shorter one set later). A newer version never widens it.
//! * **Fail closed.** A capability this build does not implement (Full Access, the controlled network
//!   scopes) cannot be stored; an expired or revoked grant is rejected, never replaced by a default.

use crate::exec_contract::{Approval, FsScope, NetScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const GRANT_SCHEMA: &str = "nexus.standing-grant/v1";
/// Longest validity a grant may be given.
pub const MAX_VALIDITY_MS: i64 = 366 * 24 * 3600 * 1000;
const MAX_HISTORY: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for GrantError {}
pub fn gerr(code: &'static str, m: impl Into<String>) -> GrantError {
    GrantError {
        code,
        message: m.into(),
    }
}

/// What the user chose (before it becomes a versioned grant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantSpec {
    pub fs: String,
    pub net: String,
    pub approval: String,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandingGrant {
    pub grant_id: String,
    pub version: u64,
    pub fs: String,
    pub net: String,
    pub approval: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    /// Who created this version (`cli:uid:N`, `desktop:uid:N`).
    pub created_by: String,
    /// Digest of the exact consent text the user was shown.
    pub consent_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantEvent {
    pub at_ms: i64,
    /// `created` | `replaced` | `revoked`
    pub kind: String,
    pub version: u64,
    pub digest: String,
    pub by: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantState {
    pub current: StandingGrant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<GrantEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantStatus {
    Active,
    Expired,
    Revoked,
}

impl GrantStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantStatus::Active => "active",
            GrantStatus::Expired => "expired",
            GrantStatus::Revoked => "revoked",
        }
    }
}

/// The permissions a task runs under, frozen at task creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frozen {
    pub grant_id: String,
    pub version: u64,
    pub digest: String,
    pub fs: String,
    pub net: String,
    pub approval: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

impl Frozen {
    pub fn fs_scope(&self) -> FsScope {
        FsScope::parse(&self.fs).unwrap_or(FsScope::Scratch)
    }
    pub fn net_scope(&self) -> NetScope {
        NetScope::parse(&self.net).unwrap_or(NetScope::Offline)
    }
    pub fn approval_mode(&self) -> Approval {
        // an unreadable value is the stricter one
        Approval::parse(&self.approval).unwrap_or(Approval::Ask)
    }
}

impl StandingGrant {
    /// Digest of everything that defines what the grant allows.
    pub fn digest(&self, project_id: &str) -> String {
        let v = serde_json::json!({
            "schema": GRANT_SCHEMA,
            "projectId": project_id,
            "grantId": self.grant_id,
            "version": self.version,
            "fs": self.fs,
            "net": self.net,
            "approval": self.approval,
            "expiresAtMs": self.expires_at_ms,
        });
        hex::encode(Sha256::digest(
            nexus_contracts::canonical_json(&v).as_bytes(),
        ))
    }

    pub fn frozen(&self, project_id: &str) -> Frozen {
        Frozen {
            grant_id: self.grant_id.clone(),
            version: self.version,
            digest: self.digest(project_id),
            fs: self.fs.clone(),
            net: self.net.clone(),
            approval: self.approval.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }
}

impl GrantState {
    pub fn status(&self, now_ms: i64) -> GrantStatus {
        if self.revoked_at_ms.is_some() {
            GrantStatus::Revoked
        } else if self.current.expires_at_ms.is_some_and(|e| now_ms >= e) {
            GrantStatus::Expired
        } else {
            GrantStatus::Active
        }
    }

    pub fn push_event(&mut self, ev: GrantEvent) {
        self.history.push(ev);
        if self.history.len() > MAX_HISTORY {
            let drop = self.history.len() - MAX_HISTORY;
            self.history.drain(0..drop);
        }
    }
}

/// Validate what the user asked for against what this build can enforce and what the project allows.
/// Fail closed: an axis value that is not implemented is refused, never stored.
pub fn validate_spec(
    spec: &GrantSpec,
    project_is_direct: bool,
    now_ms: i64,
) -> Result<(FsScope, NetScope, Approval), GrantError> {
    let fs = match FsScope::parse(&spec.fs) {
        Some(FsScope::Full) => {
            return Err(gerr(
                "not-available",
                "Full Access is not available in this build; it cannot be granted yet",
            ))
        }
        Some(f) => f,
        None => {
            return Err(gerr(
                "bad-grant",
                "filesystem scope must be scratch or workspace",
            ))
        }
    };
    let net = match NetScope::parse(&spec.net) {
        Some(n) if n.is_implemented() => n,
        Some(_) => {
            return Err(gerr(
                "not-available",
                "that network scope is not available in this build; use offline or install",
            ))
        }
        None => {
            return Err(gerr(
                "bad-grant",
                "network scope must be offline or install",
            ))
        }
    };
    let approval = Approval::parse(&spec.approval)
        .ok_or_else(|| gerr("bad-grant", "approval must be ask or auto"))?;
    if fs == FsScope::Workspace && project_is_direct {
        return Err(gerr(
            "not-available",
            "commands that change your real folder directly are not available yet; use the isolated workspace for the workspace scope",
        ));
    }
    if let Some(e) = spec.expires_at_ms {
        if e <= now_ms {
            return Err(gerr("bad-grant", "the expiry is in the past"));
        }
        if e > now_ms.saturating_add(MAX_VALIDITY_MS) {
            return Err(gerr(
                "bad-grant",
                "a grant can be valid for at most one year",
            ));
        }
    }
    Ok((fs, net, approval))
}

/// The exact words the user is shown before a grant is stored; the digest of this text is recorded.
pub fn consent_text(project_label: &str, spec: &GrantSpec) -> String {
    let fs = match spec.fs.as_str() {
        "workspace" => "Commands Nexus runs for this project (builds, tests, formatters, code generators, dependency installs) change the task's working copy directly: what they create or modify stays there and becomes part of the patch you review. They cannot see or change anything outside the project.",
        _ => "Commands Nexus runs for this project work on a throw-away copy; whatever they write is discarded (edits are made with Nexus's own file tools).",
    };
    let net = match spec.net.as_str() {
        "install" => {
            "Dependency installation (npm, pip, cargo, ...) may use the internet. Nothing else may."
        }
        _ => "Commands have no network access.",
    };
    let ap = match spec.approval.as_str() {
        "ask" => "Every edit and command waits for your decision in the trusted approver terminal before it runs.",
        _ => "Edits and commands inside this grant run without asking you; anything outside it is refused.",
    };
    let exp = match spec.expires_at_ms {
        Some(_) => "This permission expires automatically.",
        None => "This permission does not expire until you revoke it.",
    };
    format!(
        "Permissions for \"{project_label}\" (affects new tasks only).\n\n• Filesystem: {fs}\n• Network: {net}\n• Approval: {ap}\n• {exp}\n• You can revoke it at any time (running tasks then stop being allowed to act).\n• Nexus never commits, pushes, merges or deploys, and no model request can create, widen or renew this permission."
    )
}

pub fn text_digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(fs: &str, net: &str, ap: &str, exp: Option<i64>) -> GrantSpec {
        GrantSpec {
            fs: fs.into(),
            net: net.into(),
            approval: ap.into(),
            expires_at_ms: exp,
        }
    }

    fn g() -> StandingGrant {
        StandingGrant {
            grant_id: "grt_a".into(),
            version: 3,
            fs: "workspace".into(),
            net: "offline".into(),
            approval: "auto".into(),
            created_at_ms: 1,
            expires_at_ms: Some(10_000),
            created_by: "cli:uid:1".into(),
            consent_sha256: "x".into(),
        }
    }

    #[test]
    fn unimplemented_capabilities_cannot_be_stored() {
        for (fs, net) in [
            ("full", "offline"),
            ("scratch", "controlled"),
            ("scratch", "full"),
            ("host", "offline"),
            ("scratch", "none"),
        ] {
            assert!(
                validate_spec(&spec(fs, net, "auto", None), false, 0).is_err(),
                "{fs}/{net}"
            );
        }
        assert!(validate_spec(&spec("workspace", "install", "ask", None), false, 0).is_ok());
        assert!(validate_spec(&spec("scratch", "offline", "maybe", None), false, 0).is_err());
        // in-place commands over a user's real folder do not exist yet
        assert!(validate_spec(&spec("workspace", "offline", "auto", None), true, 0).is_err());
        assert!(validate_spec(&spec("scratch", "offline", "auto", None), true, 0).is_ok());
    }

    #[test]
    fn expiry_is_bounded_and_status_follows_the_clock_and_revocation() {
        assert!(validate_spec(&spec("scratch", "offline", "auto", Some(5)), false, 5).is_err());
        assert!(validate_spec(&spec("scratch", "offline", "auto", Some(6)), false, 5).is_ok());
        assert!(validate_spec(
            &spec("scratch", "offline", "auto", Some(5 + MAX_VALIDITY_MS + 1)),
            false,
            5
        )
        .is_err());
        let mut s = GrantState {
            current: g(),
            revoked_at_ms: None,
            revoked_by: None,
            history: vec![],
        };
        assert_eq!(s.status(9_999), GrantStatus::Active);
        assert_eq!(s.status(10_000), GrantStatus::Expired);
        s.revoked_at_ms = Some(5);
        assert_eq!(s.status(1), GrantStatus::Revoked);
    }

    #[test]
    fn the_digest_binds_every_field_that_defines_the_permission() {
        let base = g().digest("p");
        assert_eq!(base, g().digest("p"));
        assert_ne!(base, g().digest("q"));
        for f in [
            |x: &mut StandingGrant| x.grant_id = "grt_b".into(),
            |x: &mut StandingGrant| x.version = 4,
            |x: &mut StandingGrant| x.fs = "scratch".into(),
            |x: &mut StandingGrant| x.net = "install".into(),
            |x: &mut StandingGrant| x.approval = "ask".into(),
            |x: &mut StandingGrant| x.expires_at_ms = None,
        ] {
            let mut x = g();
            f(&mut x);
            assert_ne!(base, x.digest("p"));
        }
        // not part of the digest: who/when/consent text
        let mut x = g();
        x.created_by = "other".into();
        x.created_at_ms = 99;
        assert_eq!(base, x.digest("p"));
    }

    #[test]
    fn an_unreadable_frozen_approval_is_the_stricter_one() {
        let mut f = g().frozen("p");
        f.approval = "???".into();
        assert_eq!(f.approval_mode(), Approval::Ask);
        f.fs = "full".into();
        assert_eq!(f.fs_scope(), FsScope::Full); // parse keeps it visible; execution refuses it
    }
}
