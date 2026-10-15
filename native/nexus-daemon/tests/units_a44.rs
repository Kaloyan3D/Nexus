//! A4.4 consistency of the shipped production units with the daemon's own
//! `production-v1` validator and with each other. Configuration check only:
//! this is NOT a systemd deployment test.

use std::path::PathBuf;

fn unit(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../deploy")
        .join(name);
    std::fs::read_to_string(p).expect("unit file")
}

/// Join `\`-continued lines and return the value of a directive.
fn directive(unit: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let joined = unit.replace("\\\n", " ");
    for l in joined.lines() {
        if let Some(v) = l.strip_prefix(&format!("{key}=")) {
            out.push(v.trim().to_owned());
        }
    }
    out
}

fn tokens(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_owned).collect()
}

fn flag<'a>(argv: &'a [String], f: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == f)
        .and_then(|i| argv.get(i + 1))
        .map(|s| s.as_str())
}

#[test]
fn daemon_unit_enables_the_profile_and_passes_the_daemons_own_validator() {
    let u = unit("nexusd.service");
    let exec = directive(&u, "ExecStart");
    assert_eq!(exec.len(), 1);
    let sub = exec[0]
        .replace("ISSUER_UID_HERE", "2002")
        .replace("APPROVER_UID_HERE", "2005")
        .replace("NEXUS_WITNESS_UID_HERE", "2007")
        .replace("WORKSPACE_BASE_HERE", "/srv/work");
    let argv = tokens(&sub);
    assert_eq!(flag(&argv, "--security-profile"), Some("production-v1"));
    let env = |_: &str| None;
    nexus_daemon::profile::validate_production_v1(&argv[1..], &env, 2001)
        .expect("shipped unit must satisfy production-v1");
    // No Environment= lines: nothing test-only can be armed from the unit.
    assert!(directive(&u, "Environment").is_empty());
    assert!(directive(&u, "EnvironmentFile").is_empty());
}

#[test]
fn units_agree_on_witness_identity_socket_ordering_and_group_membership() {
    let d = unit("nexusd.service");
    let w = unit("nexus-witness.service");
    // Witness unit is production-flagged and arms nothing test-only.
    let wexec = directive(&w, "ExecStart");
    let wargv = tokens(&wexec[0]);
    assert!(wargv.iter().any(|a| a == "--production"));
    assert!(!wargv.iter().any(|a| a == "--allow-same-uid-test-only"));
    assert!(directive(&w, "Environment").is_empty());
    assert!(directive(&w, "EnvironmentFile").is_empty());
    // The socket the daemon dials is the socket the witness serves.
    let dargv = tokens(&directive(&d, "ExecStart")[0]);
    assert_eq!(
        flag(&dargv, "--external-witness"),
        flag(&wargv, "--socket"),
        "daemon and witness must agree on the witness socket"
    );
    // Dependency and ordering, both directions.
    assert!(directive(&d, "Requires")
        .iter()
        .any(|v| v.contains("nexus-witness.service")));
    assert!(directive(&d, "After")
        .iter()
        .any(|v| v.contains("nexus-witness.service")));
    assert!(directive(&w, "Before")
        .iter()
        .any(|v| v.contains("nexusd.service")));
    // Group membership: every group the daemon chgrp's or names must be a
    // supplementary group (it can only chgrp to groups it belongs to).
    let sup: Vec<String> = directive(&d, "SupplementaryGroups")
        .iter()
        .flat_map(|v| tokens(v))
        .collect();
    for pre in directive(&d, "ExecStartPre") {
        let t = tokens(&pre);
        if t.first().map(|s| s.as_str()) == Some("/bin/chgrp") {
            let g = &t[1];
            assert!(
                sup.contains(g),
                "daemon must be in group {g} to chgrp: {sup:?}"
            );
        }
    }
    for f in ["--socket-group", "--cap-handoff-gid", "--approver-cap-gid"] {
        let g = flag(&dargv, f).unwrap().to_owned();
        assert!(
            sup.contains(&g),
            "{f} {g} must be a supplementary group: {sup:?}"
        );
    }
    // The witness's client group is the daemon's AND the witness's group.
    let wgroup = flag(&wargv, "--socket-group").unwrap().to_owned();
    assert!(sup.contains(&wgroup));
    assert!(directive(&w, "SupplementaryGroups")
        .iter()
        .any(|v| v.contains(&wgroup)));
    // Only the unprivileged daemon user may commit.
    assert!(directive(&d, "User").iter().all(|u| u != "root"));
    assert!(directive(&w, "User").iter().all(|u| u != "root"));
    assert_ne!(directive(&d, "User"), directive(&w, "User"));
}

#[test]
fn production_configuration_rejects_every_test_only_toggle() {
    let u = unit("nexusd.service");
    let base = tokens(
        &directive(&u, "ExecStart")[0]
            .replace("ISSUER_UID_HERE", "2002")
            .replace("APPROVER_UID_HERE", "2005")
            .replace("NEXUS_WITNESS_UID_HERE", "2007")
            .replace("WORKSPACE_BASE_HERE", "/srv/work"),
    );
    let none = |_: &str| None;
    for extra in [
        "--allow-nonindependent-approver-test-only",
        "--witness-adopt-legacy",
    ] {
        let mut a = base[1..].to_vec();
        a.push(extra.into());
        assert!(
            nexus_daemon::profile::validate_production_v1(&a, &none, 2001).is_err(),
            "{extra} must be refused"
        );
    }
    for var in [
        "NEXUS_TEST_WRITE_CRASH_AT",
        "NEXUS_WITNESS_FAULT",
        "NEXUS_TOOLS_OFFLINE_TEST",
        "NEXUS_TOOLS_OFFLINE_WRITE_TEST",
        "NEXUS_TOOLS_OFFLINE_PROCESS_TEST",
    ] {
        let env = |k: &str| (k == var).then(|| "1".to_owned());
        assert!(
            nexus_daemon::profile::validate_production_v1(&base[1..], &env, 2001).is_err(),
            "{var} must be refused"
        );
    }
}
