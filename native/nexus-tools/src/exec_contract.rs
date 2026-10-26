//! Platform-neutral execution contract (True In-Place Execution, milestone 1).
//!
//! `NEXUS-TRUE-IN-PLACE-EXECUTION-ADR.md` (revision 2) separates what a command may do into
//! independent axes - filesystem scope, network scope and approval behaviour - and requires that the
//! backend that enforces them says what it can actually enforce, and that a missing capability
//! REFUSES the execution. It never selects a weaker (or stronger) scope on its own.
//!
//! Milestone 1 implements exactly one new filesystem scope, [`FsScope::Workspace`], and only over a
//! disposable, daemon-owned Isolated task copy. [`FsScope::Full`], the controlled network scopes and
//! the approval axis are defined so that sealed records and later stages have stable names, but every
//! one of them is refused here ([`ExecRefusal::NotImplemented`]); there is deliberately no code path
//! that turns a refusal into a different scope.
//!
//! Nothing in this module is reachable from model-controlled input: the scope of an execution is
//! derived by the daemon from its own task identity record, sealed by the Kernel in the process
//! scope, and only then read here.

use crate::result::{ToolError, ToolErrorCode};
use crate::sandbox::{SandboxControl, SandboxOutcome, SandboxSpec};

/// Filesystem scope of one command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FsScope {
    /// A3.4 behaviour: a filtered, staged throw-away copy; whatever the command writes is discarded.
    #[default]
    Scratch,
    /// The task's own (disposable) working copy is bound read-write; the host is otherwise invisible.
    Workspace,
    /// Host filesystem under the user's OS permissions. Defined for the sealed vocabulary; NOT implemented.
    Full,
}

impl FsScope {
    pub const SCRATCH: &'static str = "scratch";
    pub const WORKSPACE: &'static str = "workspace";
    pub const FULL: &'static str = "full";

    pub fn as_str(self) -> &'static str {
        match self {
            FsScope::Scratch => Self::SCRATCH,
            FsScope::Workspace => Self::WORKSPACE,
            FsScope::Full => Self::FULL,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            Self::SCRATCH => Some(FsScope::Scratch),
            Self::WORKSPACE => Some(FsScope::Workspace),
            Self::FULL => Some(FsScope::Full),
            _ => None,
        }
    }

    /// Scopes the code can execute today.
    pub fn is_implemented(self) -> bool {
        !matches!(self, FsScope::Full)
    }
}

/// Network scope. `Offline` and the legacy per-command `Install` class exist today; the rest is reserved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NetScope {
    #[default]
    Offline,
    /// Dependency installation only (the existing class: host network, install commands, projects that allow it).
    Install,
    /// Reserved (ADR S5): host-side egress proxy with a destination policy.
    Controlled,
    /// Reserved (ADR S8): the host network namespace.
    Full,
}

impl NetScope {
    pub fn is_implemented(self) -> bool {
        matches!(
            self,
            NetScope::Offline | NetScope::Install | NetScope::Controlled
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            NetScope::Offline => "offline",
            NetScope::Install => "install",
            NetScope::Controlled => "controlled",
            NetScope::Full => "full",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "offline" => Some(NetScope::Offline),
            "install" => Some(NetScope::Install),
            "controlled" => Some(NetScope::Controlled),
            "full" => Some(NetScope::Full),
            _ => None,
        }
    }
}

/// Approval behaviour. Recorded for the vocabulary; the daemon's existing mode switch still decides (ADR S2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Approval {
    Ask,
    #[default]
    Auto,
}

impl Approval {
    pub fn as_str(self) -> &'static str {
        match self {
            Approval::Ask => "ask",
            Approval::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ask" => Some(Approval::Ask),
            "auto" => Some(Approval::Auto),
            _ => None,
        }
    }
}

/// The three independent axes of one execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecGrant {
    pub fs: FsScope,
    pub net: NetScope,
    pub approval: Approval,
}

/// How a path inside the pinned root is protected from the command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectMode {
    /// Visible, not writable (a read-only sub-mount of the same object).
    ReadOnly,
    /// An existing file/socket/fifo replaced by an empty file.
    HideFile,
    /// An existing directory replaced by an empty tmpfs.
    HideDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillGuarantee {
    /// Every process of the execution is killed (cgroup + PID namespace).
    Cgroup,
    /// Process group only; a double-fork can escape.
    ProcessGroupBestEffort,
}

/// What a backend can really enforce - probed, never assumed from the platform name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendCaps {
    pub id: &'static str,
    pub fs_scopes: Vec<FsScope>,
    pub net_scopes: Vec<NetScope>,
    /// The writable root is bound by an open descriptor of the verified object, not by a path.
    pub pinned_root_mount: bool,
    /// A sub-path of the writable root can be made read-only.
    pub subpath_readonly: bool,
    /// Existing secret-shaped entries can be hidden from the command.
    pub hide_existing_entries: bool,
    pub kernel_resource_limits: bool,
    pub kill_tree: KillGuarantee,
    /// Landlock ABI of the running kernel (None = unavailable) and the launch gate that applies it.
    pub landlock_abi: Option<u32>,
    pub launch_gate: bool,
}

/// What a grant needs from the backend.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RequiredCaps {
    pub pinned_root_mount: bool,
    pub subpath_readonly: bool,
    pub hide_existing_entries: bool,
    /// Kernel confinement (Landlock, at least `confine::MIN_ABI`) applied by the launch gate.
    pub kernel_confinement: bool,
}

impl RequiredCaps {
    pub fn for_grant(g: &ExecGrant) -> Self {
        match g.fs {
            FsScope::Workspace => RequiredCaps {
                pinned_root_mount: true,
                subpath_readonly: true,
                hide_existing_entries: true,
                kernel_confinement: true,
            },
            _ => RequiredCaps::default(),
        }
    }
}

/// A refusal to execute. Its text names what is missing; the user may then choose a different
/// grant. The harness never does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecRefusal {
    NotImplemented(&'static str),
    BackendInsufficient(Vec<&'static str>),
}

impl ExecRefusal {
    pub fn into_error(self) -> ToolError {
        match self {
            ExecRefusal::NotImplemented(what) => ToolError::new(
                ToolErrorCode::SandboxUnavailable,
                format!("{what} is not available in this build; nothing was run and no other scope was substituted"),
            ),
            ExecRefusal::BackendInsufficient(missing) => ToolError::new(
                ToolErrorCode::SandboxUnavailable,
                format!(
                    "this machine's sandbox cannot provide: {}; nothing was run and no other scope was substituted",
                    missing.join(", ")
                ),
            ),
        }
    }
}

/// Check a grant against a backend. Pure.
pub fn check_grant(caps: &BackendCaps, g: &ExecGrant) -> Result<(), ExecRefusal> {
    if !g.fs.is_implemented() || !caps.fs_scopes.contains(&g.fs) {
        return Err(ExecRefusal::NotImplemented(match g.fs {
            FsScope::Full => "Full Access",
            _ => "this filesystem scope",
        }));
    }
    if !g.net.is_implemented() || !caps.net_scopes.contains(&g.net) {
        return Err(ExecRefusal::NotImplemented("this network scope"));
    }
    let req = RequiredCaps::for_grant(g);
    let mut missing = Vec::new();
    if req.pinned_root_mount && !caps.pinned_root_mount {
        missing.push("a root mount bound by verified descriptor");
    }
    if req.subpath_readonly && !caps.subpath_readonly {
        missing.push("read-only sub-mounts");
    }
    if req.hide_existing_entries && !caps.hide_existing_entries {
        missing.push("hiding existing secret entries");
    }
    if req.kernel_confinement
        && !(caps.launch_gate
            && caps
                .landlock_abi
                .is_some_and(|a| a >= crate::confine::MIN_ABI))
    {
        missing.push("kernel confinement (Landlock) with its launch gate");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ExecRefusal::BackendInsufficient(missing))
    }
}

/// An execution backend. Linux/bubblewrap is the only implementation; the trait exists so that the
/// capability check and the grant vocabulary do not name bubblewrap.
pub trait ExecBackend: Send + Sync {
    fn caps(&self) -> BackendCaps;
    fn run(
        &self,
        spec: &SandboxSpec,
        control: &mut dyn SandboxControl,
    ) -> Result<SandboxOutcome, ToolError>;
}

/// bubblewrap + seccomp + cgroup v2 (A3.4), extended with descriptor-bound roots.
#[derive(Debug, Default, Clone, Copy)]
pub struct LinuxBwrapBackend;

fn bwrap_supports_fd_binds() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        std::process::Command::new("/usr/bin/bwrap")
            .arg("--help")
            .output()
            .map(|o| {
                let t = String::from_utf8_lossy(&o.stdout).into_owned()
                    + &String::from_utf8_lossy(&o.stderr);
                t.contains("--bind-fd") && t.contains("--ro-bind-fd")
            })
            .unwrap_or(false)
    })
}

impl ExecBackend for LinuxBwrapBackend {
    fn caps(&self) -> BackendCaps {
        let fd = bwrap_supports_fd_binds() && cfg!(target_arch = "x86_64");
        BackendCaps {
            id: "linux-bwrap/1",
            fs_scopes: if fd {
                vec![FsScope::Scratch, FsScope::Workspace]
            } else {
                vec![FsScope::Scratch]
            },
            net_scopes: vec![NetScope::Offline, NetScope::Install, NetScope::Controlled],
            pinned_root_mount: fd,
            subpath_readonly: fd,
            hide_existing_entries: fd,
            kernel_resource_limits: crate::sandbox::kernel_limits_available(),
            kill_tree: KillGuarantee::Cgroup,
            landlock_abi: crate::confine::landlock_abi(),
            launch_gate: crate::confine_host::locate_shim().is_some(),
        }
    }

    fn run(
        &self,
        spec: &SandboxSpec,
        control: &mut dyn SandboxControl,
    ) -> Result<SandboxOutcome, ToolError> {
        crate::sandbox::run_sandboxed(spec, control)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(fd: bool) -> BackendCaps {
        BackendCaps {
            id: "t",
            fs_scopes: if fd {
                vec![FsScope::Scratch, FsScope::Workspace]
            } else {
                vec![FsScope::Scratch]
            },
            net_scopes: vec![NetScope::Offline, NetScope::Install, NetScope::Controlled],
            pinned_root_mount: fd,
            subpath_readonly: fd,
            hide_existing_entries: fd,
            kernel_resource_limits: true,
            kill_tree: KillGuarantee::Cgroup,
            landlock_abi: Some(7),
            launch_gate: true,
        }
    }

    #[test]
    fn scratch_needs_nothing_and_workspace_needs_every_pinned_capability() {
        let scratch = ExecGrant::default();
        assert!(check_grant(&caps(false), &scratch).is_ok());
        let ws = ExecGrant {
            fs: FsScope::Workspace,
            ..Default::default()
        };
        assert!(check_grant(&caps(true), &ws).is_ok());
        let e = check_grant(&caps(false), &ws).unwrap_err();
        assert!(matches!(e, ExecRefusal::NotImplemented(_)), "{e:?}");
    }

    #[test]
    fn a_workspace_grant_needs_landlock_and_the_launch_gate_and_never_downgrades() {
        let ws = ExecGrant {
            fs: FsScope::Workspace,
            ..Default::default()
        };
        for (abi, gate) in [(None, true), (Some(2), true), (Some(7), false)] {
            let mut c = caps(true);
            c.landlock_abi = abi;
            c.launch_gate = gate;
            let e = check_grant(&c, &ws).unwrap_err();
            assert!(
                matches!(&e, ExecRefusal::BackendInsufficient(m) if m.iter().any(|x| x.contains("Landlock"))),
                "{abi:?} {gate}: {e:?}"
            );
        }
        // Scratch is unaffected by the absence of Landlock (legacy semantics)
        let mut c = caps(false);
        c.landlock_abi = None;
        c.launch_gate = false;
        assert!(check_grant(&c, &ExecGrant::default()).is_ok());
    }

    #[test]
    fn full_access_and_reserved_networks_are_refused_not_downgraded() {
        let full = ExecGrant {
            fs: FsScope::Full,
            ..Default::default()
        };
        assert!(matches!(
            check_grant(&caps(true), &full),
            Err(ExecRefusal::NotImplemented("Full Access"))
        ));
        let g = ExecGrant {
            net: NetScope::Full,
            ..Default::default()
        };
        assert!(check_grant(&caps(true), &g).is_err());
    }

    #[test]
    fn scope_names_round_trip_and_unknown_names_are_rejected() {
        for s in [FsScope::Scratch, FsScope::Workspace, FsScope::Full] {
            assert_eq!(FsScope::parse(s.as_str()), Some(s));
        }
        assert_eq!(FsScope::parse("host"), None);
        assert_eq!(FsScope::parse(""), None);
        assert_eq!(FsScope::default(), FsScope::Scratch);
    }
}
