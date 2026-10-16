//! Trust checks for what the issuer-identity broker is willing to execute.
//!
//! The broker spawns `node` on a bridge script with issuer authority. Both
//! must come from places only a trusted principal can change, and the
//! executable must not be found through an attacker-influenced search path.
//! None of this input is client-controlled (a client can only send intent
//! JSON); these checks defend the operator/deployment boundary.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

fn owner_ok(uid: u32, extra: &[u32]) -> bool {
    uid == 0 || uid == euid() || extra.contains(&uid)
}

/// `path` and every ancestor must be owned by root or the broker's euid and
/// not group/world-writable (a sticky directory such as /tmp is tolerated as
/// an ANCESTOR only, since entries inside it cannot be replaced by others).
pub fn check_path_chain(path: &Path, extra: &[u32]) -> Result<(), String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut cur: Option<&Path> = Some(real.as_path());
    let mut first = true;
    while let Some(p) = cur {
        let m = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
        if !owner_ok(m.uid(), extra) {
            return Err(format!("{} is owned by an untrusted uid", p.display()));
        }
        let writable_by_others = m.mode() & 0o022 != 0;
        let sticky_dir = m.is_dir() && m.mode() & 0o1000 != 0;
        if writable_by_others && (first || !sticky_dir) {
            return Err(format!("{} is group/world-writable", p.display()));
        }
        first = false;
        cur = p.parent();
    }
    Ok(())
}

/// Resolve `node` to an absolute path WITHOUT trusting a relative PATH entry
/// or an untrusted directory, and return it.
pub fn resolve_node(configured: &str, extra: &[u32]) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = if configured.contains('/') {
        vec![PathBuf::from(configured)]
    } else {
        std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .filter(|d| d.starts_with('/'))
            .map(|d| Path::new(d).join(configured))
            .collect()
    };
    for c in candidates {
        if let Ok(m) = std::fs::metadata(&c) {
            if m.is_file() && m.mode() & 0o111 != 0 {
                check_path_chain(&c, extra)
                    .map_err(|e| format!("node executable rejected: {e}"))?;
                return std::fs::canonicalize(&c).map_err(|e| e.to_string());
            }
        }
    }
    Err(format!(
        "node executable '{configured}' was not found in an absolute PATH entry"
    ))
}

/// The bridge script and its module directory must be trusted code.
pub fn check_bridge(bridge: &Path, extra: &[u32]) -> Result<(), String> {
    check_path_chain(bridge, extra).map_err(|e| format!("Controller bridge rejected: {e}"))?;
    if let Some(dir) = bridge.parent() {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x == "cjs").unwrap_or(false) {
                    let m = std::fs::metadata(&p).map_err(|e| e.to_string())?;
                    if !owner_ok(m.uid(), extra) || m.mode() & 0o022 != 0 {
                        return Err(format!(
                            "Controller module {} is untrusted (owner or group/world-writable)",
                            p.display()
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}
