//! M2.1: the Desktop's REAL runtime (nexusd + broker started by the same supervisor code the app uses) is
//! provisioned with the approver channel, says so truthfully, and the Desktop's own backend manages
//! permissions through it. Dialogs are scripted (nobody is at the keyboard): that is stated here.
//! Deciding a pending operation is done by the real terminal approver; see the broker end-to-end test
//! `perm_the_real_terminal_approver_approves_and_denies_an_ask_operation`.

use nexus_client::intent_client as ic;
use nexus_desktop_lib::dialogs::ScriptedDialogs;
use nexus_desktop_lib::interactive::Runtime;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[test]
fn the_desktop_runtime_has_a_private_approver_channel_and_manages_permissions_through_it() {
    let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/target/debug");
    for n in ["nexusd", "nexus-broker", "nexus-approver"] {
        assert!(
            native.join(n).is_file(),
            "build the native workspace first ({n})"
        );
    }
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for n in ["nexusd", "nexus-broker", "nexus-approver"] {
        std::fs::copy(native.join(n), bin.join(n)).unwrap();
    }
    std::env::remove_var("NEXUS_BROKER_SOCKET");
    std::env::set_var("NEXUS_BIN_DIR", &bin);
    std::env::set_var("NEXUS_HOME", tmp.path().join("home"));
    let rt = Runtime::new();
    rt.start_blocking();
    let st = rt.state();
    assert_eq!(st.phase, "ready", "{:?}", st.message);
    let home = rt.home.clone().unwrap();

    // the approver credential: its own private directory, owner-only, separate from the issuer's
    let cap = home.approver_cap();
    assert!(cap.is_file(), "the approver credential was not provisioned");
    assert_eq!(
        std::fs::metadata(&cap).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(cap.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_ne!(cap.parent(), home.issuer_cap().parent());
    // the command shown to the user names real paths (never the credential's content)
    let cmd = st
        .approver_command
        .expect("the runtime knows how the person decides");
    assert!(
        cmd.contains(&bin.join("nexus-approver").display().to_string()),
        "{cmd}"
    );
    assert!(
        cmd.contains(&home.daemon_socket().display().to_string()),
        "{cmd}"
    );
    assert!(
        cmd.contains(&cap.display().to_string()) && cmd.ends_with("review "),
        "{cmd}"
    );
    let key = std::fs::read_to_string(&cap).unwrap().trim().to_owned();
    assert!(!cmd.contains(&key), "the credential leaked into the hint");

    // open a project through the Desktop backend (scripted folder picker)
    let proj = tmp.path().join("myproj");
    std::fs::create_dir_all(proj.join("src")).unwrap();
    std::fs::write(proj.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(
        proj.join("Cargo.toml"),
        "[package]\nname=\"myproj\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
    )
    .unwrap();
    // "No" to "Let Nexus edit this folder directly?": an ISOLATED project (the only kind that can run
    // in-place commands at this stage)
    let open = ScriptedDialogs {
        folders: std::sync::Arc::new(std::sync::Mutex::new(vec![proj
            .to_string_lossy()
            .into_owned()])),
        confirm: false,
        secret: None,
    };
    let d = ScriptedDialogs {
        confirm: true,
        ..open.clone()
    };
    let opened = rt.project_pick(&open).expect("open project");
    let id = opened["project"]["projectId"].as_str().unwrap().to_owned();

    // the runtime reports that Ask can be answered
    let sock = ic::default_broker_socket();
    let l = ic::project_list(&sock, false).unwrap();
    assert_eq!(l["permissions"]["known"], true, "{l}");
    assert_eq!(l["permissions"]["standingGrants"], true);
    assert_eq!(l["permissions"]["askAvailable"], true, "{l}");

    // Ask, then Auto, then revoke, then remove - each through the native confirmation
    rt.project_set_grant(&d, &id, "workspace", "offline", "ask", None)
        .expect("ask");
    let g = ic::project_list(&sock, false).unwrap()["projects"][0]["grant"].clone();
    assert_eq!(
        (
            g["approval"].as_str(),
            g["fs"].as_str(),
            g["status"].as_str()
        ),
        (Some("ask"), Some("workspace"), Some("active"))
    );
    assert_eq!(
        g["createdBy"].as_str().unwrap().split(':').next(),
        Some("desktop")
    );
    rt.project_set_grant(&d, &id, "workspace", "offline", "auto", Some(3600))
        .expect("auto");
    let g = ic::project_list(&sock, false).unwrap()["projects"][0]["grant"].clone();
    assert_eq!(
        (g["approval"].as_str(), g["version"].as_u64()),
        (Some("auto"), Some(2))
    );
    // a "no" in the dialog changes nothing
    let no = ScriptedDialogs {
        confirm: false,
        ..d.clone()
    };
    assert_eq!(
        rt.project_end_grant(&no, &id, false).unwrap_err(),
        "cancelled"
    );
    assert_eq!(
        ic::project_list(&sock, false).unwrap()["projects"][0]["grant"]["status"],
        "active"
    );
    rt.project_end_grant(&d, &id, false).unwrap();
    assert_eq!(
        ic::project_list(&sock, false).unwrap()["projects"][0]["grant"]["status"],
        "revoked"
    );
    rt.project_end_grant(&d, &id, true).unwrap();
    assert!(ic::project_list(&sock, false).unwrap()["projects"][0]["grant"].is_null());
    // the audit log recorded every change, by the desktop surface
    let audit =
        std::fs::read_to_string(home.projects_registry().join("grants.audit.jsonl")).unwrap();
    let events: Vec<String> = audit
        .lines()
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(events, ["created", "replaced", "revoked", "cleared"]);
    rt.shutdown();
}
