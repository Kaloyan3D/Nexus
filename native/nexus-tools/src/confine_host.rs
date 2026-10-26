//! Host side of the launch gate (M3C): locating and vetting `nexus-confine`. Kept apart from `confine.rs`
//! so that the gate binary itself links nothing but libc.

/// Where the launch gate binary is: `NEXUS_CONFINE_BIN`, else next to the running executable (or, for test
/// binaries in `deps/`, one directory up).
pub fn locate_shim() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("NEXUS_CONFINE_BIN") {
        let p = std::path::PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for d in [Some(dir), dir.parent()].into_iter().flatten() {
        let c = d.join("nexus-confine");
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

/// The gate must be a regular file owned by this user and not writable by anyone else.
pub fn shim_is_trustworthy(p: &std::path::Path) -> Result<String, String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let md = std::fs::metadata(p).map_err(|e| format!("cannot stat the launch gate: {e}"))?;
    if !md.is_file() {
        return Err("the launch gate is not a regular file".into());
    }
    if md.uid() != unsafe { libc::geteuid() } && md.uid() != 0 {
        return Err("the launch gate is owned by another user".into());
    }
    if md.permissions().mode() & 0o022 != 0 {
        return Err("the launch gate is writable by group or others".into());
    }
    // The digest is cached per (path, size, mtime, inode): hashing a large debug binary on every launch is
    // slow, and any change to the file changes one of the four.
    type Key = (std::path::PathBuf, u64, i64, u64);
    static CACHE: std::sync::Mutex<Option<std::collections::HashMap<Key, String>>> =
        std::sync::Mutex::new(None);
    let key: Key = (
        p.to_path_buf(),
        md.len(),
        md.mtime_nsec() + md.mtime() * 1_000_000_000,
        md.ino(),
    );
    if let Ok(g) = CACHE.lock() {
        if let Some(v) = g.as_ref().and_then(|m| m.get(&key)) {
            return Ok(v.clone());
        }
    }
    // The exact compatible gate: it must speak this build's plan protocol (a stale binary left over from
    // another version is refused with a message that names both).
    let said = std::process::Command::new(p)
        .arg("--version")
        .env_clear()
        .output()
        .map_err(|e| format!("the launch gate cannot be executed: {e}"))?;
    let said = String::from_utf8_lossy(&said.stdout).trim().to_owned();
    if said != crate::confine::PROTOCOL {
        return Err(format!(
            "the launch gate at {} speaks {:?} but this Nexus needs {:?}; reinstall the matching nexus-confine next to nexusd",
            p.display(),
            said,
            crate::confine::PROTOCOL
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("cannot read the launch gate: {e}"))?;
    use sha2::Digest;
    let sha = hex::encode(sha2::Sha256::digest(&bytes));
    if let Ok(mut g) = CACHE.lock() {
        g.get_or_insert_with(Default::default)
            .insert(key, sha.clone());
    }
    Ok(sha)
}
