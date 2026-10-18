//! A6.1.4 start-up rules of the interactive (automated workspace policy) profile.
//! The behaviour of the policy itself is covered by the daemon unit tests and the
//! broker end-to-end tests; this file pins the configuration locks and the
//! no-downgrade latch against the real `nexusd` binary.

mod common;

use common::*;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

struct Root {
    dir: tempfile::TempDir,
    bases: std::path::PathBuf,
    wt: std::path::PathBuf,
    acap_dir: tempfile::TempDir,
}

fn root() -> Root {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let bases = std::fs::canonicalize(dir.path()).unwrap().join("work");
    let wt = bases.join("worktrees");
    std::fs::create_dir_all(&wt).unwrap();
    let acap_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(acap_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    Root {
        dir,
        bases,
        wt,
        acap_dir,
    }
}

/// Start nexusd on `r`'s data root with `extra` flags; Ok(child) once healthy,
/// Err(output) when it refuses to start.
fn start(r: &Root, extra: &[String]) -> Result<Child, String> {
    let d = r.dir.path();
    let socket = d.join("n.sock");
    let _ = std::fs::remove_file(&socket);
    let uid = euid().to_string();
    let mut c = Command::new(nexusd_bin());
    c.arg("--db")
        .arg(d.join("k.db"))
        .arg("--socket")
        .arg(&socket)
        .arg("--cap")
        .arg(d.join("issuer.cap"))
        .args(["--trust-mode", "shadow-test"])
        .arg("--witness")
        .arg(d.join("k.wit.db"))
        .args(["--allowed-uids", &uid])
        .arg("--workspace-bases")
        .arg(&r.bases)
        .args([
            "--enable-model-pilot",
            "--enable-repo-code",
            "--enable-writes",
            "--enable-process",
        ])
        .arg("--worktree-root")
        .arg(&r.wt)
        .args(extra)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    die_with_test(&mut c);
    let mut child = c.spawn().unwrap();
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(v) = raw_request(
            &socket,
            r#"{"protocol":1,"id":"p","cmd":"health","params":{}}"#,
        ) {
            if v["ok"] == true {
                return Ok(child);
            }
        }
        if let Ok(Some(_)) = child.try_wait() {
            use std::io::Read;
            let mut out = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut out);
            }
            if let Some(mut o) = child.stdout.take() {
                let _ = o.read_to_string(&mut out);
            }
            return Err(out);
        }
        if Instant::now() > end {
            terminate(&mut child);
            return Err("never became ready".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn human_flags(r: &Root) -> Vec<String> {
    vec![
        "--approver-cap".into(),
        r.acap_dir
            .path()
            .join("approver.cap")
            .to_string_lossy()
            .into_owned(),
        "--approver-uids".into(),
        euid().to_string(),
        "--allow-nonindependent-approver-test-only".into(),
        "--require-human-approval".into(),
    ]
}

#[test]
fn the_interactive_profile_cannot_be_combined_with_a_human_approver_or_started_incompletely() {
    let r = root();
    let auto = "--autonomous-workspace-policy".to_owned();
    for extra in [
        vec![auto.clone(), "--require-human-approval".into()],
        vec![
            auto.clone(),
            "--allow-nonindependent-approver-test-only".into(),
        ],
        vec![auto.clone(), "--require-independent-approver".into()],
        vec![auto.clone(), "--approver-cap".into(), "/tmp/x.cap".into()],
        vec![auto.clone(), "--approver-uids".into(), "1".into()],
    ] {
        let e = start(&r, &extra).expect_err("must refuse");
        assert!(e.contains("cannot be combined"), "{extra:?}: {e}");
    }
    // missing prerequisites are refused too (here: no writes/process/repo-code)
    let d = r.dir.path();
    let o = Command::new(nexusd_bin())
        .arg("--db")
        .arg(d.join("k2.db"))
        .arg("--socket")
        .arg(d.join("n2.sock"))
        .arg("--cap")
        .arg(d.join("i2.cap"))
        .args([
            "--trust-mode",
            "shadow-test",
            "--allowed-uids",
            &euid().to_string(),
            "--autonomous-workspace-policy",
        ])
        .arg("--workspace-bases")
        .arg(&r.bases)
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(
        String::from_utf8_lossy(&o.stderr).contains("requires --enable-repo-code")
            || String::from_utf8_lossy(&o.stdout).contains("requires --enable-repo-code")
    );
    // the production profile never accepts it
    let o = Command::new(nexusd_bin())
        .args([
            "--security-profile",
            "production-v1",
            "--autonomous-workspace-policy",
        ])
        .output()
        .unwrap();
    assert!(!o.status.success());
}

#[test]
fn a_store_latched_automated_never_starts_weaker_and_a_human_store_never_starts_automated() {
    let r = root();
    // 1. a store that ran with human approval cannot be restarted automated (downgrade)
    let mut h = start(&r, &human_flags(&r)).expect("human mode starts");
    terminate(&mut h);
    let e = start(&r, &["--autonomous-workspace-policy".into()]).expect_err("downgrade refused");
    assert!(
        e.contains("approval-downgrade-refused") || e.contains("downgrade"),
        "{e}"
    );
    // 2. a fresh store starts automated, has no approver credential, and reports honestly
    let r2 = root();
    let mut a = start(&r2, &["--autonomous-workspace-policy".into()]).expect("automated starts");
    let cap = read_cap(&r2.dir.path().join("issuer.cap"));
    let st = raw_request(
        &r2.dir.path().join("n.sock"),
        &authed_frame(&cap, "status", serde_json::json!({})),
    )
    .unwrap();
    assert_eq!(st["automatedPolicy"], "autonomous-workspace/v1", "{st}");
    assert_eq!(st["requireHumanApproval"], false);
    assert_eq!(st["approvalGated"], true);
    assert!(!r2.acap_dir.path().join("approver.cap").exists());
    terminate(&mut a);
    // 3. restarting the same store without the policy (mutating tools on) is refused: the latch only rises
    let e = start(&r2, &[]).expect_err("weaker restart refused");
    assert!(e.contains("approval-downgrade-refused"), "{e}");
}
