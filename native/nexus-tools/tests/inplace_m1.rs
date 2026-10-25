//! True In-Place Execution, milestone 1: commands write the task's own working copy in place.
//! Real Kernel, real sandbox. Prints `NOT RUN` when the host lacks the sandbox (the release battery
//! runs with `NEXUS_REQUIRE_SANDBOX=1`, which turns that into a failure elsewhere).

mod common;

use common::*;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_in, CancellationToken};
use serde_json::json;
use std::time::Duration;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/python3").exists() {
        println!("NOT RUN ({t}): sandbox unavailable: {:?}", c.problems);
        return false;
    }
    let caps = {
        use nexus_tools::exec_contract::ExecBackend;
        nexus_tools::exec_contract::LinuxBwrapBackend.caps()
    };
    if !caps.pinned_root_mount {
        println!("NOT RUN ({t}): bubblewrap without --bind-fd");
        return false;
    }
    true
}

fn sh(
    fx: &mut Fx,
    script: &str,
) -> Result<nexus_tools::ToolExecutionOutcome, nexus_tools::ToolError> {
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol)?;
    let call = authorize(&mut fx.kernel, p)?;
    let run = fx.dir.path().join("exec");
    execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &run, 120_000, None)
}

fn out(o: &nexus_tools::ToolExecutionOutcome) -> serde_json::Value {
    o.result.output.clone().unwrap_or_default()
}

fn text(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}

#[test]
fn scratch_scope_is_unchanged_effects_are_discarded_and_reported() {
    if !ready("scratch") {
        return;
    }
    let mut fx = fixture("m1-scratch");
    fx.write("a.txt", b"one\n");
    fx.approve_process(60_000);
    let o = sh(
        &mut fx,
        "mkdir -p out && echo made > out/f.txt && echo changed > a.txt",
    )
    .expect("run");
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "{}", text(&v));
    assert_eq!(v["writeBack"], "none");
    assert!(v["snapshotDigest"].as_str().is_some_and(|d| d.len() == 64));
    assert!(
        v.get("fsScope").is_none(),
        "scratch output gained a field: {v}"
    );
    assert_eq!(v["scratchEffects"]["persisted"], false);
    assert!(
        v.get("effects").is_none(),
        "a scratch run gained an effects record: {v}"
    );
    assert!(
        !fx.dir.path().join("exec/_effects").exists(),
        "a scratch run wrote a ledger"
    );
    assert!(
        !fx.ws.join("out").exists(),
        "scratch effects reached the project"
    );
    assert_eq!(fx.disk("a.txt").unwrap(), "one\n");
    let entries = fx.kernel.list_tool_journal(None).unwrap();
    let prepared = entries.iter().find(|e| e.phase == "prepared").unwrap();
    assert_eq!(prepared.payload["sandbox"]["writeBack"], "none");
    assert!(prepared.payload.get("fsScope").is_none());
    assert_eq!(fx.pscope().fs_scope, "scratch");
}

#[test]
fn workspace_scope_persists_mkdir_formatters_and_generators_in_the_working_copy() {
    if !ready("workspace") {
        return;
    }
    let mut fx = fixture("m1-ws");
    fx.write("src/main.txt", b"hello   world\n");
    fx.write("gen/spec.json", br#"{"names":["a","b"]}"#);
    let sc = fx.approve_process_fs(60_000, "workspace");
    assert_eq!(sc.fs_scope, "workspace");
    // mkdir
    let o = sh(&mut fx, "mkdir -p build/out tests/unit && echo ok").expect("mkdir");
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert!(fx.ws.join("build/out").is_dir() && fx.ws.join("tests/unit").is_dir());
    // a "formatter" rewriting an existing file
    fx.approve_process_fs(60_000, "workspace");
    let o = sh(&mut fx, "sed -i 's/  */ /g' src/main.txt").expect("format");
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert_eq!(fx.disk("src/main.txt").unwrap(), "hello world\n");
    // a "code generator" reading a spec and writing several files
    fx.approve_process_fs(60_000, "workspace");
    let o = sh(
        &mut fx,
        r#"python3 - <<'PY'
import json, os
spec = json.load(open("gen/spec.json"))
os.makedirs("generated", exist_ok=True)
for n in spec["names"]:
    open(f"generated/{n}.txt", "w").write(f"// generated {n}\n")
PY"#,
    )
    .expect("generate");
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert_eq!(fx.disk("generated/a.txt").unwrap(), "// generated a\n");
    assert_eq!(fx.disk("generated/b.txt").unwrap(), "// generated b\n");
    // files belong to the real user, not to a mapped uid
    use std::os::unix::fs::MetadataExt;
    let me = unsafe { libc::geteuid() };
    assert_eq!(
        std::fs::metadata(fx.ws.join("generated/a.txt"))
            .unwrap()
            .uid(),
        me
    );
    // the record says what is true
    let v = out(&o);
    assert_eq!(v["writeBack"], "in-place");
    assert_eq!(v["fsScope"], "workspace");
    assert!(v["snapshotDigest"].is_null());
    assert!(v.get("scratchEffects").is_none());
    let entries = fx.kernel.list_tool_journal(None).unwrap();
    let prepared = entries
        .iter()
        .rev()
        .find(|e| e.phase == "prepared")
        .unwrap();
    assert_eq!(prepared.payload["fsScope"], "workspace");
    assert_eq!(prepared.payload["sandbox"]["writeBack"], "in-place");
    assert_eq!(prepared.payload["sandbox"]["rootMount"], "descriptor-bound");
    let dump = serde_json::to_string(&prepared.payload).unwrap();
    assert!(!dump.contains("\"writeBack\":\"none\""), "{dump}");
}

#[test]
fn protected_entries_are_read_only_or_hidden_and_absent_names_are_never_created() {
    if !ready("protect") {
        return;
    }
    let mut fx = fixture("m1-protect");
    fx.write("src/lib.txt", b"x\n");
    fx.write(".git/config", b"[core]\n");
    fx.write(".git/HEAD", b"ref: refs/heads/main\n");
    fx.write(".env", b"TOKEN=verysecret\n");
    fx.write(".ssh/id_ed25519", b"PRIVATE-KEY\n");
    let before: std::collections::BTreeSet<String> = std::fs::read_dir(&fx.ws)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    fx.approve_process_fs(60_000, "workspace");
    let o = sh(
        &mut fx,
        r#"
echo "tamper" >> .git/config; echo "git-config-rc=$?"
echo "tamper" > .git/newfile; echo "git-new-rc=$?"
rm -f .git/HEAD; echo "git-rm-rc=$?"
cat .env 2>&1; echo "env-rc=$?"
ls .ssh 2>&1; echo "ssh-ls-rc=$?"
echo y > .env; echo "env-write-rc=$?"
echo ok > allowed.txt; echo "allowed-rc=$?"
"#,
    )
    .expect("run");
    let t = text(&out(&o));
    assert!(t.contains("git-config-rc=1"), "{t}");
    assert!(t.contains("git-new-rc=1"), "{t}");
    assert!(t.contains("git-rm-rc=1"), "{t}");
    assert!(
        !t.contains("verysecret"),
        "a hidden secret was readable: {t}"
    );
    assert!(!t.contains("PRIVATE-KEY"), "{t}");
    assert!(t.contains("allowed-rc=0"), "{t}");
    // on the host: the protected files are exactly as they were
    assert_eq!(fx.disk(".git/config").unwrap(), "[core]\n");
    assert!(fx.ws.join(".git/HEAD").exists());
    assert!(!fx.ws.join(".git/newfile").exists());
    assert_eq!(fx.disk(".env").unwrap(), "TOKEN=verysecret\n");
    assert_eq!(fx.disk(".ssh/id_ed25519").unwrap(), "PRIVATE-KEY\n");
    // masks only cover what exists: no new entries other than the one the command created
    let after: std::collections::BTreeSet<String> = std::fs::read_dir(&fx.ws)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let added: Vec<_> = after.difference(&before).cloned().collect();
    assert_eq!(added, ["allowed.txt"], "{added:?}");
}

#[test]
fn filesystem_escapes_are_refused() {
    if !ready("escape") {
        return;
    }
    let mut fx = fixture("m1-escape");
    // links created BEFORE the run, as a hostile snapshot or earlier command could have
    let secret = fx.outside.join("secret.txt");
    std::os::unix::fs::symlink(&secret, fx.ws.join("abs-link")).unwrap();
    std::os::unix::fs::symlink("../outside/secret.txt", fx.ws.join("rel-link")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", fx.ws.join("etc-link")).unwrap();
    let host_path = secret.display().to_string();
    let outside_dir = fx.outside.display().to_string();
    fx.approve_process_fs(60_000, "workspace");
    let script = format!(
        r#"
cat abs-link 2>&1; echo "abs-rc=$?"
cat rel-link 2>&1; echo "rel-rc=$?"
cat etc-link 2>&1; echo "etc-rc=$?"
cat '{host_path}' 2>&1; echo "direct-rc=$?"
ls '{outside_dir}' 2>&1; echo "ls-rc=$?"
cat ../outside/secret.txt 2>&1; echo "dotdot-rc=$?"
ls /home /root /etc/shadow 2>&1 | head -3; echo "host-rc=$?"
echo pwn > /usr/pwn 2>&1; echo "usr-rc=$?"
echo pwn > /work/pwn 2>&1; echo "work-rc=$?"
echo pwn > ../pwn 2>&1; echo "up-rc=$?"
"#
    );
    let o = sh(&mut fx, &script).expect("run");
    let t = text(&out(&o));
    assert!(
        !t.contains(OUTSIDE_SECRET),
        "an outside secret was readable: {t}"
    );
    for rc in [
        "abs-rc=1",
        "rel-rc=1",
        "etc-rc=1",
        "direct-rc=1",
        "ls-rc=2",
        "dotdot-rc=1",
        "usr-rc=1",
        "work-rc=1",
        "up-rc=1",
    ] {
        assert!(t.contains(rc), "expected {rc}: {t}");
    }
    assert!(!fx.outside.join("../pwn").exists());
    assert!(!fx.ws.join("../pwn").exists());
}

#[test]
fn the_mounted_object_is_the_verified_directory_even_if_its_path_is_swapped() {
    if !ready("swap") {
        return;
    }
    let mut fx = fixture("m1-swap");
    fx.approve_process_fs(60_000, "workspace");
    let ws = fx.ws.clone();
    let moved = ws.with_file_name(format!(
        "{}-moved",
        ws.file_name().unwrap().to_string_lossy()
    ));
    let (w2, m2) = (ws.clone(), moved.clone());
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        std::fs::rename(&w2, &m2).unwrap();
        // a decoy now sits at the old path
        std::fs::create_dir(&w2).unwrap();
    });
    let o = sh(&mut fx, "sleep 1.5; echo late > late.txt; echo done").expect("run");
    t.join().unwrap();
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert!(
        moved.join("late.txt").exists(),
        "the write must land in the verified object"
    );
    assert!(
        !ws.join("late.txt").exists(),
        "the write followed the path, not the object"
    );
    std::fs::remove_dir(&ws).unwrap();
    std::fs::rename(&moved, &ws).unwrap();
}

#[test]
fn a_scope_the_approver_did_not_seal_cannot_be_chosen_by_the_caller() {
    if !ready("forge") {
        return;
    }
    let mut fx = fixture("m1-forge");
    // 1. the tool arguments have no field for a scope
    fx.approve_process(60_000);
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "echo a > forged.txt"], "cwd": ".", "fsScope": "workspace"}),
    );
    let pol = policy();
    let e = fx.prepare_p(r, &pol).unwrap_err();
    assert_eq!(e.code.as_str(), "invalid-arguments", "{e:?}");
    // 2. a scratch scope runs scratch, whatever the environment looks like
    let o = sh(&mut fx, "echo a > forged.txt").expect("run");
    assert_eq!(out(&o)["writeBack"], "none");
    assert!(!fx.ws.join("forged.txt").exists());
    // 3. the Kernel seals only the scopes that exist: 'full' and unknown names are refused
    let mut fx2 = fixture("m1-forge2");
    let root = fx2.binding().root_digest;
    for bad in ["full", "host", "", "WORKSPACE"] {
        let r = fx2.kernel.bind_process_scope_with_fs(
            &fx2.command.clone(),
            "a",
            false,
            &root,
            1000,
            bad,
        );
        assert!(r.is_err(), "'{bad}' must be refused");
    }
}

#[test]
fn cancellation_stops_the_whole_tree_and_keeps_only_what_was_written() {
    if !ready("cancel") {
        return;
    }
    let mut fx = fixture("m1-cancel");
    fx.approve_process_fs(60_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "(while true; do echo tick >> ticks.txt; sleep 0.05; done) & wait"], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let run = fx.dir.path().join("exec");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        c2.cancel();
    });
    let o = execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &run, 120_000, None)
        .expect("cancelled run");
    t.join().unwrap();
    assert!(
        fx.journal_phases().contains(&"cancelled".to_string()),
        "{:?}",
        fx.journal_phases()
    );
    let _ = o;
    // partial effects persist (in place), and nothing keeps writing after the cancel
    let n1 = std::fs::metadata(fx.ws.join("ticks.txt"))
        .expect("partial output persisted")
        .len();
    assert!(n1 > 0);
    std::thread::sleep(Duration::from_millis(400));
    let n2 = std::fs::metadata(fx.ws.join("ticks.txt")).unwrap().len();
    assert_eq!(
        n1, n2,
        "a process of the cancelled execution is still writing"
    );
    assert!(
        std::fs::read_dir(fx.dir.path().join("exec"))
            .map(|d| d.flatten().filter(|e| e.file_name() != "_effects").count())
            .unwrap_or(0)
            == 0,
        "run dir left behind"
    );
}

#[test]
fn a_command_cannot_leave_a_mount_or_use_the_network_to_escape_the_copy() {
    if !ready("net") {
        return;
    }
    let mut fx = fixture("m1-net");
    fx.approve_process_fs(60_000, "workspace");
    let o = sh(
        &mut fx,
        r#"python3 - <<'PY'
import socket
try:
    socket.create_connection(("1.1.1.1", 53), timeout=2); print("NET-REACHED")
except Exception as e: print("net-blocked", type(e).__name__)
PY
mount -t tmpfs x /tmp 2>&1 | head -1; echo "mount-done""#,
    )
    .expect("run");
    let t = text(&out(&o));
    assert!(
        t.contains("net-blocked") && !t.contains("NET-REACHED"),
        "{t}"
    );
}

#[test]
fn no_mount_descriptor_leaks_into_the_command() {
    if !ready("fds") {
        return;
    }
    let mut fx = fixture("m1-fds");
    fx.write(".git/config", b"[core]\n");
    fx.write(".env", b"X=1\n");
    fx.approve_process_fs(60_000, "workspace");
    let o = sh(
        &mut fx,
        r#"python3 -c "import os; print('FDS', sorted(int(x) for x in os.listdir('/proc/self/fd')))""#,
    )
    .expect("run");
    let t = text(&out(&o));
    let line = t
        .lines()
        .find(|l| l.starts_with("FDS"))
        .expect(&t)
        .to_owned();
    let fds: Vec<i64> = line
        .trim_start_matches("FDS [")
        .trim_end_matches(']')
        .split(", ")
        .filter_map(|x| x.parse().ok())
        .collect();
    // 0,1,2 and the directory handle of the listing itself; nothing at 4.. (the project descriptors)
    assert!(fds.iter().all(|f| *f <= 3), "leaked descriptors: {fds:?}");
}
