//! `nexusd` executable: persistent daemon hosting the Nexus Native Kernel.
//!
//! Foreground-only by design (suitable for testing and process
//! supervision): there is deliberately no desktop service manager, no
//! daemonization fork, no model/tool runtime, no dispatch, no network, and
//! no exec capability. Startup prints one JSON `ready` line on stdout once
//! the socket is bound, the store is open, and the daemon owns its DataRoot.
//!
//! Usage:
//!   nexusd --db PATH --socket PATH [--witness PATH]
//!          [--trust-mode readonly|shadow-test] [--cap PATH]
//!
//! Signals: SIGTERM/SIGINT stop accepting, drain in-flight requests
//! (bounded), remove the socket file, and exit 0.

use nexus_daemon::auth::{read_cap_file, write_cap_file, write_handoff_file};
use nexus_daemon::protocol::codes;
use nexus_daemon::server::{
    log_line, parse_allowed_uids, parse_socket_group, secure_socket_file, serve,
    verify_protected_dir, verify_socket_dir, Daemon, Lifecycle, TrustMode,
};
use nexus_daemon::DaemonLayout;
use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

extern "C" fn handle_signal(_: libc::c_int) {
    // Async-signal-safe: only an atomic store. The accept loop polls this.
    SHUTDOWN.store(true, Ordering::Relaxed);
}

fn install_signal_handlers() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handle_signal as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = 0;
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
    }
}

fn usage() -> i32 {
    println!("nexusd 0.1.0 (A1.3 persistent daemon, IPC protocol 1, shadow-only)");
    println!("usage:");
    println!("  nexusd --db PATH --socket PATH [--witness PATH]");
    println!("         [--trust-mode readonly|shadow-test] [--cap PATH]");
    println!("         [--allowed-uids UID[,UID...]] [--socket-group GID|NAME]");
    println!("         [--workspace-bases DIR[,DIR...]]");
    println!("         [--enable-writes --approver-cap PATH --approver-uids UID[,UID...]");
    println!("          [--require-independent-approver] [--approver-cap-gid GID]");
    println!("          [--allow-nonindependent-approver-test-only]]");
    println!("         [--cap-handoff PATH]");
    println!("Trust modes: readonly (default, privileged mutations disabled) |");
    println!("  shadow-test (explicit opt-in, per-request issuer authentication).");
    println!("--allowed-uids gates privileged commands by peer UID (SO_PEERCRED);");
    println!("  without it, same-UID peers can use a stolen capability (BLOCKED).");
    println!("--socket-group selects production socket sharing: socket dir must be");
    println!("  0750 owned by the daemon uid + that group (explicit opt-in, requires");
    println!("  --allowed-uids); the socket node is set 0660 so only the group connects.");
    println!("--cap-handoff writes a 0640 group-readable capability copy inside the");
    println!("  shared socket dir (requires --socket-group + shadow-test); the issuer");
    println!("  UID authenticates with zero read access to the DataRoot.");
    println!("A1.3 performs no external effects; dispatch is disabled.");
    0
}

fn flag(args: &[String], name: &str) -> Option<PathBuf> {
    let mut it = args.iter().peekable();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(PathBuf::from);
        }
    }
    None
}

fn flag_str(args: &[String], name: &str) -> Option<String> {
    let mut it = args.iter().peekable();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
    }
    None
}

fn workspace_bases_nonempty(args: &[String]) -> bool {
    flag_str(args, "--workspace-bases")
        .map(|v| v.split(',').any(|p| !p.is_empty()))
        .unwrap_or(false)
}

fn log_line_startup(msg: &str) {
    eprintln!(
        "{}",
        serde_json::json!({"daemon": "nexusd", "event": "startup", "detail": msg})
    );
}

fn fatal(code: &str, message: &str) -> i32 {
    let line = serde_json::json!({
        "daemon": "nexusd",
        "event": "fatal",
        "code": code,
        "message": message.chars().take(300).collect::<String>(),
    });
    eprintln!("{line}");
    1
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    if cmd == "help" || cmd == "--help" || cmd == "-h" {
        std::process::exit(usage());
    }
    // Bare invocation (no subcommand): flags only.
    let code = run(&args);
    std::process::exit(code);
}

fn run(args: &[String]) -> i32 {
    let db = match flag(args, "--db") {
        Some(p) => p,
        None => {
            eprintln!("--db is required");
            return 2;
        }
    };
    let socket_path = match flag(args, "--socket") {
        Some(p) => p,
        None => {
            eprintln!("--socket is required");
            return 2;
        }
    };
    // A2.1: restrictive creation mask FIRST, so every file this process
    // creates (SQLite store/WAL, cap file, socket) is owner-only even if a
    // later chmod is missed. 0077 removes all group/other bits.
    unsafe {
        libc::umask(0o077);
    }
    let witness = flag(args, "--witness");
    let cap_flag = flag(args, "--cap");
    // Closure §2: explicitly selected production socket sharing. Absence
    // preserves the A2.1 owner-only socket policy byte-for-byte.
    let socket_group = match flag_str(args, "--socket-group") {
        Some(spec) => match parse_socket_group(&spec) {
            Ok(gid) => Some(gid),
            Err(e) => {
                eprintln!("{e}");
                return 2;
            }
        },
        None => None,
    };
    // Closure §3: group-readable capability copy for the separate issuer
    // UID. Validated below (requires sharing + shadow-test + placement
    // inside the shared socket directory).
    let cap_handoff = flag(args, "--cap-handoff");
    // A2.1 transport gate: explicit UID allowlist for privileged commands.
    // Absence preserves the documented same-UID limitation (BLOCKED for
    // production); presence is enforced per-connection via SO_PEERCRED.
    let allowed_uids = match flag_str(args, "--allowed-uids") {
        Some(spec) => match parse_allowed_uids(&spec) {
            Ok(list) => Some(list),
            Err(e) => {
                eprintln!("{e}");
                return 2;
            }
        },
        None => None,
    };
    let trust_mode = match flag_str(args, "--trust-mode") {
        Some(s) => match TrustMode::parse(&s) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{e}");
                return 2;
            }
        },
        None => TrustMode::Readonly,
    };
    let layout = DaemonLayout::derive(
        &db,
        witness.as_deref(),
        Some(&socket_path),
        cap_flag.as_deref(),
    );
    // Closure §3 handoff placement gate: a group-readable key copy is only
    // ever written inside the validated shared socket directory, only with
    // an explicit sharing policy, and only when a capability exists
    // (shadow-test). Every violation refuses startup -- never a silent skip.
    if cap_handoff.is_some() && socket_group.is_none() {
        return fatal(
            "insecure-socket-dir",
            "--cap-handoff without --socket-group would widen capability access with no sharing policy; refusing (failing closed)",
        );
    }
    if let Err(e) = std::fs::create_dir_all(&layout.dir) {
        return fatal("store-error", &format!("dataroot unavailable: {e}"));
    }
    // A2.1 fail-closed hosting checks: the DataRoot must be owned by our
    // euid with no group/other bits, or the daemon refuses to start -- never
    // serves from permissive directories. umask above makes fresh
    // directories 0700; this check catches pre-existing permissive ones.
    // This DataRoot policy is NEVER weakened, including in shared mode.
    if let Err(e) = verify_protected_dir(&layout.dir, "dataroot") {
        return fatal("insecure-dataroot", &e);
    }
    // Canonical DataRoot for the separation checks below (shared socket
    // directories must neither contain nor live inside kernel persistence).
    let dataroot_canon = match std::fs::canonicalize(&layout.dir) {
        Ok(p) => p,
        Err(e) => return fatal("insecure-dataroot", &format!("dataroot unresolvable: {e}")),
    };
    // Closure §2: socket hosting policy. Strict (default) keeps the A2.1
    // owner-only rule; shared (explicit --socket-group) enforces the
    // production 0750 layout WITHOUT touching the DataRoot rule.
    let socket_dir_canon: Option<std::path::PathBuf> = match socket_group {
        Some(gid) => {
            if allowed_uids.is_none() {
                return fatal(
                    "insecure-socket-dir",
                    "--socket-group without --allowed-uids would share IPC with no peer authorization; refusing (failing closed)",
                );
            }
            // The shared directory is NEVER created here: systemd
            // (RuntimeDirectory) or the operator provisions it with the exact
            // 0750 policy. Creating it would mask provisioning errors.
            match socket_path.parent().filter(|p| !p.as_os_str().is_empty()) {
                None => {
                    return fatal(
                        "insecure-socket-dir",
                        "shared socket path has no parent directory (failing closed)",
                    );
                }
                Some(parent) => match verify_socket_dir(parent, gid) {
                    Err(e) => return fatal("insecure-socket-dir", &e),
                    Ok(sock_canon) => {
                        // Separation: the group-traversable socket directory
                        // must neither contain kernel persistence nor live
                        // inside it (the two need different policies).
                        if sock_canon == dataroot_canon
                            || sock_canon.starts_with(&dataroot_canon)
                            || dataroot_canon.starts_with(&sock_canon)
                        {
                            return fatal(
                                "insecure-socket-dir",
                                "shared socket directory must live outside the DataRoot and must not contain it (failing closed)",
                            );
                        }
                        Some(sock_canon)
                    }
                },
            }
        }
        None => {
            if let Some(socket_parent) = socket_path.parent() {
                if !socket_parent.as_os_str().is_empty() && socket_parent != layout.dir {
                    if std::fs::create_dir_all(socket_parent).is_err() {
                        return fatal("store-error", "socket directory unavailable");
                    }
                    if let Err(e) = verify_protected_dir(socket_parent, "socket") {
                        return fatal("insecure-dataroot", &e);
                    }
                }
            }
            None
        }
    };
    // Closure S3 handoff placement: the file must sit directly inside the
    // validated shared socket directory -- never in the DataRoot, never
    // elsewhere. Canonical comparison defeats dotdot and parent-symlink escapes.
    if let Some(ref handoff) = cap_handoff {
        if trust_mode != TrustMode::ShadowTest {
            return fatal(
                "insecure-socket-dir",
                "--cap-handoff in readonly mode has no capability to hand off; refusing (failing closed)",
            );
        }
        let sock_canon = match socket_dir_canon.as_ref() {
            Some(p) => p,
            None => {
                return fatal(
                    "insecure-socket-dir",
                    "cap handoff has no validated socket directory (failing closed)",
                );
            }
        };
        let h_parent = match handoff.parent().filter(|p| !p.as_os_str().is_empty()) {
            Some(p) => p,
            None => {
                return fatal(
                    "insecure-socket-dir",
                    "cap handoff path has no parent directory (failing closed)",
                );
            }
        };
        match std::fs::canonicalize(h_parent) {
            Ok(canon) if canon == *sock_canon => {}
            _ => {
                return fatal(
                    "insecure-socket-dir",
                    "cap handoff must live directly inside the shared socket directory (failing closed)",
                );
            }
        }
        if handoff == &layout.cap {
            return fatal(
                "insecure-socket-dir",
                "cap handoff must not overwrite the owner-only capability file (failing closed)",
            );
        }
        // Review F1: the handoff must not target the live socket node either:
        // key bytes into the socket would corrupt IPC and drift the 0660
        // policy (caught by failing-first test
        // cap_handoff_equal_to_socket_path_is_refused).
        if handoff == &layout.socket {
            return fatal(
                "insecure-socket-dir",
                "cap handoff must not overwrite the IPC socket (failing closed)",
            );
        }
    }
    // Single ownership: non-blocking exclusive lock for the daemon lifetime.
    // A second daemon (or any holder) makes this fail closed here.
    let lock_file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&layout.daemon_lock)
    {
        Ok(f) => f,
        Err(e) => return fatal("store-error", &format!("daemon lock file unavailable: {e}")),
    };
    if fs2::FileExt::try_lock_exclusive(&lock_file).is_err() {
        return fatal(
            codes::DAEMON_ALREADY_RUNNING,
            "a live nexusd daemon already owns this DataRoot; refusing a second instance",
        );
    }
    // Open durable state BEFORE binding the socket so readiness implies a
    // usable kernel. Corrupt/incompatible stores fail closed here and the
    // daemon never serves.
    let kernel = match nexus_kernel::Kernel::open(&layout.db, layout.witness.as_deref()) {
        Ok(k) => k,
        Err(e) => {
            return fatal(
                e.code.as_str(),
                &format!(
                    "store open failed; refusing to serve untrusted persistence: {}",
                    e.message
                ),
            );
        }
    };
    let incarnation = kernel.incarnation().to_owned();
    // Stale socket recovery: if a socket file remains but no listener
    // answers, it is a crash leftover and is reclaimed. A live listener
    // means a running daemon -> refuse (second-instance refusal).
    if layout.socket.exists() {
        match UnixStream::connect(&layout.socket) {
            Ok(_) => {
                return fatal(
                    codes::DAEMON_ALREADY_RUNNING,
                    "the socket is served by a live daemon; refusing a second instance",
                );
            }
            Err(_) => {
                let _ = std::fs::remove_file(&layout.socket);
            }
        }
    }
    let listener = match UnixListener::bind(&layout.socket) {
        Ok(l) => l,
        Err(e) => return fatal("store-error", &format!("socket bind failed: {e}")),
    };
    if listener.set_nonblocking(true).is_err() {
        return fatal("store-error", "socket mode failed");
    }
    // Closure S2: bound socket node becomes 0660 group issuer (explicit
    // sharing only). Default mode keeps umask-0077 owner-only bits.
    if let Some(gid) = socket_group {
        if let Err(e) = secure_socket_file(&layout.socket, gid) {
            return fatal("insecure-socket-dir", &e);
        }
    }
    // Issuer capability (shadow-test only): fresh random key per incarnation.
    let auth = match trust_mode {
        TrustMode::Readonly => None,
        TrustMode::ShadowTest => match nexus_daemon::IssuerAuth::generate() {
            Ok(a) => {
                if let Err(e) = write_cap_file(&layout.cap, &a.key_hex()) {
                    return fatal("store-error", &format!("capability store failed: {e}"));
                }
                Some(Arc::new(a))
            }
            Err(e) => return fatal("store-error", &format!("capability entropy failed: {e}")),
        },
    };
    // A3.3: independent write approver. A SECOND random capability, written
    // to its own owner-only file. The issuer capability can never satisfy
    // `write-scope-approve`, and the approver capability can never satisfy
    // issuer commands. Writes stay disabled unless explicitly enabled.
    let writes_enabled = args.iter().any(|a| a == "--enable-writes");
    let approver_cap_path = flag(args, "--approver-cap");
    let approver_uids: Option<Vec<u32>> = match flag_str(args, "--approver-uids") {
        Some(spec) => match parse_allowed_uids(&spec) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("{e}");
                return 2;
            }
        },
        None => None,
    };
    let require_independent = args.iter().any(|a| a == "--require-independent-approver");
    let mut approver_auth: Option<Arc<nexus_daemon::IssuerAuth>> = None;
    let mut approver_independent = false;
    if writes_enabled {
        if trust_mode != TrustMode::ShadowTest {
            return fatal(
                "bad-config",
                "--enable-writes requires --trust-mode shadow-test (failing closed)",
            );
        }
        if allowed_uids.is_none() {
            return fatal(
                "bad-config",
                "--enable-writes requires --allowed-uids so tool events and privileged commands are peer-gated (failing closed)",
            );
        }
        let (Some(cap_path), Some(ap_uids)) = (approver_cap_path.as_ref(), approver_uids.as_ref())
        else {
            return fatal(
                "bad-config",
                "--enable-writes requires --approver-cap and --approver-uids (failing closed)",
            );
        };
        if !workspace_bases_nonempty(args) {
            return fatal(
                "bad-config",
                "--enable-writes requires --workspace-bases (failing closed)",
            );
        }
        if Some(cap_path) == Some(&layout.cap) || cap_path == &layout.socket {
            return fatal("bad-config", "approver cap path collides with another file");
        }
        let issuer_uids = allowed_uids.clone().unwrap_or_default();
        approver_independent = ap_uids.iter().all(|u| !issuer_uids.contains(u));
        if require_independent && !approver_independent {
            return fatal(
                "bad-config",
                "--require-independent-approver: approver UIDs overlap the issuer UIDs (failing closed)",
            );
        }
        // Production restriction: without a verified-disjoint approver the
        // daemon refuses to enable writes unless the operator explicitly
        // names this a test-only configuration.
        let test_only = args
            .iter()
            .any(|a| a == "--allow-nonindependent-approver-test-only");
        if !approver_independent && !test_only {
            return fatal(
                "bad-config",
                "approver UIDs overlap issuer UIDs: write approval is not independent; refusing to enable writes (use --allow-nonindependent-approver-test-only for isolated test setups only)",
            );
        }
        if !approver_independent {
            log_line_startup(
                "WARNING: approver UIDs overlap issuer UIDs; write approval is NOT independent (test configuration only)",
            );
        }
        match nexus_daemon::IssuerAuth::generate() {
            Ok(a) => {
                if let Err(e) = write_cap_file(cap_path, &a.key_hex()) {
                    return fatal(
                        "store-error",
                        &format!("approver capability store failed: {e}"),
                    );
                }
                approver_auth = Some(Arc::new(a));
            }
            Err(e) => return fatal("store-error", &format!("approver entropy failed: {e}")),
        }
    }
    // Closure S3: group-readable handoff copy inside the shared socket dir.
    // Same per-incarnation key, rotated every start like the primary cap.
    if let Some(ref handoff) = cap_handoff {
        let gid = match socket_group {
            Some(g) => g,
            None => {
                return fatal(
                    "insecure-socket-dir",
                    "cap handoff has no socket group at write time (failing closed)",
                )
            }
        };
        let key_hex = match auth.as_ref() {
            Some(a) => a.key_hex(),
            None => {
                return fatal(
                    "store-error",
                    "capability unavailable for handoff; failing closed",
                )
            }
        };
        if let Err(e) = write_handoff_file(handoff, &key_hex, gid) {
            return fatal("insecure-socket-dir", &e);
        }
    }
    // A3.2: startup reconciliation. This process is the single owner of the
    // store and has no in-flight executions, so any `started` without a
    // completion is a crash/restart residue: close it as `interrupted`
    // (uncertain, never re-executed) and lapse unexecuted grants.
    let mut kernel = kernel;
    match kernel.reconcile_tool_journal(true) {
        Ok(rep) => {
            if rep.expired + rep.interrupted > 0 {
                log_line_startup(&format!(
                    "tool journal reconciled: expired={} interrupted={}",
                    rep.expired, rep.interrupted
                ));
            }
        }
        Err(e) => {
            return fatal(
                "store-corrupt",
                &format!("tool journal inconsistent at startup; failing closed: {e}"),
            );
        }
    }
    match nexus_tools::reconcile_writes(&mut kernel) {
        Ok(n) if n > 0 => log_line_startup(&format!(
            "write journal reconciled: {n} open write(s) closed as interrupted (never replayed)"
        )),
        Ok(_) => {}
        Err(e) => {
            return fatal(
                "store-corrupt",
                &format!("write journal reconciliation failed; failing closed: {e}"),
            );
        }
    }
    let workspace_bases: Vec<std::path::PathBuf> = flag_str(args, "--workspace-bases")
        .map(|v| {
            v.split(',')
                .filter(|p| !p.is_empty())
                .map(std::path::PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    let daemon = Arc::new(Daemon {
        kernel: Mutex::new(kernel),
        trust_mode,
        auth,
        allowed_uids,
        socket_group,
        cap_handoff: cap_handoff.clone(),
        lifecycle: Mutex::new(Lifecycle::Starting),
        counters: Default::default(),
        reconcile_latch: Mutex::new(None),
        workspace_bases,
        writes_enabled,
        approver_auth,
        approver_uids,
        approver_independent,
        tool_inflight: std::sync::atomic::AtomicUsize::new(0),
        witness_configured: layout.witness.is_some(),
        witness_path: layout.witness.clone(),
        start_utc: match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => format!("{}.{:09}Z", d.as_secs(), d.subsec_nanos()),
            Err(_) => "0.000000000Z".to_owned(),
        },
    });
    install_signal_handlers();
    let shutdown = Arc::new(AtomicBool::new(false));
    let poller = Arc::clone(&shutdown);
    // Bridge the C handler flag into the run-scoped flag.
    std::thread::Builder::new()
        .name("nexusd-signal".to_owned())
        .spawn(move || {
            while !SHUTDOWN.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            poller.store(true, Ordering::Relaxed);
        })
        .expect("signal bridge spawns");
    // Readiness: exactly one line on stdout. Supervisors and tests await it.
    let ready = serde_json::json!({
        "daemon": "nexusd",
        "event": "ready",
        "state": "ready",
        "incarnation": incarnation,
        "ipcProtocol": nexus_daemon::IPC_PROTOCOL_VERSION,
        "trustMode": trust_mode.as_str(),
        "dispatchEnabled": nexus_kernel::Kernel::dispatch_enabled(),
    });
    println!("{ready}");
    let _ = std::io::stdout().flush();
    serve(listener, Arc::clone(&daemon), shutdown);
    let _ = std::fs::remove_file(&layout.socket);
    // Closure S3: remove the group-readable key copy on shutdown (best
    // effort, like the socket). Rotation per start bounds any residue.
    if let Some(ref handoff) = daemon.cap_handoff {
        let _ = std::fs::remove_file(handoff);
    }
    // Explicitly release the DataRoot before exit so a supervisor restart
    // never observes a stale owner. Ordinary termination recovers cleanly;
    // only untrusted persistence latches reconciliation (never silent repair).
    let _ = fs2::FileExt::unlock(&lock_file);
    drop(lock_file);
    // Surface a latched reconciliation requirement on the final line so
    // supervision notices untrusted persistence even after a clean stop.
    let latch = daemon
        .reconcile_latch
        .lock()
        .map(|g| g.clone())
        .unwrap_or(None);
    let stopped = serde_json::json!({
        "daemon": "nexusd",
        "event": "stopped",
        "state": "stopped",
        "reconciliationRequired": latch.is_some(),
        "reconciliationDetail": latch,
    });
    println!("{stopped}");
    log_line("stopped", "", "ok", "clean stop");
    // Validate the shadow-test cap round-trips (fail closed if not).
    if trust_mode == TrustMode::ShadowTest && read_cap_file(&layout.cap).is_err() {
        eprintln!("capability store unreadable at shutdown");
    }
    0
}
