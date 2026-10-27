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
//! * **Can only shrink while running.** A running task holds, at every operation, the STRICTER of what it
//!   froze and what its grant lineage allows now, per axis ([`narrowed`]): widening the grant never
//!   reaches a task that already started; narrowing it applies from the task's next operation; a command
//!   already running is ended only by revocation, removal, replacement or expiry (its frozen expiry, or a
//!   shorter one set later). Granting again after a revocation is a new lineage: old tasks stay stopped.
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

/// How an in-place command is protected beyond confinement (M4). Chosen by the user together with the
/// grant; part of the grant digest only when it differs from the defaults, so existing grants keep theirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecPolicy {
    /// `off` | `best-effort` (default, owner decision D4) | `required` (refuse a command without a complete checkpoint).
    pub checkpoint: String,
    /// `protect` (default: hard-linked files are read-only for the command) | `allow` (owner-only override).
    pub hard_links: String,
    /// `off` (default) | `read-only`: bind the verified main git directory of a linked worktree read-only.
    #[serde(default = "off_str")]
    pub git_worktree: String,
    /// M6B: the user explicitly allows commands to WRITE this repository's `.git` (commit, branch,
    /// checkout, …). Default false = `.git` stays read-only. Distinct from ordinary filesystem write
    /// permission; part of the grant digest when true; `hooks` and `config` inside `.git` stay
    /// read-only even then. Linked worktrees / submodules whose git directory lives OUTSIDE the
    /// workspace are never made writable by this flag (explicitly unsupported in M6).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub git_write: bool,
    /// M7C: development-server ports (inside the sandbox) that Nexus may expose on host loopback
    /// for this project's background jobs. Empty = no exposure. The model cannot name or change
    /// these; they are sealed into the grant digest and only narrowable while a task runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dev_ports: Vec<u16>,
    /// Controlled Internet (M5): the destinations commands may reach. Meaningful only with network scope
    /// `controlled`; part of the grant digest, so the Kernel seals it with the grant.
    #[serde(default, skip_serializing_if = "crate::netpolicy::NetPolicy::is_empty")]
    pub net: crate::netpolicy::NetPolicy,
}

fn off_str() -> String {
    "off".into()
}

impl Default for ExecPolicy {
    fn default() -> Self {
        Self {
            checkpoint: "best-effort".into(),
            hard_links: "protect".into(),
            git_worktree: "off".into(),
            git_write: false,
            dev_ports: Vec::new(),
            net: Default::default(),
        }
    }
}

impl ExecPolicy {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn validate(&self) -> Result<(), GrantError> {
        if !matches!(self.checkpoint.as_str(), "off" | "best-effort" | "required") {
            return Err(gerr(
                "bad-grant",
                "checkpoint policy must be off, best-effort or required",
            ));
        }
        if !matches!(self.hard_links.as_str(), "protect" | "allow") {
            return Err(gerr(
                "bad-grant",
                "hard-link policy must be protect or allow",
            ));
        }
        if !matches!(self.git_worktree.as_str(), "off" | "read-only") {
            return Err(gerr(
                "bad-grant",
                "git worktree access must be off or read-only",
            ));
        }
        if self.dev_ports.len() > 32 || self.dev_ports.contains(&0) {
            return Err(gerr(
                "bad-grant",
                "development ports must be 1..=65535, at most 32 of them",
            ));
        }
        self.net.validate().map_err(|m| gerr("bad-grant", m))?;
        Ok(())
    }

    pub fn checkpoint_mode(&self) -> crate::checkpoint::Mode {
        // an unreadable value is the strictest
        crate::checkpoint::Mode::parse(&self.checkpoint)
            .unwrap_or(crate::checkpoint::Mode::Required)
    }

    pub fn hard_link_policy(&self) -> crate::inplace::HardLinks {
        match self.hard_links.as_str() {
            "allow" => crate::inplace::HardLinks::Allow,
            _ => crate::inplace::HardLinks::Protect,
        }
    }
}

/// What the user chose (before it becomes a versioned grant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantSpec {
    pub fs: String,
    pub net: String,
    pub approval: String,
    pub expires_at_ms: Option<i64>,
    pub exec: ExecPolicy,
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
    #[serde(default, skip_serializing_if = "ExecPolicy::is_default")]
    pub exec: ExecPolicy,
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
    #[serde(default, skip_serializing_if = "ExecPolicy::is_default")]
    pub exec: ExecPolicy,
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
        let mut v = serde_json::json!({
            "schema": GRANT_SCHEMA,
            "projectId": project_id,
            "grantId": self.grant_id,
            "version": self.version,
            "fs": self.fs,
            "net": self.net,
            "approval": self.approval,
            "expiresAtMs": self.expires_at_ms,
        });
        if !self.exec.is_default() {
            v["exec"] = serde_json::json!({"checkpoint": self.exec.checkpoint, "hardLinks": self.exec.hard_links});
            if self.exec.git_worktree != "off" {
                v["exec"]["gitWorktree"] = self.exec.git_worktree.clone().into();
            }
            if self.exec.git_write {
                v["exec"]["gitWrite"] = true.into();
            }
            if !self.exec.dev_ports.is_empty() {
                let mut ports = self.exec.dev_ports.clone();
                ports.sort_unstable();
                ports.dedup();
                v["exec"]["devPorts"] = ports.into();
            }
            if !self.exec.net.is_empty() {
                v["exec"]["netPolicy"] =
                    serde_json::to_value(self.exec.net.canonical()).unwrap_or_default();
            }
        }
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
            exec: self.exec.clone(),
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
    let _ = project_is_direct;
    spec.exec.validate()?;
    if net == NetScope::Controlled {
        if fs != FsScope::Workspace {
            return Err(gerr(
                "bad-grant",
                "Controlled Internet is available to commands that run in place (filesystem scope: workspace)",
            ));
        }
        if spec.exec.net.is_empty() {
            return Err(gerr(
                "bad-grant",
                "Controlled Internet needs at least one allowed destination (a host name, or a port of a service on this machine)",
            ));
        }
    } else if !spec.exec.net.is_empty() {
        return Err(gerr(
            "bad-grant",
            "allowed destinations apply only to Controlled Internet (network: controlled)",
        ));
    }
    if fs != FsScope::Workspace && !spec.exec.is_default() {
        return Err(gerr(
            "bad-grant",
            "checkpoint and hard-link policies apply to commands that change the project in place (filesystem scope: workspace)",
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
    consent_text_for(project_label, spec, false)
}

/// As [`consent_text`], truthful about a project that edits its REAL folder (`direct`).
pub fn consent_text_for(project_label: &str, spec: &GrantSpec, direct: bool) -> String {
    let fs = match spec.fs.as_str() {
        "workspace" if direct && spec.exec.git_write => "Commands Nexus runs for this project (builds, tests, formatters, code generators, dependency installs) run in your REAL project folder, with no copy and no patch to apply: files they create, change or delete are changed on disk immediately, together with the files Nexus edits itself. They cannot see or change anything outside the project. You ALLOW Git writes below, so commands may also change the repository's `.git` (commit, branch, checkout); `.git/hooks` and `.git/config` stay read-only. Secret-shaped files, sockets and similar entries are hidden from commands, and files with several hard links are read-only unless you allow otherwise below.",
        "workspace" if direct => "Commands Nexus runs for this project (builds, tests, formatters, code generators, dependency installs) run in your REAL project folder, with no copy and no patch to apply: files they create, change or delete are changed on disk immediately, together with the files Nexus edits itself. They cannot see or change anything outside the project. `.git` is read-only (Nexus cannot commit, change hooks or configuration), secret-shaped files, sockets and similar entries are hidden from commands, and files with several hard links are read-only unless you allow otherwise below.",
        "workspace" => "Commands Nexus runs for this project (builds, tests, formatters, code generators, dependency installs) change the task's working copy directly: what they create or modify stays there and becomes part of the patch you review. They cannot see or change anything outside the project.",
        _ => "Commands Nexus runs for this project work on a throw-away copy; whatever they write is discarded (edits are made with Nexus's own file tools).",
    };
    let controlled_text;
    let net = match spec.net.as_str() {
        "install" => {
            "Dependency installation (npm, pip, cargo, ...) may use the internet. Nothing else may."
        }
        "controlled" => {
            let p = spec.exec.net.canonical();
            let hosts = p
                .hosts
                .iter()
                .map(|r| {
                    format!(
                        "{} (port {})",
                        r.host,
                        r.ports
                            .iter()
                            .map(u16::to_string)
                            .collect::<Vec<_>>()
                            .join("/")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let local =
                if p.local_ports.is_empty() {
                    String::new()
                } else {
                    format!(
                    " Commands may also reach services running on THIS machine at these ports: {}.",
                    p.local_ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
                )
                };
            controlled_text = format!(
                "Commands may use the internet ONLY to reach: {}.{local} Every connection goes through Nexus's network gatekeeper, which refuses any other destination, IP addresses, and names that resolve to your own network or to cloud-metadata addresses. It checks WHERE a command connects, not WHAT it sends: encrypted traffic is not inspected, and anything a command can read (including your source code and any secrets it can see) can be sent to a destination you allow here. Allow only destinations you trust with that.",
                if hosts.is_empty() { "(no internet hosts)".to_owned() } else { hosts }
            );
            controlled_text.as_str()
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
    let mut extra = String::new();
    if spec.fs == "workspace" && (direct || !spec.exec.is_default() || spec.net == "controlled") {
        let ck = match spec.exec.checkpoint.as_str() {
            "required" => "Before every command Nexus must save a complete checkpoint of your project files; if it cannot, the command does not run.",
            "off" => "No checkpoint is taken before commands: what a command changes cannot be restored by Nexus.",
            _ => "Before every command Nexus tries to save a checkpoint of your project files. If it cannot (very large files, little disk space, files that change while it copies), the command still runs and the result says exactly what could not be restored.",
        };
        let hl = match spec.exec.hard_links.as_str() {
            "allow" => "You ALLOW commands to write files that have several hard links: a write through the project name also changes every other name of that file, including names outside the project.",
            _ => "Files that have several hard links are read-only for commands, so a command cannot change content that is also reachable from outside the project.",
        };
        let gw = if spec.exec.git_worktree == "read-only" {
            "\n• Git worktree: if the project folder is a linked Git worktree, the main repository's .git directory (history, configuration, hooks) is made READABLE to commands, read-only, after Nexus verified that it really belongs to this worktree."
        } else {
            ""
        };
        let gitw = if spec.exec.git_write {
            "\n• Git writes: commands may write this repository's .git directory (commit, create branches, check out, reset). `.git/hooks` and `.git/config` stay READ-ONLY, so commands cannot plant hooks or change repository configuration; Git metadata outside this folder (linked worktrees, submodule stores) is never made writable. Git history changes are NOT covered by checkpoints and Nexus cannot undo a commit, reset or branch deletion for you. Hooks already present in the repository will run inside the sandbox when Git executes them; if you later run Git yourself outside Nexus, the repository's existing hooks and configuration apply as usual — Nexus did not change them.\n• One limit that applies either way: if a command CREATES a repository (git init) in a folder that had no .git, the metadata it writes during that same command (including any hook it creates) cannot be mount-protected — protection applies from the next command on, and the command's result says when this happened."
        } else {
            "\n• One limit: if a command CREATES a repository (git init) in a folder that had no .git, the metadata it writes during that same command (a commit, a hook, configuration) cannot be mount-protected — protection applies from the next command on, and the command's result says when this happened."
        };
        let devp = if spec.exec.dev_ports.is_empty() {
            String::new()
        } else {
            let mut ports = spec.exec.dev_ports.clone();
            ports.sort_unstable();
            ports.dedup();
            format!(
                "\n• Development servers: background jobs in this project may expose these ports on THIS machine's loopback only (127.0.0.1), so you can open the dev server in your browser: {}. No other port is exposed, nothing is bound publicly, and closing the job or narrowing this permission removes the access.",
                ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
            )
        };
        extra = format!(
            "\n• Recovery: {ck}\n• Hard links: {hl}{gw}{gitw}{devp}\n• Limits you should know: a checkpoint is not an atomic snapshot and does not cover dependency or build folders (node_modules, target, ...), .git, or secret-shaped files; a command's effect on the outside world (network installs, other tools) cannot be undone; restoring is an explicit action you take, and files you changed afterwards are never overwritten."
        );
    }
    format!(
        "Permissions for \"{project_label}\".\n\n• Filesystem: {fs}\n• Network: {net}\n• Approval: {ap}\n• {exp}{extra}\n• Changing these permissions affects NEW tasks. A task that is already running never gains anything; if you narrow them it follows from its next operation; if you revoke them it stops, including a command in progress.\n• Nexus never commits, pushes, merges or deploys, and no model request can create, widen or renew this permission."
    )
}

fn rank_fs(s: &str) -> u8 {
    match s {
        "scratch" => 0,
        "workspace" => 1,
        _ => 2, // anything unknown is the widest, so it can only be narrowed away
    }
}
fn rank_net(s: &str) -> u8 {
    match s {
        "offline" => 0,
        "controlled" => 1,
        "install" => 2, // the legacy install class reaches the whole internet: the widest implemented
        _ => 3,
    }
}

/// What a running task holds now: its frozen identity (id, version, digest, expiry) with each axis limited
/// to the stricter of the frozen value and the lineage's CURRENT value. Never wider than frozen.
pub fn narrowed(frozen: &Frozen, current: &StandingGrant) -> Frozen {
    let mut f = frozen.clone();
    if rank_fs(&current.fs) < rank_fs(&f.fs) {
        f.fs = current.fs.clone();
    }
    let frozen_was_controlled = f.net == "controlled";
    if rank_net(&current.net) < rank_net(&f.net) {
        f.net = current.net.clone();
    }
    // Controlled Internet: what a running task may reach is what BOTH its frozen and its current policy allow
    if f.net == "controlled" {
        f.exec.net = if frozen_was_controlled && current.net == "controlled" {
            frozen.exec.net.intersect(&current.exec.net)
        } else if frozen_was_controlled {
            frozen.exec.net.clone() // (the current grant is the wider install class: never wider than frozen)
        } else {
            current.exec.net.clone() // frozen was the legacy install class, narrowed to the current policy
        };
    } else {
        f.exec.net = Default::default();
    }
    // checkpoint: required > best-effort > off; hard links: protect > allow
    let rank_ck = |s: &str| match s {
        "off" => 0,
        "best-effort" => 1,
        _ => 2,
    };
    if rank_ck(&current.exec.checkpoint) > rank_ck(&f.exec.checkpoint) {
        f.exec.checkpoint = current.exec.checkpoint.clone();
    }
    if current.exec.hard_links != "allow" {
        f.exec.hard_links = "protect".into();
    }
    if current.exec.git_worktree == "off" {
        f.exec.git_worktree = "off".into();
    }
    // Git write (M6B) can only be lost while a task runs, never gained
    if !current.exec.git_write {
        f.exec.git_write = false;
    }
    // Development ports (M7C): a running task keeps only ports its current grant still allows
    f.exec
        .dev_ports
        .retain(|p| current.exec.dev_ports.contains(p));
    // "ask" is the stricter approval behaviour; an unreadable value counts as ask
    if f.approval != "ask" && current.approval != "auto" {
        f.approval = "ask".into();
    }
    f
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
            exec: Default::default(),
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
            exec: Default::default(),
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
        assert!(validate_spec(&spec("workspace", "offline", "auto", None), true, 0).is_ok());
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
    fn a_running_task_holds_the_stricter_of_what_it_froze_and_what_is_granted_now() {
        let mk = |fs: &str, net: &str, ap: &str| {
            let mut g = g();
            g.fs = fs.into();
            g.net = net.into();
            g.approval = ap.into();
            g
        };
        let frozen = mk("workspace", "install", "auto").frozen("p");
        // identical, or WIDER now: nothing changes (never gains)
        for cur in [
            mk("workspace", "install", "auto"),
            mk("workspace", "install", "auto"),
        ] {
            assert_eq!(narrowed(&frozen, &cur), frozen);
        }
        let narrow_fs = narrowed(&frozen, &mk("scratch", "install", "auto"));
        assert_eq!(
            (
                narrow_fs.fs.as_str(),
                narrow_fs.net.as_str(),
                narrow_fs.approval.as_str()
            ),
            ("scratch", "install", "auto")
        );
        let narrow_net = narrowed(&frozen, &mk("workspace", "offline", "auto"));
        assert_eq!(
            (narrow_net.fs.as_str(), narrow_net.net.as_str()),
            ("workspace", "offline")
        );
        let narrow_ap = narrowed(&frozen, &mk("workspace", "install", "ask"));
        assert_eq!(narrow_ap.approval, "ask");
        // identity is the FROZEN one
        assert_eq!(
            (
                narrow_ap.grant_id.as_str(),
                narrow_ap.version,
                narrow_ap.digest.as_str()
            ),
            (
                frozen.grant_id.as_str(),
                frozen.version,
                frozen.digest.as_str()
            )
        );
        // a task frozen at the narrow end never gains from a wider grant
        let low = mk("scratch", "offline", "ask").frozen("p");
        assert_eq!(narrowed(&low, &mk("workspace", "install", "auto")), low);
        // an unknown current approval counts as ask
        let mut weird = mk("workspace", "install", "auto");
        weird.approval = "???".into();
        assert_eq!(narrowed(&frozen, &weird).approval, "ask");
    }

    #[test]
    fn an_unreadable_frozen_approval_is_the_stricter_one() {
        let mut f = g().frozen("p");
        f.approval = "???".into();
        assert_eq!(f.approval_mode(), Approval::Ask);
        f.fs = "full".into();
        assert_eq!(f.fs_scope(), FsScope::Full); // parse keeps it visible; execution refuses it
    }

    #[test]
    fn the_execution_policy_is_part_of_the_digest_only_when_it_is_not_the_default() {
        let a = g();
        let legacy = {
            let v = serde_json::json!({
                "schema": GRANT_SCHEMA, "projectId": "p", "grantId": a.grant_id, "version": a.version,
                "fs": a.fs, "net": a.net, "approval": a.approval, "expiresAtMs": a.expires_at_ms,
            });
            hex::encode(Sha256::digest(
                nexus_contracts::canonical_json(&v).as_bytes(),
            ))
        };
        assert_eq!(
            a.digest("p"),
            legacy,
            "existing grants must keep their digest"
        );
        for (c, h, w) in [
            ("required", "protect", "off"),
            ("best-effort", "allow", "off"),
            ("off", "protect", "off"),
            ("best-effort", "protect", "read-only"),
        ] {
            let mut b = g();
            b.exec = ExecPolicy {
                checkpoint: c.into(),
                hard_links: h.into(),
                git_worktree: w.into(),
                ..Default::default()
            };
            assert_ne!(b.digest("p"), legacy, "{c} {h} {w}");
        }
    }

    #[test]
    fn a_running_task_can_only_lose_recovery_and_protection_settings_never_gain_them() {
        let mut frozen = g().frozen("p");
        frozen.exec = ExecPolicy {
            checkpoint: "best-effort".into(),
            hard_links: "allow".into(),
            git_worktree: "read-only".into(),
            ..Default::default()
        };
        let mut cur = g();
        cur.exec = ExecPolicy {
            checkpoint: "required".into(),
            hard_links: "protect".into(),
            git_worktree: "off".into(),
            ..Default::default()
        };
        let n = narrowed(&frozen, &cur);
        assert_eq!(
            (
                n.exec.checkpoint.as_str(),
                n.exec.hard_links.as_str(),
                n.exec.git_worktree.as_str()
            ),
            ("required", "protect", "off")
        );
        // a later, looser setting never reaches a task that froze a stricter one
        let mut strict = g().frozen("p");
        strict.exec = ExecPolicy {
            checkpoint: "required".into(),
            hard_links: "protect".into(),
            git_worktree: "off".into(),
            ..Default::default()
        };
        let mut loose = g();
        loose.exec = ExecPolicy {
            checkpoint: "off".into(),
            hard_links: "allow".into(),
            git_worktree: "read-only".into(),
            ..Default::default()
        };
        let n = narrowed(&strict, &loose);
        assert_eq!(
            (
                n.exec.checkpoint.as_str(),
                n.exec.hard_links.as_str(),
                n.exec.git_worktree.as_str()
            ),
            ("required", "protect", "off")
        );
    }

    #[test]
    fn the_consent_text_for_a_real_folder_names_the_real_folder_and_each_limit() {
        let mut sp = spec("workspace", "offline", "auto", None);
        let t = consent_text_for("proj", &sp, true);
        for must in [
            "REAL project folder",
            "immediately",
            ".git` is read-only",
            "not an atomic snapshot",
            "Before every command Nexus tries",
        ] {
            assert!(t.contains(must), "{must}: {t}");
        }
        sp.exec = ExecPolicy {
            checkpoint: "required".into(),
            hard_links: "allow".into(),
            git_worktree: "read-only".into(),
            ..Default::default()
        };
        let t = consent_text_for("proj", &sp, true);
        assert!(
            t.contains("must save a complete checkpoint")
                && t.contains("ALLOW commands to write files that have several hard links")
                && t.contains("Git worktree"),
            "{t}"
        );
        // isolated copies keep their historical wording
        assert!(
            !consent_text("proj", &spec("workspace", "offline", "auto", None))
                .contains("REAL project folder")
        );
        // scratch grants cannot carry policies
        let mut bad = spec("scratch", "offline", "auto", None);
        bad.exec.checkpoint = "required".into();
        assert!(validate_spec(&bad, false, 0).is_err());
    }

    #[test]
    fn m6b_git_write_is_a_distinct_sealed_narrowable_capability() {
        let now = 1_000;
        // default: read-only, and the default grant keeps its historical digest shape
        let mut with = spec("workspace", "offline", "auto", None);
        with.exec.git_write = true;
        assert!(validate_spec(&with, true, now).is_ok());
        // it only exists with in-place (workspace) execution
        let mut bad = spec("scratch", "offline", "auto", None);
        bad.exec.git_write = true;
        assert!(validate_spec(&bad, true, now).is_err());
        // sealed: turning it on changes the digest
        let g = |w: bool| {
            let mut s = StandingGrant {
                grant_id: "g".into(),
                version: 1,
                fs: "workspace".into(),
                net: "offline".into(),
                approval: "auto".into(),
                created_at_ms: 0,
                expires_at_ms: None,
                created_by: "cli:uid:1".into(),
                consent_sha256: "x".into(),
                exec: ExecPolicy::default(),
            };
            s.exec.git_write = w;
            s
        };
        assert_ne!(g(true).digest("p"), g(false).digest("p"));
        // frozen as granted; a grant that no longer allows it narrows a running task; the
        // reverse never widens one
        let frozen = g(true).frozen("p");
        assert!(frozen.exec.git_write);
        assert!(!narrowed(&frozen, &g(false)).exec.git_write);
        let frozen_off = g(false).frozen("p");
        assert!(!narrowed(&frozen_off, &g(true)).exec.git_write);
        // the consent text says what changes and what does not
        let t = consent_text_for("proj", &with, true);
        for must in [
            "You ALLOW Git writes",
            "`.git/hooks` and `.git/config` stay READ-ONLY",
            "NOT covered by checkpoints",
            "never made writable",
        ] {
            assert!(t.contains(must), "{must}: {t}");
        }
        let t_off = consent_text_for("proj", &spec("workspace", "offline", "auto", None), true);
        assert!(t_off.contains("`.git` is read-only"), "{t_off}");
    }
}
