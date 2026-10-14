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

use nexus_daemon::auth::{read_cap_file, write_cap_file};
use nexus_daemon::protocol::codes;
use nexus_daemon::server::{
    log_line, parse_allowed_uids, serve, verify_protected_dir, Daemon, Lifecycle, TrustMode,
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
    println!("         [--allowed-uids UID[,UID...]]");
    println!("Trust modes: readonly (default, privileged mutations disabled) |");
    println!("  shadow-test (explicit opt-in, per-request issuer authentication).");
    println!("--allowed-uids gates privileged commands by peer UID (SO_PEERCRED);");
    println!("  without it, same-UID peers can use a stolen capability (BLOCKED).");
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
    if let Err(e) = std::fs::create_dir_all(&layout.dir) {
        return fatal("store-error", &format!("dataroot unavailable: {e}"));
    }
    // A2.1 fail-closed hosting checks: the DataRoot (and a custom socket
    // parent outside it) must be owned by our euid with no group/other
    // bits, or the daemon refuses to start -- never serves from permissive
    // directories. umask above makes fresh directories 0700; this check
    // catches pre-existing permissive ones.
    if let Err(e) = verify_protected_dir(&layout.dir, "dataroot") {
        return fatal("insecure-dataroot", &e);
    }
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
    let daemon = Arc::new(Daemon {
        kernel: Mutex::new(kernel),
        trust_mode,
        auth,
        allowed_uids,
        lifecycle: Mutex::new(Lifecycle::Starting),
        counters: Default::default(),
        reconcile_latch: Mutex::new(None),
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
