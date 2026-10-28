//! M7D broker-level acceptance: job verbs over a real Direct project + standing grant,
//! revocation while running, and owner-restart honesty. Real sandbox; prints NOT RUN when
//! the host lacks it.

use nexus_broker::jobs;
use nexus_broker::projects::{self, Env};
use nexus_tools::jobs::JobManager;
use nexus_tools::registry::{Trust, WorkspaceMode};
use serde_json::json;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn ready() -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !Path::new("/usr/bin/node").exists() {
        println!(
            "NOT RUN (broker jobs): sandbox/node unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

fn git(dir: &Path, args: &[&str]) {
    let o = std::process::Command::new("/usr/bin/git")
        .args([
            "-c",
            "user.email=m7@example.invalid",
            "-c",
            "user.name=m7",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
}

struct Fx {
    _t: tempfile::TempDir,
    proj: PathBuf,
    env_dir: PathBuf,
    state: PathBuf,
}

fn fixture() -> (Fx, Env<'static>, String) {
    let t = tempfile::tempdir().unwrap();
    let proj = t.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(
        proj.join("server.js"),
        "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.end(fs.readFileSync('msg.txt'))}).listen(4321,'127.0.0.1',()=>console.log('listening-4321'));\n",
    )
    .unwrap();
    std::fs::write(proj.join("msg.txt"), "v1\n").unwrap();
    git(&proj, &["init", "-q"]);
    git(&proj, &["add", "-A"]);
    git(&proj, &["commit", "-q", "-m", "first"]);
    let reg = t.path().join("registry");
    std::fs::create_dir_all(&reg).unwrap();
    let trust = Trust::default();
    let _ = trust;
    // Leak the registry dir path into a 'static Env by keeping the TempDir alive in Fx.
    let env_dir = reg.clone();
    let snaps = t.path().join("snaps");
    std::fs::create_dir_all(&snaps).unwrap();
    let state = t.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    let fx = Fx {
        _t: t,
        proj,
        env_dir: env_dir.clone(),
        state,
    };
    // The Env borrows paths owned by Fx; the caller keeps Fx alive for the test's duration.
    let env = Env {
        registry_dir: unsafe { &*(&fx.env_dir as *const PathBuf) },
        trust: Box::leak(Box::new(Trust::default())),
        snapshots_dir: unsafe { &*(&fx.state as *const PathBuf) },
        forbidden: vec![],
    };
    let opened = projects::open_with(&env, fx.proj.to_str().unwrap(), Some(WorkspaceMode::Direct))
        .expect("open direct project");
    let pid = opened["projectId"]
        .as_str()
        .or_else(|| opened["project"]["projectId"].as_str())
        .unwrap_or_else(|| panic!("open shape: {opened}"))
        .to_owned();
    (fx, env, pid)
}

fn grant(env: &Env<'_>, id: &str) {
    let choices =
        json!({"fs": "workspace", "net": "offline", "approval": "auto", "devPorts": [4321]});
    let pv = projects::grant_preview(env, id, &choices).expect("grant preview");
    let mut set = choices.clone();
    set["textSha256"] = pv["textSha256"].clone();
    projects::grant_set(env, "test-owner", id, &set).expect("grant set");
}

fn http_get(url: &str) -> Result<String, String> {
    let port: u16 = url
        .rsplit(':')
        .next()
        .unwrap()
        .trim_end_matches('/')
        .parse()
        .map_err(|e: std::num::ParseIntError| e.to_string())?;
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    s.read_to_string(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..100 {
        if f() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn m7d_broker_job_lifecycle_revocation_and_restart_honesty() {
    if !ready() {
        return;
    }
    let (fx, env, pid) = fixture();
    grant(&env, &pid);
    let mgr = Arc::new(JobManager::open(&fx.state.join("jobs")).unwrap());
    // start a dev server through the broker verb, under the project's grant
    let v = jobs::job_start(
        &mgr,
        &env,
        &fx.state,
        &json!({"projectId": pid, "program": "node", "args": ["server.js"], "cwd": ".", "exposePorts": [4321]}),
    )
    .expect("job start");
    let job_id = v["jobId"].as_str().unwrap().to_owned();
    assert_eq!(v["state"], "running", "{v}");
    let url = v["exposed"][0]["url"].as_str().unwrap().to_owned();
    wait_for("server via broker bridge", || {
        http_get(&url).is_ok_and(|r| r.contains("v1"))
    });
    let logs = jobs::job_logs(&mgr, &json!({"jobId": job_id})).unwrap();
    assert!(
        logs["logs"].as_str().unwrap().contains("listening-4321"),
        "{logs}"
    );
    // a port the grant does not authorize is refused
    let e = jobs::job_start(
        &mgr,
        &env,
        &fx.state,
        &json!({"projectId": pid, "program": "node", "args": ["server.js"], "cwd": ".", "exposePorts": [9999]}),
    )
    .expect_err("unauthorized port refused");
    assert!(e.1.contains("not authorized"), "{}", e.1);

    // REVOKE while running: the watcher must stop the job; it cannot outlive its authority
    projects::grant_revoke(&env, "test-owner", &pid, &json!({})).expect("revoke");
    wait_for("job stopped after revocation", || {
        jobs::job_status(&mgr, &json!({"jobId": job_id})).unwrap()["state"] != "running"
    });
    let st = jobs::job_status(&mgr, &json!({"jobId": job_id})).unwrap();
    assert_eq!(st["state"], "stopped", "{st}");
    assert!(http_get(&url).is_err(), "exposure removed with the job");

    // a job cannot start under a revoked grant
    let e = jobs::job_start(
        &mgr,
        &env,
        &fx.state,
        &json!({"projectId": pid, "program": "node", "args": ["server.js"], "cwd": ".", "exposePorts": []}),
    )
    .expect_err("revoked grant refuses new jobs");
    assert!(e.0 == "grant-inactive" || e.0 == "no-grant", "{e:?}");

    // OWNER RESTART honesty: re-grant, start, drop the manager (owner death), reopen —
    // the record must not claim the job is running.
    grant(&env, &pid);
    let job2 = jobs::job_start(
        &mgr,
        &env,
        &fx.state,
        &json!({"projectId": pid, "program": "node", "args": ["server.js"], "cwd": ".", "exposePorts": [4321]}),
    )
    .expect("job2 start");
    let job2_id = job2["jobId"].as_str().unwrap().to_owned();
    drop(mgr);
    let mgr2 = Arc::new(JobManager::open(&fx.state.join("jobs")).unwrap());
    let st = jobs::job_status(&mgr2, &json!({"jobId": job2_id})).unwrap();
    assert_ne!(st["state"], "running", "{st}");
    let list = jobs::job_list(&mgr2, &json!({})).unwrap();
    assert!(
        list["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["state"] != "running"),
        "{list}"
    );
    // Release 1: a job belongs to its project, and that survives the owner (the record is on disk),
    // so the Desktop can show each project's previews and never another project's.
    let mine = jobs::job_list(&mgr2, &json!({"projectId": pid})).unwrap();
    assert!(
        mine["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|j| j["jobId"] == job2_id.as_str() && j["projectId"] == pid.as_str()),
        "{mine}"
    );
    let other = jobs::job_list(&mgr2, &json!({"projectId": "some-other-project"})).unwrap();
    assert!(other["jobs"].as_array().unwrap().is_empty(), "{other}");
    // keep fixture dirs alive to the end
    let _ = &fx.proj;
    drop(fx);
}
