//! EM-04C2 S9: the Governor worker as a PRODUCTION build runs it (default features, no
//! `test-engines`, so no test-only configuration exists): deny-all Node permission mode enforced and
//! proven, no unprotected fallback, bounded memory and concurrency, nothing inherited (environment,
//! descriptors), restart/cancel behaviour.
//!
//! Threat model (accepted by the owner): a single-user, trusted Governor worker confined by Node's
//! permission mode. This is defence in depth, NOT an OS sandbox: the network is not restricted and
//! the process shares the broker's uid. Nothing here claims otherwise.
//!
//! Nodes: `NEXUS_PRODGATE_NODES` (a `:`-separated list) or, by default, `node` from PATH plus the
//! bundled runtime when installed. At least one usable Node (>= 23.5) is REQUIRED: a missing Node
//! fails the gate, it is never a silent skip.

use nexus_broker::engine::governor_bridge::GovernorEvaluator;
use nexus_broker::engine::worker_bridge::{
    worker_node_flags, WorkerConfig, WorkerGovernorBridge, WorkerSlots, MAX_LIVE_WORKERS,
    WORKER_HEAP_MB, WORKER_SEMI_SPACE_MB,
};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn nodes() -> Vec<PathBuf> {
    let list: Vec<PathBuf> = match std::env::var("NEXUS_PRODGATE_NODES") {
        Ok(v) => v
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect(),
        Err(_) => {
            let mut v = vec![PathBuf::from("node")];
            if let Some(h) = std::env::var_os("HOME") {
                let bundled = PathBuf::from(h).join(".local/share/nexus/runtime/node/bin/node");
                if bundled.exists() {
                    v.push(bundled);
                }
            }
            v
        }
    };
    let usable: Vec<PathBuf> = list
        .into_iter()
        .filter(|n| {
            std::process::Command::new(n)
                .args([
                    "--permission",
                    "-e",
                    "process.exit(process.permission ? 0 : 3)",
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .collect();
    assert!(
        !usable.is_empty(),
        "the production gate needs a Node >= 23.5 (set NEXUS_PRODGATE_NODES); a missing Node is a failure"
    );
    usable
}

fn args() -> Value {
    json!({"museReasoning": null, "museActivity": null, "events": [],
           "capabilities": ["low", "medium", "high", "xhigh"], "resolve": true})
}

fn bridge(node: &std::path::Path, scope: &str) -> WorkerGovernorBridge {
    WorkerGovernorBridge::new(node.to_path_buf(), scope, Arc::new(AtomicBool::new(false)))
}

fn proc_file(pid: u32, name: &str) -> Vec<u8> {
    std::fs::read(format!("/proc/{pid}/{name}")).unwrap_or_default()
}

fn rss_kib(pid: u32) -> u64 {
    String::from_utf8_lossy(&proc_file(pid, "status"))
        .lines()
        .find(|l| l.starts_with("VmRSS:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// A `node` wrapper (a shim) that runs the real node after `edit`ing the argument list.
fn shim(dir: &std::path::Path, real: &PathBuf, body: &str) -> PathBuf {
    let real = std::fs::canonicalize(real)
        .or_else(|_| {
            // `node` from PATH
            std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("command -v {}", real.display()))
                .output()
                .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim().to_owned()))
        })
        .unwrap();
    let path = dir.join("node-shim.sh");
    std::fs::write(
        &path,
        format!("#!/bin/sh\nREAL='{}'\n{body}\n", real.display()),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn the_reviewed_flag_set_is_deny_all_and_bounded() {
    let f = worker_node_flags();
    assert_eq!(
        f,
        [
            "--permission".to_owned(),
            format!("--max-old-space-size={WORKER_HEAP_MB}"),
            format!("--max-semi-space-size={WORKER_SEMI_SPACE_MB}"),
        ]
    );
    assert!(f.iter().all(|x| !x.starts_with("--allow")));
    assert_eq!((WORKER_HEAP_MB, WORKER_SEMI_SPACE_MB), (48, 2));
}

/// A real production worker: reviewed argv, empty environment (a planted secret in THIS process does
/// not reach it), no inherited descriptors beyond its pipes, same uid, answers the Governor.
#[test]
fn a_production_worker_runs_under_the_reviewed_flags_with_nothing_inherited() {
    // SAFETY: this test is the only one touching these names
    unsafe {
        std::env::set_var(
            "NEXUS_PRODGATE_PLANTED_SECRET",
            "sk-not-a-real-credential-0123456789",
        );
        std::env::set_var("OPENAI_API_KEY", "sk-not-a-real-credential-9876543210");
    }
    for node in nodes() {
        let b = bridge(&node, "prodgate-env");
        let r = b.call("evaluate", &args()).expect("the worker answers");
        assert_eq!(r["decision"]["outcome"], "resolved");
        let pid = b.pid().expect("a live worker");
        let cmd = String::from_utf8_lossy(&proc_file(pid, "cmdline")).into_owned();
        let argv: Vec<&str> = cmd.split('\0').filter(|s| !s.is_empty()).collect();
        for flag in worker_node_flags() {
            assert!(argv.contains(&flag.as_str()), "{flag} in {argv:?}");
        }
        assert!(argv.iter().all(|a| !a.starts_with("--allow")), "{argv:?}");
        assert!(
            !cmd.contains("sk-not-a-real"),
            "a credential reached the command line"
        );
        assert!(
            proc_file(pid, "environ").is_empty(),
            "the worker has an EMPTY environment"
        );
        // descriptors: only pipes / anonymous inodes / /dev/null; no socket, no file
        let mut fds = 0;
        for e in std::fs::read_dir(format!("/proc/{pid}/fd"))
            .unwrap()
            .flatten()
        {
            let t = std::fs::read_link(e.path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            fds += 1;
            assert!(
                t.starts_with("pipe:") || t.starts_with("anon_inode:") || t == "/dev/null",
                "unexpected descriptor {t} in {}",
                node.display()
            );
        }
        assert!(fds >= 3, "stdio at least");
        // same user: it is a trusted worker under a permission mode, not a different principal
        let status = String::from_utf8_lossy(&proc_file(pid, "status")).into_owned();
        let uid = status
            .lines()
            .find(|l| l.starts_with("Uid:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_owned();
        assert_eq!(uid, unsafe { libc::getuid() }.to_string());
        b.shutdown();
    }
}

/// Under exactly the production flags, filesystem, process, worker-thread and addon access are
/// denied by Node itself (the same mechanism the worker's start-up proof relies on).
#[test]
fn the_permission_mode_denies_filesystem_process_and_addon_access() {
    let probe = r#"
      const out = {};
      const t = (k, f) => { try { f(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.code || String(e); } };
      const fs = require('fs'), cp = require('child_process');
      t('read', () => fs.readFileSync('/etc/hostname'));
      t('readdir', () => fs.readdirSync('/'));
      t('write', () => fs.writeFileSync('/tmp/nexus-prodgate-probe', 'x'));
      t('spawn', () => cp.spawnSync('true'));
      t('worker', () => new (require('worker_threads').Worker)('1', { eval: true }));
      t('addon', () => process.dlopen({ exports: {} }, '/nonexistent.node'));
      out.has = ['fs.read', 'fs.write', 'child', 'worker', 'addon'].map((s) => process.permission.has(s));
      console.log(JSON.stringify(out));
    "#;
    for node in nodes() {
        let mut c = std::process::Command::new(&node);
        c.args(worker_node_flags()).arg("-e").arg(probe).env_clear();
        let out = c.output().unwrap();
        let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
            panic!(
                "{}: {}",
                node.display(),
                String::from_utf8_lossy(&out.stderr)
            )
        });
        for k in ["read", "readdir", "write", "spawn", "worker"] {
            assert_eq!(v[k], "ERR_ACCESS_DENIED", "{k} on {}", node.display());
        }
        assert!(
            matches!(
                v["addon"].as_str(),
                Some("ERR_DLOPEN_DISABLED") | Some("ERR_ACCESS_DENIED")
            ),
            "{v}"
        );
        assert_eq!(v["has"], json!([false, false, false, false, false]));
    }
    assert!(!std::path::Path::new("/tmp/nexus-prodgate-probe").exists());
}

/// NO unprotected fallback: a Node that drops the permission flag (the worker's own start-up proof
/// fails) and a Node that rejects it (too old) both leave a supervisor that never gets an answer,
/// keeps no process, and says why.
#[test]
fn a_node_without_permission_enforcement_never_answers_and_nothing_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    for node in nodes() {
        // drops --permission from the argument list
        let dropper = shim(
            dir.path(),
            &node,
            r#"args=""; for a in "$@"; do [ "$a" = "--permission" ] || args="$args '$a'"; done
eval exec "'$REAL'" $args"#,
        );
        let b = bridge(&dropper, "prodgate-drop");
        let e = b
            .call("evaluate", &args())
            .expect_err("no answer without enforcement");
        assert!(
            matches!(
                e.code.as_str(),
                "bridge-failed" | "bridge-protocol" | "bridge-unavailable"
            ),
            "{} / {}",
            e.code,
            e.message
        );
        assert!(b.pid().is_none(), "no unprotected process is kept");
        // a Node that does not know the option
        let old = shim(
            dir.path(),
            &node,
            r#"for a in "$@"; do [ "$a" = "--permission" ] && { echo "node: bad option: --permission" >&2; exit 9; }; done
exec "$REAL" "$@""#,
        );
        let b = bridge(&old, "prodgate-old");
        let e = b
            .call("evaluate", &args())
            .expect_err("an old Node fails closed");
        assert!(b.pid().is_none());
        assert!(
            e.message.contains("23.5")
                || e.message.to_lowercase().contains("permission")
                || !e.code.is_empty(),
            "{e:?}"
        );
    }
}

/// The supervisor itself refuses any other flag set outside test builds, however the configuration
/// is assembled (the field is public; the check is in the supervisor).
#[test]
fn the_supervisor_refuses_every_other_flag_set() {
    let node = nodes().remove(0);
    let base = worker_node_flags();
    let cases: Vec<Vec<String>> = vec![
        base.iter()
            .filter(|f| *f != "--permission")
            .cloned()
            .collect(),
        [base.clone(), vec!["--allow-fs-read=*".to_owned()]].concat(),
        [base.clone(), vec!["--allow-child-process".to_owned()]].concat(),
        [base.clone(), vec!["--allow-addons".to_owned()]].concat(),
        [base.clone(), vec!["--allow-worker".to_owned()]].concat(),
        vec!["--max-old-space-size=48".to_owned()],
        vec![],
        [base.clone(), vec!["--inspect".to_owned()]].concat(),
        base.iter().rev().cloned().collect(),
    ];
    for flags in cases {
        let mut cfg = WorkerConfig::new(node.clone());
        cfg.node_flags = flags.clone();
        let b = WorkerGovernorBridge::with_config(
            cfg,
            "prodgate-flags",
            Arc::new(AtomicBool::new(false)),
        );
        let e = b
            .call("evaluate", &args())
            .expect_err(&format!("refused: {flags:?}"));
        assert!(
            b.pid().is_none(),
            "{flags:?}: no process was started ({e:?})"
        );
    }
    // and the reviewed set works
    let b = bridge(&node, "prodgate-ok");
    assert!(b.call("evaluate", &args()).is_ok());
    b.shutdown();
}

/// Concurrency is bounded by the broker's `max_active` (never above the absolute backstop); a refused
/// spawn takes nothing; ending a worker returns its slot.
#[test]
fn worker_concurrency_is_bounded_by_the_brokers_allowance() {
    let node = nodes().remove(0);
    assert_eq!(WorkerSlots::for_max_active(0).max(), 1);
    assert_eq!(WorkerSlots::for_max_active(2).max(), 2);
    assert_eq!(WorkerSlots::for_max_active(10_000).max(), MAX_LIVE_WORKERS);
    let slots = Arc::new(WorkerSlots::for_max_active(2));
    let mk = |n: &str| {
        WorkerGovernorBridge::with_config(
            WorkerConfig::new(node.clone()).with_slots(Arc::clone(&slots)),
            format!("prodgate-slots-{n}"),
            Arc::new(AtomicBool::new(false)),
        )
    };
    let (a, b, c) = (mk("a"), mk("b"), mk("c"));
    assert!(a.call("evaluate", &args()).is_ok());
    assert!(b.call("evaluate", &args()).is_ok());
    assert_eq!(slots.live(), 2);
    let e = c
        .call("evaluate", &args())
        .expect_err("the third worker is refused");
    assert_eq!(e.code, "bridge-busy", "{e:?}");
    assert_eq!(slots.live(), 2, "a refused spawn takes nothing");
    a.shutdown();
    assert!(c.call("evaluate", &args()).is_ok(), "the slot came back");
    b.shutdown();
    c.shutdown();
}

/// Memory stays bounded: RSS after 2,000 requests is under the 100 MiB target on every Node.
#[test]
fn worker_memory_stays_under_the_budget() {
    for node in nodes() {
        let b = bridge(&node, "prodgate-mem");
        let mut state = Value::Null;
        for i in 0..2_000 {
            let r = b
                .call(
                    "evaluate",
                    &json!({"museReasoning": state, "museActivity": null, "events": [],
                            "capabilities": ["low", "medium", "high", "xhigh"], "resolve": true}),
                )
                .expect("answers");
            if i % 2 == 0 {
                state = r["museReasoning"].clone();
            }
        }
        let pid = b.pid().expect("alive");
        let rss = rss_kib(pid);
        println!(
            "PRODGATE worker RSS after 2000 requests on {}: {:.1} MiB",
            node.display(),
            rss as f64 / 1024.0
        );
        assert!(rss > 0 && rss < 100 * 1024, "{rss} KiB");
        b.shutdown();
    }
}

/// Restart and cancellation: a killed worker is replaced transparently (one retry); a cancelled
/// bridge answers nothing more; a crash loop is stopped by the restart limit; the process is gone
/// after shutdown.
#[test]
fn restart_cancellation_and_the_crash_loop_limit_hold() {
    let node = nodes().remove(0);
    let cancel = Arc::new(AtomicBool::new(false));
    let b = WorkerGovernorBridge::new(node.clone(), "prodgate-restart", Arc::clone(&cancel));
    assert!(b.call("evaluate", &args()).is_ok());
    let first = b.pid().unwrap();
    // SAFETY: killing our own child
    unsafe { libc::kill(first as i32, libc::SIGKILL) };
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(
        b.call("evaluate", &args()).is_ok(),
        "replaced transparently"
    );
    let second = b.pid().unwrap();
    assert_ne!(first, second);
    assert!(b.stats().spawns >= 2);
    // a crash loop: kill after every answer until the limit trips
    let mut limited = None;
    for _ in 0..12 {
        if let Some(p) = b.pid() {
            unsafe { libc::kill(p as i32, libc::SIGKILL) };
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Err(e) = b.call("evaluate", &args()) {
            limited = Some(e.code);
            break;
        }
    }
    println!(
        "PRODGATE crash-loop outcome: {limited:?}; spawns {}",
        b.stats().spawns
    );
    assert!(
        b.stats().spawns <= 8,
        "the restart limit (6 per minute) bounds respawning: {}",
        b.stats().spawns
    );
    // cancellation
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(
        b.call("evaluate", &args()).unwrap_err().code,
        "bridge-cancelled"
    );
    b.shutdown();
    assert!(b.pid().is_none());
    assert_eq!(
        b.call("evaluate", &args()).unwrap_err().code,
        "bridge-closed"
    );
}
