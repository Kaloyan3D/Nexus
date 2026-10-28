//! Release 1: the whole preview journey on the REAL runtime - nexusd + the broker started by the same
//! supervisor code the application uses, a real sandbox, a real Node server on a real loopback bridge.
//! Dialogs are scripted (nobody is at the keyboard) and so is "the model": the server is started through
//! the broker's user surface (`job-start`), the same surface the Adaptive job tools dispatch to. What this
//! proves is the native/broker authorization chain around it; it is NOT a GUI test and not a provider run.
//! Skipped (loudly) on a machine without the sandbox, unless NEXUS_REQUIRE_SANDBOX=1.

use nexus_client::intent_client as ic;
use nexus_desktop_lib::dialogs::ScriptedDialogs;
use nexus_desktop_lib::interactive::Runtime;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn http_get(addr: &str) -> String {
    let Ok(mut s) = std::net::TcpStream::connect(addr) else {
        return "<connect-failed>".into();
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf
}

fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(20) {
        if ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("timed out waiting for: {what}");
}

fn project(rt: &Runtime, dir: &std::path::Path, name: &str, msg: &str) -> String {
    let p = dir.join(name);
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(
        p.join("server.js"),
        "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.end(fs.readFileSync('msg.txt'))}).listen(4321,'127.0.0.1',()=>console.log('listening-4321'));\n",
    )
    .unwrap();
    std::fs::write(p.join("msg.txt"), msg).unwrap();
    std::fs::write(
        p.join("package.json"),
        "{\"name\":\"demo\",\"scripts\":{\"test\":\"true\"}}\n",
    )
    .unwrap();
    let d = ScriptedDialogs {
        confirm: true,
        ..Default::default()
    };
    d.folders
        .lock()
        .unwrap()
        .push(p.to_string_lossy().into_owned());
    let v = rt.project_pick(&d).expect("open project");
    v["project"]["projectId"].as_str().unwrap().to_owned()
}

fn grant_of(sock: &std::path::Path, id: &str) -> serde_json::Value {
    let l = ic::project_list(sock, false).unwrap();
    l["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["projectId"] == id)
        .cloned()
        .unwrap_or_default()
}

#[test]
fn the_preview_journey_runs_on_the_real_runtime_without_a_terminal() {
    let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/target/debug");
    let names = [
        "nexusd",
        "nexus-broker",
        "nexus-approver",
        "nexus-confine",
        "nexus-egress",
    ];
    for n in names {
        assert!(
            native.join(n).is_file(),
            "build the native workspace first ({n})"
        );
    }
    let node = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("node").is_file()))
        .unwrap_or(false);
    if !node {
        eprintln!("SKIPPED: node is not installed on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in names {
        std::fs::copy(native.join(n), bin.join(n)).unwrap();
    }
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::set_var("NEXUS_BIN_DIR", &bin);
    std::env::set_var("NEXUS_HOME", tmp.path().join("home"));
    let rt = Runtime::new();
    let _stop = rt.guard();
    rt.start_blocking();
    assert_eq!(rt.state().phase, "ready", "{:?}", rt.state().message);
    let sock = ic::default_broker_socket();

    // The machine must be able to confine in-place commands, and the application must SAY so. Without it
    // the journey is correctly unavailable (covered by the permission-support unit tests), so skip.
    let support = ic::project_list(&sock, false).unwrap()["permissions"].clone();
    if support["inPlaceAvailable"] != true {
        let why = support["inPlaceReason"].clone();
        assert!(
            std::env::var_os("NEXUS_REQUIRE_SANDBOX").is_none(),
            "the sandbox is required here but unavailable: {why}"
        );
        eprintln!("SKIPPED: in-place commands are unavailable here: {why}");
        return;
    }

    let yes = ScriptedDialogs {
        confirm: true,
        ..Default::default()
    };
    let a = project(&rt, tmp.path(), "site-a", "hello-A");
    let b = project(&rt, tmp.path(), "site-b", "hello-B");
    let start = |id: &str| ic::job_start(&sock, id, "node", &["server.js".to_owned()], &[4321]);

    // 1. nothing is permitted yet: no previews, and no project gains anything from another
    let e = start(&a).unwrap_err();
    assert!(
        e.message.contains("no standing permission") || e.code == "no-grant",
        "{e:?}"
    );

    // 2. "Allow Nexus to edit this project" (A only): the folder, then the confined commands
    rt.project_allow_work(&yes, &a).unwrap();
    let pa = grant_of(&sock, &a);
    assert_eq!(pa["workspaceMode"], "direct");
    assert_eq!(pa["grant"]["fs"], "workspace");
    assert_eq!(pa["grant"]["net"], "offline", "network stays off");
    assert!(
        pa["grant"]["devPorts"].as_array().unwrap().is_empty(),
        "no port was implied"
    );
    assert!(
        grant_of(&sock, &b).get("grant").is_none_or(|g| g.is_null()),
        "B gained a grant from A"
    );

    // 3. the editing permission alone does not open a port
    let e = start(&a).unwrap_err();
    assert!(
        e.message
            .contains("development port 4321 is not authorized"),
        "{e:?}"
    );

    // 4. a declined confirmation changes nothing; a confirmed one adds exactly that port
    let no = ScriptedDialogs {
        confirm: false,
        ..Default::default()
    };
    assert_eq!(
        rt.project_allow_previews(&no, &a, &[4321]).unwrap_err(),
        "cancelled"
    );
    assert!(grant_of(&sock, &a)["grant"]["devPorts"]
        .as_array()
        .unwrap()
        .is_empty());
    rt.project_allow_previews(&yes, &a, &[4321]).unwrap();
    assert_eq!(
        grant_of(&sock, &a)["grant"]["devPorts"],
        serde_json::json!([4321])
    );
    // ... for A only
    let e = start(&b).unwrap_err();
    assert!(
        e.code == "no-grant" || e.message.contains("no standing permission"),
        "{e:?}"
    );

    // 5. a real server, a real preview, opened by the native layer from the broker's record
    let job = start(&a).expect("the authorized preview starts");
    let jid = job["jobId"].as_str().unwrap().to_owned();
    assert_eq!(job["projectId"], a.as_str());
    wait("the server answers", || {
        http_get(&format!("127.0.0.1:{}", job["exposed"][0]["hostPort"])).contains("hello-A")
    });
    let url = rt.preview_open(&yes, &jid, 4321).expect("open the preview");
    assert_eq!(*yes.opened.lock().unwrap(), vec![url.clone()]);
    assert!(
        http_get(url.trim_start_matches("http://")).contains("hello-A"),
        "{url}"
    );

    // 6. editing files while the server stays up is seen through the same preview
    std::fs::write(tmp.path().join("site-a/msg.txt"), "hello-A-v2").unwrap();
    assert!(http_get(url.trim_start_matches("http://")).contains("hello-A-v2"));
    assert_eq!(ic::job_status(&sock, &jid).unwrap()["state"], "running");

    // 7. logs are readable; each project sees only its own jobs
    wait("logs", || {
        ic::job_logs(&sock, &jid).unwrap()["logs"]
            .as_str()
            .unwrap_or("")
            .contains("listening-4321")
    });
    let mine = ic::job_list_for(&sock, &a).unwrap();
    assert!(mine["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|j| j["jobId"] == jid.as_str()));
    assert!(ic::job_list_for(&sock, &b).unwrap()["jobs"]
        .as_array()
        .unwrap()
        .is_empty());

    // 8. REVOKING previews while the server runs stops it: a job cannot outlive its authority
    rt.project_revoke_previews(&yes, &a).unwrap();
    wait("the server is stopped by the revocation", || {
        ic::job_status(&sock, &jid).unwrap()["state"] != "running"
    });
    assert!(rt
        .preview_open(&yes, &jid, 4321)
        .unwrap_err()
        .contains("not running"));
    assert_eq!(yes.opened.lock().unwrap().len(), 1);
    assert_eq!(
        http_get(url.trim_start_matches("http://")),
        "<connect-failed>"
    );

    // 9. allow again, start, then revoke ALL permissions mid-run: the server stops too
    rt.project_allow_previews(&yes, &a, &[4321]).unwrap();
    let j2 = start(&a).expect("restart after re-allowing");
    let j2id = j2["jobId"].as_str().unwrap().to_owned();
    rt.project_end_grant(&yes, &a, false).unwrap();
    wait("the server is stopped by revoking the permissions", || {
        ic::job_status(&sock, &j2id).unwrap()["state"] != "running"
    });
    assert!(
        start(&a).is_err(),
        "no new server under revoked permissions"
    );

    // 10. a runtime restart keeps projects, permissions' history and job records, and never reports a
    //     dead server as running
    rt.project_allow_work(&yes, &a).unwrap();
    rt.project_allow_previews(&yes, &a, &[4321]).unwrap();
    // a conversation exists for each project before the restart
    let ta = ic::thread_create(&sock, &a, Some("Build the site")).expect("conversation A");
    let tb = ic::thread_create(&sock, &b, Some("Other site")).expect("conversation B");
    let ta_id = ta["thread"]["threadId"].as_str().unwrap().to_owned();
    let j3 = start(&a).expect("start before the restart");
    let j3id = j3["jobId"].as_str().unwrap().to_owned();
    let home = rt.home.clone().unwrap();
    nexus_runtime::stop(&home).expect("stop the runtime");
    rt.start_blocking();
    assert_eq!(rt.state().phase, "ready", "{:?}", rt.state().message);
    let after = ic::job_list_for(&ic::default_broker_socket(), &a).unwrap();
    let rec = after["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|j| j["jobId"] == j3id.as_str())
        .cloned()
        .expect("the job record survived the restart");
    assert_ne!(rec["state"], "running", "{rec}");
    assert_eq!(rec["projectId"], a.as_str(), "{rec}");
    // conversations survived, each in its own project
    let sock2 = ic::default_broker_socket();
    let listed = |p: &str| -> Vec<String> {
        ic::thread_list(&sock2, Some(p), false).unwrap()["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["threadId"].as_str().unwrap().to_owned())
            .collect()
    };
    assert!(
        listed(&a).contains(&ta_id),
        "conversation A was lost by the restart"
    );
    assert_eq!(listed(&b).len(), 1, "conversation B");
    assert!(
        !listed(&b).contains(&ta_id),
        "a conversation leaked into another project"
    );
    let pa = grant_of(&ic::default_broker_socket(), &a);
    assert_eq!(
        pa["grant"]["devPorts"],
        serde_json::json!([4321]),
        "permissions survived"
    );
    assert!(grant_of(&ic::default_broker_socket(), &b)
        .get("grant")
        .is_none_or(|g| g.is_null()));
    let _ = tb;
}
