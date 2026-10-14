//! Issuer authorization for daemon mutations (A1.3.3).
//!
//! Security model (explicit, tested, documented as limited):
//!
//! - The daemon NEVER treats issuer strings, caller-supplied hashes, or
//!   well-formed resolutions as authorization. `seal`/`accept` additionally
//!   require a per-request authentication tag.
//! - In the default `readonly` trust mode, privileged commands
//!   (`acquire`, `seal`, `accept`) are unconditionally refused with
//!   `privileged-disabled`: no credential can enable them.
//! - In the explicit `shadow-test` trust mode, the daemon generates one
//!   random 256-bit capability key at startup, stores it 0600 at the
//!   configured cap path, and requires every privileged request to carry
//!   `auth: { nonce, ts, tag }` where
//!   `tag = HMAC-SHA256(capkey, canonical({protocol,id,cmd,params,nonce,ts}))`
//!   with canonical bytes shared with the JS transport, a fresh 128-bit
//!   nonce per request, and `ts` (unix millis) inside a +/-5 minute window.
//!   Reused nonces are rejected (`replay-rejected`). Comparison is
//!   constant-time.
//! - HONEST LIMITATION (same-UID hostile peer): the capability file is
//!   readable by any process running as the daemon's UID, and `SO_PEERCRED`
//!   cannot distinguish which JS module produced a request. A hostile
//!   same-UID process that reads the cap file CAN impersonate the trusted
//!   issuer over this socket. Socket permissions do not fix this. The
//!   supported deployment boundary is therefore: single-tenant development
//!   / test machines with no hostile same-UID peer. Production use needs
//!   separate service identities (distinct UIDs + a protected store or an
//!   external trust anchor) and is explicitly NOT claimed here. A dedicated
//!   test proves the impersonation and pins this documentation.
//! - This is deliberately NOT a static shared string: the key is random
//!   per daemon incarnation, rotated on every restart, never logged, never
//!   returned in responses, and bound to each request's full bytes plus a
//!   single-use nonce.
//!
//! Replay-cache policy (H-06): every admitted nonce is remembered WITH its
//! request timestamp. Entries are removed ONLY after their validity window
//! has expired (request ts older than now minus the acceptance window).
//! When the bounded cache is full of still-valid entries, the daemon fails
//! closed with `replay-cache-exhausted` rather than evicting a live nonce
//! and silently re-admitting its replay. Availability is never bought by
//! weakening replay protection.
//!
//! Restart behavior: the cache lives in process memory only, and every
//! daemon start generates a fresh capability key (the cap file is
//! overwritten). Pre-restart tags fail HMAC verification post-restart, so
//! there is no cross-restart replay window to protect: a restarted daemon
//! starts with an empty cache and a new key, which is safe precisely
//! because the key rotated.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

/// Timestamp acceptance window (unix millis, +/- skew + transit).
pub const AUTH_WINDOW_MS: i64 = 5 * 60 * 1000;
/// Bounded replay cache: at most this many still-valid nonces are
/// remembered. Exhaustion fails closed; see the module policy above.
pub const MAX_SEEN_NONCES: usize = 10_000;

pub struct IssuerAuth {
    key: [u8; 32],
    seen: Mutex<NonceCache>,
}

/// Admitted nonces mapped to their request timestamps. Timestamps make
/// expiry exact: a nonce is forgotten only after it can no longer verify.
struct NonceCache {
    by_nonce: HashMap<String, i64>,
}

impl IssuerAuth {
    pub fn generate() -> Result<Self, String> {
        let mut key = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut key))
            .map_err(|e| format!("entropy unavailable: {e}"))?;
        Ok(Self {
            key,
            seen: Mutex::new(NonceCache {
                by_nonce: HashMap::new(),
            }),
        })
    }

    pub fn key_hex(&self) -> String {
        hex::encode(self.key)
    }

    /// Canonical bytes the tag covers. MUST match the JS transport
    /// (`native-shadow-daemon.cjs` `authBytesOf`) field-for-field; the
    /// cross-language agreement is pinned by integration test.
    pub fn auth_bytes(
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        nonce: &str,
        ts: i64,
    ) -> String {
        let mut envelope = serde_json::Map::new();
        envelope.insert("cmd".to_owned(), serde_json::Value::String(cmd.to_owned()));
        envelope.insert("id".to_owned(), serde_json::Value::String(id.to_owned()));
        envelope.insert(
            "nonce".to_owned(),
            serde_json::Value::String(nonce.to_owned()),
        );
        envelope.insert(
            "params".to_owned(),
            serde_json::Value::Object(params.clone()),
        );
        envelope.insert(
            "protocol".to_owned(),
            serde_json::Value::from(crate::protocol::IPC_PROTOCOL_VERSION),
        );
        envelope.insert("ts".to_owned(), serde_json::Value::from(ts));
        nexus_contracts::canonical_json(&serde_json::Value::Object(envelope))
    }

    pub fn tag_for(
        &self,
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        nonce: &str,
        ts: i64,
    ) -> String {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&self.key)
            .expect("HMAC accepts 32-byte keys");
        mac.update(Self::auth_bytes(cmd, id, params, nonce, ts).as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Verify one privileged request's auth fields. Ok(()) admits the
    /// request; Err(code) names the refusal (`issuer-untrusted`,
    /// `replay-rejected`, or `replay-cache-exhausted`). Nonce reservation
    /// happens here so concurrent duplicates cannot both pass.
    pub fn verify(
        &self,
        cmd: &str,
        id: &str,
        params: &serde_json::Map<String, serde_json::Value>,
        auth: &crate::protocol::AuthFields,
        now_ms: i64,
    ) -> Result<(), &'static str> {
        if auth.nonce.len() > 128 || !is_hex(&auth.nonce) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        if auth.tag.len() > 256 || !is_hex(&auth.tag) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        if (now_ms - auth.ts).abs() > AUTH_WINDOW_MS {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        let expected = self.tag_for(cmd, id, params, &auth.nonce, auth.ts);
        if !constant_time_eq(&expected, &auth.tag) {
            return Err(crate::protocol::codes::ISSUER_UNTRUSTED);
        }
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| crate::protocol::codes::ISSUER_UNTRUSTED)?;
        // Any repeat of a remembered nonce is a replay, whatever its age:
        // requests older than the window already failed the ts check above,
        // so a remembered match is always a live replay.
        if seen.by_nonce.contains_key(&auth.nonce) {
            return Err(crate::protocol::codes::REPLAY_REJECTED);
        }
        // Expire first: forget only nonces that can no longer verify, so
        // memory stays bounded without ever dropping live protection.
        seen.by_nonce.retain(|_, ts| now_ms - *ts <= AUTH_WINDOW_MS);
        // Still full of live nonces: fail closed. Evicting one would let
        // its replay verify as fresh inside the validity window.
        if seen.by_nonce.len() >= MAX_SEEN_NONCES {
            return Err(crate::protocol::codes::REPLAY_CACHE_EXHAUSTED);
        }
        seen.by_nonce.insert(auth.nonce.clone(), auth.ts);
        Ok(())
    }
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0 && !a.is_empty()
}

/// Write the capability key to `path` with owner-only (0600) permissions.
/// The parent directory is created if missing. Overwrites any previous key:
/// rotation happens on every daemon start.
pub fn write_cap_file(path: &Path, key_hex: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cap dir unavailable: {e}"))?;
        }
    }
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("cap file unwritable: {e}"))?;
    use std::io::Write;
    file.write_all(key_hex.as_bytes())
        .map_err(|e| format!("cap file unwritable: {e}"))?;
    // Harden against pre-existing permissive modes on rotation.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("cap file permissions unsettable: {e}"))?;
    Ok(())
}

/// Best-effort removal of stale `.<leaf>.tmp.*` siblings left by a crashed
/// rotation. Only regular files with the exact temp prefix are unlinked;
/// anything else (including symlinks) is left untouched for the caller to
/// refuse. Errors are ignored: the fresh temp uses a unique name and every
/// validation still fails closed.
fn scrub_stale_handoff_temps(dir: &Path, leaf: &str) {
    let prefix = format!(".{leaf}.tmp.");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) {
            continue;
        }
        // Never follow or remove a symlink: only a plain temp file.
        let is_plain = std::fs::symlink_metadata(entry.path())
            .map(|m| m.file_type().is_file())
            .unwrap_or(false);
        if is_plain {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write a group-readable copy of the capability key for the production
/// issuer identity (closure §3). The caller MUST place `path` inside the
/// validated shared socket directory (never inside the DataRoot) and pass
/// the socket directory's group: the handoff lands `0640 root-group` so the
/// `nexus-issuer` UID can authenticate without any read access to the
/// DataRoot or to the owner-only `issuer.cap`. Rotation matches the primary
/// cap (overwritten every start). Publication is via a validated `O_EXCL`
/// temp inode plus atomic rename (A2.2): secret bytes never enter an
/// unvalidated inode, pre-existing permissive files are replaced rather than
/// truncated, hardlinks keep only stale bytes, and `O_NOFOLLOW` refuses
/// symlink targets so a pre-planted link can never redirect the key. This is NOT a second
/// credential: it carries the same per-incarnation key, and a stolen copy is
/// still insufficient without a matching `--allowed-uids` peer UID.
///
/// Fail-closed: any ownership, group, mode, or symlink violation is an
/// error and the daemon must refuse to start.
pub fn write_handoff_file(path: &Path, key_hex: &str, gid: u32) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    // No parent creation here: the directory must already exist and have
    // passed socket-dir validation. Creating it would mask operator error.
    if path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .is_none()
    {
        return Err(
            "cap handoff path has no parent directory; place it inside the shared socket directory"
                .to_owned(),
        );
    }
    // A2.2 review fix: NEVER place secret bytes into an unvalidated inode.
    // The previous implementation opened the destination itself with O_TRUNC
    // and wrote the key before ownership/type/permission validation, so a
    // pre-existing permissive file briefly carried the new key world-readable
    // and a pre-existing hardlink shared the new bytes permanently. This
    // implementation writes a fresh O_EXCL temp inode, validates the OPEN
    // description, then atomically renames over the destination: the old
    // inode (and any hardlink to it) keeps only stale bytes, never the new
    // key. Symlinks and nonregular files are refused before any write.
    if key_hex.len() != 64 || !is_hex(key_hex) {
        return Err("cap handoff key material is malformed; refusing to write".to_owned());
    }
    // Refuse symlink leaves before any write: a link could otherwise
    // point the key at an attacker-readable path.
    let leaf_meta = std::fs::symlink_metadata(path).ok();
    if leaf_meta
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("cap handoff path is a symlink; refusing to write key material".to_owned());
    }
    // Refuse pre-existing nonregular leaves (fifo, socket, directory, ...):
    // opening one O_WRONLY could block (fifo) or misdirect the key. A
    // missing leaf is fine (fresh inode below); a regular file is fine (it
    // is replaced by rename, never truncated in place).
    if let Some(ref m) = leaf_meta {
        if !m.file_type().is_file() {
            return Err(
                "cap handoff path is not a regular file; refusing to write key material".to_owned(),
            );
        }
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            "cap handoff path has no parent directory; place it inside the shared socket directory"
                .to_owned()
        })?
        .to_path_buf();
    let leaf = path
        .file_name()
        .ok_or_else(|| {
            "cap handoff path has no file name; place it inside the shared socket directory"
                .to_owned()
        })?
        .to_owned();
    let leaf_str = leaf.to_string_lossy().into_owned();
    // Crash-rotation hygiene: a previous incarnation may have left a
    // `.<leaf>.tmp.*` sibling carrying key bytes. Remove stale ones
    // best-effort BEFORE publishing; the fresh temp below uses a unique
    // name, and every validation below still fails closed on error.
    scrub_stale_handoff_temps(&parent, &leaf_str);
    // Unique temp sibling in the SAME directory (rename stays on one
    // filesystem and inherits the socket-dir policy). Dot-prefixed so a
    // crashed rotation never looks like a published handoff.
    let pid = unsafe { libc::getpid() };
    let mut rnd = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut rnd)
        })
        .map_err(|_| "cap handoff entropy unavailable; refusing to write".to_owned())?;
    let tmp_name = format!(".{}.tmp.{}-{}", leaf_str, pid, hex::encode(rnd));
    let tmp_path = parent.join(&tmp_name);
    let c_tmp = std::ffi::CString::new(tmp_path.as_os_str().as_bytes())
        .map_err(|_| "cap handoff path contains interior NUL".to_owned())?;
    // O_EXCL|O_NOFOLLOW: never truncate, never follow, never reuse an inode.
    // Mode 0600 first (narrowest); widened to exactly 0640 after chown.
    // Raw fd avoids any TOCTOU between a check and std's open.
    let fd = unsafe {
        libc::open(
            c_tmp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "cap handoff unwritable: {}",
            std::io::Error::last_os_error()
        ));
    }
    let unlink_tmp = || unsafe { libc::unlink(c_tmp.as_ptr()) };
    // Group ownership FIRST (while still 0600-or-narrower), then enforce
    // exact bits: at no point is the key group/other-accessible beyond 0640.
    let grp = unsafe { libc::fchown(fd, u32::MAX, gid) };
    let md = unsafe { libc::fchmod(fd, 0o640) };
    // Review F3 + A2.2: validate the OPEN file description (fstat), never a
    // re-resolved pathname, BEFORE any secret byte enters the inode.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let fr = unsafe { libc::fstat(fd, &mut st) };
    let euid = unsafe { libc::geteuid() };
    let pre_ok = fr == 0
        && grp == 0
        && md == 0
        && (st.st_mode & libc::S_IFMT) == libc::S_IFREG
        && st.st_uid == euid
        && st.st_gid == gid
        && st.st_mode & 0o777 == 0o640
        && st.st_nlink == 1;
    if !pre_ok {
        unsafe {
            libc::close(fd);
        }
        unlink_tmp();
        if grp != 0 {
            return Err("cap handoff group unsettable; is the daemon a member of the socket group? (failing closed)".to_owned());
        }
        return Err(
            "cap handoff temp inode failed validation; refusing to publish (failing closed)"
                .to_owned(),
        );
    }
    // Only now do secret bytes enter the validated inode.
    let write_all = unsafe {
        let bytes = key_hex.as_bytes();
        let mut done = 0usize;
        while done < bytes.len() {
            let rc = libc::write(
                fd,
                bytes[done..].as_ptr() as *const libc::c_void,
                bytes.len() - done,
            ) as isize;
            if rc <= 0 {
                break;
            }
            done += rc as usize;
        }
        if done == bytes.len() {
            0
        } else {
            -1
        }
    };
    let sync_rc = unsafe { libc::fsync(fd) };
    let mut st2: libc::stat = unsafe { std::mem::zeroed() };
    let fr2 = unsafe { libc::fstat(fd, &mut st2) };
    unsafe {
        libc::close(fd);
    }
    if write_all != 0 || sync_rc != 0 || fr2 != 0 || st2.st_size != key_hex.len() as i64 {
        unlink_tmp();
        return Err(
            "cap handoff unwritable: temp write did not settle (failing closed)".to_owned(),
        );
    }
    // Atomic publication: rename replaces the destination directory entry
    // WITHOUT ever truncating the old inode. A pre-existing hardlink keeps
    // the OLD bytes; a concurrently planted symlink is REPLACED (rename does
    // not follow the destination), and the post-rename checks below refuse
    // anything that is not a daemon-owned 0640 regular file.
    let c_dst = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        unlink_tmp();
        "cap handoff path contains interior NUL".to_owned()
    })?;
    if unsafe { libc::rename(c_tmp.as_ptr(), c_dst.as_ptr()) } != 0 {
        let e = std::io::Error::last_os_error().to_string();
        unlink_tmp();
        return Err(format!("cap handoff unpublished: {e}"));
    }
    // Validate the published leaf: lstat must show a non-symlink, and the
    // settled metadata must show a regular 0640 daemon-owned group file of
    // exactly the key length with a single link.
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            unsafe {
                libc::unlink(c_dst.as_ptr());
            }
            return Err("cap handoff settled as a symlink (failing closed)".to_owned());
        }
        Ok(_) => {}
        Err(e) => {
            return Err(format!("cap handoff unverifiable after publish: {e}"));
        }
    }
    match std::fs::metadata(path) {
        Ok(m) => {
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            let mode = m.permissions().mode() & 0o777;
            if !m.file_type().is_file()
                || m.uid() != euid
                || m.gid() != gid
                || mode != 0o640
                || m.nlink() != 1
                || m.len() != key_hex.len() as u64
            {
                unsafe {
                    libc::unlink(c_dst.as_ptr());
                }
                return Err(
                    "cap handoff settled with wrong ownership, mode, or linkage (failing closed)"
                        .to_owned(),
                );
            }
        }
        Err(e) => {
            return Err(format!("cap handoff unverifiable after publish: {e}"));
        }
    }
    // Best-effort directory fsync so the rename survives a crash; failure
    // does not weaken the file-content guarantees above.
    if let Ok(dfd_c) = std::ffi::CString::new(parent.as_os_str().as_bytes()) {
        unsafe {
            let dfd = libc::open(dfd_c.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
            if dfd >= 0 {
                libc::fsync(dfd);
                libc::close(dfd);
            }
        }
    }
    // Final hygiene: no temp siblings may linger carrying key bytes.
    scrub_stale_handoff_temps(&parent, &leaf_str);
    Ok(())
}

pub fn read_cap_file(path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cap file unreadable: {e}"))?;
    let trimmed = text.trim().to_owned();
    if trimmed.len() != 64 || !is_hex(&trimmed) {
        return Err("cap file is malformed".to_owned());
    }
    Ok(trimmed)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_verify() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "ab".repeat(16);
        let ts = now_ms();
        let tag = auth.tag_for("acquire", "id1", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields {
            nonce: nonce.clone(),
            ts,
            tag,
        };
        assert!(auth.verify("acquire", "id1", &params, &fields, ts).is_ok());
        // Same nonce replays are rejected.
        assert_eq!(
            auth.verify("acquire", "id1", &params, &fields, ts)
                .unwrap_err(),
            crate::protocol::codes::REPLAY_REJECTED
        );
    }

    #[test]
    fn stale_timestamp_refused() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "cd".repeat(16);
        let ts = now_ms() - AUTH_WINDOW_MS - 1000;
        let tag = auth.tag_for("seal", "id2", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields { nonce, ts, tag };
        assert_eq!(
            auth.verify("seal", "id2", &params, &fields, now_ms())
                .unwrap_err(),
            crate::protocol::codes::ISSUER_UNTRUSTED
        );
    }

    /// H-06: a still-valid nonce is never forgotten while it can verify.
    /// Failing-first: the pre-fix FIFO cache drops the oldest nonce after
    /// 10,000 admissions, so replaying it verifies as a fresh request.
    /// Specified fix (fail closed at capacity): the cache fills with live
    /// nonces, further fresh requests are refused with
    /// `replay-cache-exhausted`, and the oldest live replay stays rejected.
    #[test]
    fn replay_after_cache_eviction_is_still_rejected() {
        let auth = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let ts = now_ms();
        let first_nonce = "aa".repeat(16);
        let first_tag = auth.tag_for("acquire", "id-first", &params, &first_nonce, ts);
        let first = crate::protocol::AuthFields {
            nonce: first_nonce.clone(),
            ts,
            tag: first_tag,
        };
        assert!(auth
            .verify("acquire", "id-first", &params, &first, ts)
            .is_ok());
        // Fill the cache exactly to capacity with distinct valid nonces.
        for i in 1..(super::MAX_SEEN_NONCES as u64) {
            let nonce = format!("{:032x}{:032x}", i, ts as u64);
            let id = format!("fill-{i}");
            let tag = auth.tag_for("acquire", &id, &params, &nonce, ts);
            let fields = crate::protocol::AuthFields { nonce, ts, tag };
            assert!(auth.verify("acquire", &id, &params, &fields, ts).is_ok());
        }
        // One more fresh, otherwise-valid request: refused (fail closed)
        // rather than evicting a live nonce to make room.
        let extra_nonce = "bb".repeat(16);
        let extra_tag = auth.tag_for("acquire", "id-extra", &params, &extra_nonce, ts);
        let extra = crate::protocol::AuthFields {
            nonce: extra_nonce,
            ts,
            tag: extra_tag,
        };
        assert_eq!(
            auth.verify("acquire", "id-extra", &params, &extra, ts)
                .unwrap_err(),
            crate::protocol::codes::REPLAY_CACHE_EXHAUSTED
        );
        // The oldest nonce is still inside its validity window, so its
        // replay must be rejected — never silently re-admitted.
        assert_eq!(
            auth.verify("acquire", "id-first", &params, &first, now_ms())
                .unwrap_err(),
            crate::protocol::codes::REPLAY_REJECTED
        );
    }

    #[test]
    fn handoff_file_is_group_scoped_and_symlink_safe() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let gid = unsafe { libc::getegid() };
        let path = dir.path().join("issuer.handoff");
        write_handoff_file(&path, &"ab".repeat(32), gid).expect("handoff writes");
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "handoff must be 0640, got {mode:o}");
        assert_eq!(std::fs::read_to_string(&path).expect("read").len(), 64);
        // A pre-planted symlink at the handoff path is refused, never followed.
        let link = dir.path().join("link.handoff");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        assert!(write_handoff_file(&link, &"cd".repeat(32), gid).is_err());
        // The refused write leaves the real file untouched.
        assert_eq!(std::fs::read_to_string(&path).expect("read").len(), 64);
    }

    /// A2.2 review finding, failing-first: the pre-fix implementation opened
    /// the destination with O_TRUNC and wrote the new key before validation,
    /// so a pre-existing permissive file briefly carried the new key and a
    /// hardlink to it shared the new bytes permanently. Post-fix, rotation
    /// publishes a fresh inode via rename: the old inode (and its hardlink)
    /// keeps only stale bytes, and the new leaf is a fresh 0640 inode.
    #[test]
    fn handoff_rotation_never_exposes_new_key_via_hardlink() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().expect("tempdir");
        let gid = unsafe { libc::getegid() };
        let path = dir.path().join("issuer.handoff");
        // Pre-existing permissive file with stale marker bytes.
        std::fs::write(&path, "00".repeat(32)).expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        let alias = dir.path().join("alias.handoff");
        std::fs::hard_link(&path, &alias).expect("hardlink");
        let new_key = "ab".repeat(32);
        write_handoff_file(&path, &new_key, gid).expect("rotation writes");
        // Published leaf carries the new key on a FRESH inode, exactly 0640.
        assert_eq!(std::fs::read_to_string(&path).expect("read"), new_key);
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "rotated handoff must be 0640, got {mode:o}");
        // The pre-existing hardlink still reads the STALE bytes: the new key
        // never entered the old inode.
        assert_eq!(
            std::fs::read_to_string(&alias).expect("read"),
            "00".repeat(32)
        );
        // Distinct inodes prove replacement-by-rename, not truncation.
        let fresh = std::fs::metadata(&path).expect("stat");
        let stale = std::fs::metadata(&alias).expect("stat");
        assert_ne!((fresh.dev(), fresh.ino()), (stale.dev(), stale.ino()));
        assert_eq!(fresh.nlink(), 1);
        // Rotation is repeatable over the published leaf.
        let next_key = "cd".repeat(32);
        write_handoff_file(&path, &next_key, gid).expect("second rotation");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), next_key);
        assert_eq!(
            std::fs::read_to_string(&alias).expect("read"),
            "00".repeat(32)
        );
    }

    /// Nonregular leaves (fifo, directory) are refused before any byte is
    /// written, and no temp siblings linger carrying key bytes.
    #[test]
    fn handoff_refuses_nonregular_leaf_and_leaves_no_temps() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let gid = unsafe { libc::getegid() };
        let fifo = dir.path().join("issuer.handoff");
        assert_eq!(
            unsafe {
                libc::mkfifo(
                    std::ffi::CString::new(fifo.as_os_str().as_bytes())
                        .expect("nul")
                        .as_ptr(),
                    0o644,
                )
            },
            0,
            "mkfifo"
        );
        assert!(write_handoff_file(&fifo, &"ab".repeat(32), gid).is_err());
        assert!(
            std::fs::read_dir(dir.path())
                .expect("readdir")
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().contains(".tmp.")),
            "no temp file may linger after refusal"
        );
        let sub = dir.path().join("subdir.handoff");
        std::fs::create_dir(&sub).expect("mkdir");
        assert!(write_handoff_file(&sub, &"ab".repeat(32), gid).is_err());
    }

    /// A crashed rotation's stale temp sibling is scrubbed and never
    /// mistaken for the published handoff.
    #[test]
    fn handoff_scrubs_stale_temps_on_rotation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gid = unsafe { libc::getegid() };
        let path = dir.path().join("issuer.handoff");
        std::fs::write(
            dir.path().join(".issuer.handoff.tmp.999-deadbeef"),
            "ff".repeat(32),
        )
        .expect("stale temp");
        write_handoff_file(&path, &"ab".repeat(32), gid).expect("rotation writes");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "ab".repeat(32)
        );
        assert!(
            std::fs::read_dir(dir.path())
                .expect("readdir")
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().contains(".tmp.")),
            "stale temps must be scrubbed"
        );
    }

    #[test]
    fn wrong_key_refused() {
        let a = IssuerAuth::generate().unwrap();
        let b = IssuerAuth::generate().unwrap();
        let params = serde_json::Map::new();
        let nonce = "ef".repeat(16);
        let ts = now_ms();
        let tag = a.tag_for("accept", "id3", &params, &nonce, ts);
        let fields = crate::protocol::AuthFields { nonce, ts, tag };
        assert_eq!(
            b.verify("accept", "id3", &params, &fields, ts).unwrap_err(),
            crate::protocol::codes::ISSUER_UNTRUSTED
        );
    }
}
