//! Starting, watching and stopping the egress service of one execution (M5, host side).
//!
//! The service runs outside the command's sandbox but inside a sandbox of its own: no project, no
//! credentials, no checkpoints, no Nexus data - only its socket directory, the name-resolution files and the
//! network. It is started from the execution's frozen grant, must be ready before the command starts (or the
//! command is refused), and ends with the command.

use crate::egress::{
    EgressConfig, EgressLimits, AUDIT_NAME, CONFIG_NAME, READY_NAME, SOCKET_NAME, STOP_NAME,
};
use crate::netpolicy::NetPolicy;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct EgressRun {
    child: Option<Child>,
    dir: PathBuf,
    pub policy_digest: String,
    /// Set when the service was ended on purpose before the command finished (narrowing, revocation).
    pub ended_early: Option<String>,
}

/// Operator knobs for the service (daemon configuration; no tool argument reaches them).
#[derive(Debug, Clone, Default)]
pub struct EgressSettings {
    pub bin: Option<PathBuf>,
    pub limits: EgressLimits,
    /// Test hooks, refused by the production profile (see `EgressConfig`).
    pub test_resolve: std::collections::BTreeMap<String, String>,
    pub test_connect: std::collections::BTreeMap<String, String>,
}

pub fn start(
    settings: &EgressSettings,
    run_dir: &Path,
    np: &NetPolicy,
) -> Result<EgressRun, String> {
    let bin = settings
        .bin
        .clone()
        .or_else(crate::confine_host::locate_egress)
        .ok_or("the egress service (nexus-egress) was not found next to nexusd; Controlled Internet is unavailable and nothing was run")?;
    crate::confine_host::egress_is_trustworthy(&bin)
        .map_err(|e| format!("{e}; Controlled Internet is unavailable and nothing was run"))?;
    let digest = np.digest();
    let dir = run_dir.join("egress");
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("cannot prepare the egress directory: {e}"))?;
    }
    let cfg = EgressConfig {
        policy: np.canonical(),
        policy_digest: digest.clone(),
        limits: settings.limits.clone(),
        test_resolve: settings.test_resolve.clone(),
        test_connect: settings.test_connect.clone(),
    };
    std::fs::write(
        dir.join(CONFIG_NAME),
        serde_json::to_vec(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("cannot write the egress policy: {e}"))?;
    let filter = crate::sandbox::seccomp_filter_fd().map_err(|e| e.message)?;
    use std::os::fd::AsRawFd;
    let filter_raw = filter.as_raw_fd();
    let mut a: Vec<String> = vec![
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--seccomp",
        "3",
        "--ro-bind",
        "/usr",
        "/usr",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for (l1, l2) in [
        ("usr/bin", "/bin"),
        ("usr/sbin", "/sbin"),
        ("usr/lib", "/lib"),
        ("usr/lib64", "/lib64"),
    ] {
        a.extend(["--symlink".into(), l1.into(), l2.into()]);
    }
    a.extend([
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--tmpfs".into(),
        "/tmp".into(),
    ]);
    // name resolution only - no certificate stores, no home, no project
    for f in ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"] {
        if Path::new(f).exists() {
            a.extend(["--ro-bind".into(), f.into(), f.into()]);
        }
    }
    a.extend([
        "--bind".into(),
        dir.to_string_lossy().into_owned(),
        "/egress".into(),
    ]);
    a.extend([
        "--ro-bind".into(),
        bin.to_string_lossy().into_owned(),
        "/nexus/egress".into(),
    ]);
    a.extend([
        "--remount-ro".into(),
        "/".into(),
        "--chdir".into(),
        "/egress".into(),
        "--".into(),
        "/nexus/egress".into(),
        "--dir".into(),
        "/egress".into(),
    ]);
    let err = std::fs::File::create(run_dir.join("egress.stderr")).map_err(|e| e.to_string())?;
    let mut c = Command::new("/usr/bin/bwrap");
    c.args(&a)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err));
    use std::os::unix::process::CommandExt;
    unsafe {
        c.pre_exec(move || {
            if filter_raw != 3 && libc::dup2(filter_raw, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32);
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            );
            Ok(())
        });
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("cannot start the egress service: {e}"))?;
    drop(filter);
    let until = Instant::now() + Duration::from_secs(6);
    loop {
        if dir.join(READY_NAME).exists() && dir.join(SOCKET_NAME).exists() {
            break;
        }
        if let Ok(Some(st)) = child.try_wait() {
            let said = std::fs::read_to_string(run_dir.join("egress.stderr")).unwrap_or_default();
            return Err(format!("the egress service exited at start ({st}): {}; Controlled Internet is unavailable and nothing was run", crate::sandbox::sanitize_diagnostic(said.as_bytes())));
        }
        if Instant::now() > until {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the egress service did not become ready; Controlled Internet is unavailable and nothing was run".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(EgressRun {
        child: Some(child),
        dir,
        policy_digest: digest,
        ended_early: None,
    })
}

impl EgressRun {
    pub fn socket(&self) -> PathBuf {
        self.dir.join(SOCKET_NAME)
    }

    /// Has the service died on its own?
    pub fn is_dead(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => true,
        }
    }

    /// End the service NOW (permissions narrowed or revoked): every connection is cut, new ones fail.
    pub fn kill_now(&mut self, why: &str) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            self.ended_early = Some(why.to_owned());
        }
    }

    /// End it at the end of the command: ask it to write its closing records, then make sure it is gone.
    /// Returns the audit summary (destinations, ports, byte counts, denied names - nothing else).
    pub fn finish(&mut self) -> serde_json::Value {
        if let Some(mut c) = self.child.take() {
            let _ = std::fs::write(self.dir.join(STOP_NAME), b"1");
            let until = Instant::now() + Duration::from_millis(900);
            while Instant::now() < until {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
        let audit = std::fs::read_to_string(self.dir.join(AUDIT_NAME)).unwrap_or_default();
        let mut v = crate::egress::summarize(&audit);
        v["policyDigest"] = self.policy_digest.clone().into();
        v["endedEarly"] = self
            .ended_early
            .clone()
            .map(Into::into)
            .unwrap_or(serde_json::Value::Null);
        v["note"] = NOTE.into();
        v
    }
}

pub const NOTE: &str = "Controlled Internet restricts WHERE a command can connect; it does not inspect encrypted content and is not a data-loss-prevention boundary: anything the command can read can be sent to a destination the user allowed.";

impl Drop for EgressRun {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
