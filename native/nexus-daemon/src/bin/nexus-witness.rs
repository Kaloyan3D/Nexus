//! `nexus-witness`: independent journal witness service (A4.3).
//!
//! Runs as its OWN Linux identity. It holds a state directory and sealing
//! key the daemon UID cannot read or write, answers a narrow authenticated
//! protocol (status/query/commit/adopt), and has no authority over grants,
//! approvals or task outcomes.
//!
//! Usage:
//!   nexus-witness --dir STATE_DIR --socket PATH --allowed-uids UID[,UID]
//!                 [--socket-group GID] [--production] [--allow-same-uid-test-only]
//!   nexus-witness --dir STATE_DIR status        (offline, run as the witness UID)
//!
//! `NEXUS_WITNESS_FAULT=fail-persist|drop-ack|exit-after-persist|hang|fail-after:N|drop-ack-after:N` is a
//! TEST-ONLY fault injector (documented in A4.3-EVIDENCE.md).

use nexus_store::ext_witness::{Fault, WitnessCore};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn fatal(m: &str) -> i32 {
    eprintln!(
        "{}",
        serde_json::json!({"daemon": "nexus-witness", "event": "fatal", "message": m})
    );
    1
}

fn peer_uid(fd: i32) -> Option<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

fn verify_state_dir(p: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(p).map_err(|e| format!("state dir: {e}"))?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err("state dir must be a real directory".into());
    }
    if m.uid() != unsafe { libc::geteuid() } {
        return Err("state dir must be owned by the witness uid".into());
    }
    if m.mode() & 0o077 != 0 {
        return Err("state dir must have no group/other permissions (0700)".into());
    }
    Ok(())
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    unsafe { libc::umask(0o077) };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(dir) = arg(&args, "--dir").map(PathBuf::from) else {
        return fatal("--dir is required");
    };
    if let Err(e) = verify_state_dir(&dir) {
        return fatal(&e);
    }
    // Production: no test-only escape hatches may be armed.
    if args.iter().any(|a| a == "--production")
        && (std::env::var_os("NEXUS_WITNESS_FAULT").is_some()
            || args.iter().any(|a| a == "--allow-same-uid-test-only"))
    {
        return fatal("--production forbids NEXUS_WITNESS_FAULT and --allow-same-uid-test-only");
    }
    let mut core = match WitnessCore::open(&dir) {
        Ok(c) => c,
        Err(e) => return fatal(&e),
    };
    if args.iter().any(|a| a == "status") {
        let r = core.handle(&serde_json::json!({"v":1,"op":"status","nonce":"offline"}));
        println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
        return 0;
    }
    core.fault = match std::env::var("NEXUS_WITNESS_FAULT").ok().as_deref() {
        Some("fail-persist") => Some(Fault::FailPersist),
        Some("drop-ack") => Some(Fault::DropAckAfterPersist),
        Some("exit-after-persist") => Some(Fault::ExitAfterPersist),
        Some("hang") => Some(Fault::HangBeforePersist),
        Some(f) if f.starts_with("fail-after:") => {
            f[11..].parse().ok().map(Fault::FailPersistAfter)
        }
        Some(f) if f.starts_with("drop-ack-after:") => {
            f[15..].parse().ok().map(Fault::DropAckAfter)
        }
        _ => None,
    };
    let Some(socket) = arg(&args, "--socket").map(PathBuf::from) else {
        return fatal("--socket is required");
    };
    let allowed: Vec<u32> = arg(&args, "--allowed-uids")
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if allowed.is_empty() {
        return fatal("--allowed-uids is required (the daemon uid)");
    }
    let euid = unsafe { libc::geteuid() };
    if allowed.contains(&euid) && !args.iter().any(|a| a == "--allow-same-uid-test-only") {
        return fatal(
            "witness uid must differ from the daemon uid (--allow-same-uid-test-only is for single-UID tests and provides no isolation)",
        );
    }
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => return fatal(&format!("bind: {e}")),
    };
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(gid) = arg(&args, "--socket-group").and_then(|g| g.parse::<u32>().ok()) {
            use std::os::unix::ffi::OsStrExt;
            let c = std::ffi::CString::new(socket.as_os_str().as_bytes()).unwrap();
            if unsafe { libc::chown(c.as_ptr(), u32::MAX, gid) } != 0 {
                return fatal("cannot set socket group");
            }
            let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o660));
        } else {
            let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
        }
    }
    println!(
        "{}",
        serde_json::json!({"daemon":"nexus-witness","event":"ready","uid":euid})
    );
    let _ = std::io::stdout().flush();
    // Sequential accept loop: serialization is the concurrency control.
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .ok();
        let uid = peer_uid(stream.as_raw_fd());
        let mut line = String::new();
        let mut reader = BufReader::new(&stream);
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let reply = match uid {
            Some(u) if allowed.contains(&u) => {
                match serde_json::from_str::<serde_json::Value>(line.trim()) {
                    Ok(v) => core.handle(&v),
                    Err(_) => {
                        serde_json::json!({"ok":false,"code":"bad-request","message":"unparsable","nonce":""})
                    }
                }
            }
            _ => {
                serde_json::json!({"ok":false,"code":"peer-unauthorized","message":"uid is not an authorized committer","nonce":""})
            }
        };
        if reply.get("dropAck").is_some() {
            continue; // injected lost acknowledgement
        }
        let mut w = &stream;
        let _ = w.write_all(format!("{reply}\n").as_bytes());
    }
    0
}
