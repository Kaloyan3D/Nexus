//! Standing grants (permissions milestone) at the registry level: versioning, revocation, expiry, the
//! fail-closed rules and the audit log. Real registry files, real git, no network.
use nexus_tools::grant::{GrantSpec, GrantStatus};
use nexus_tools::registry::{self as reg, Resolved, Trust};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

fn project(base: &Path) -> (PathBuf, PathBuf) {
    let r = base.join("p1");
    std::fs::create_dir_all(r.join("src")).unwrap();
    std::fs::write(r.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(&r, &["init", "-q"]);
    git(&r, &["add", "-A"]);
    git(&r, &["commit", "-qm", "i"]);
    let rd = base.join("reg");
    reg::add(
        &rd,
        &Trust::default(),
        "alpha",
        &std::fs::canonicalize(&r).unwrap(),
        None,
        vec![],
    )
    .unwrap();
    (r, rd)
}

fn spec(fs: &str, net: &str, ap: &str, exp: Option<i64>) -> GrantSpec {
    GrantSpec {
        fs: fs.into(),
        net: net.into(),
        approval: ap.into(),
        expires_at_ms: exp,
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn audit(rd: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(rd.join("grants.audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn a_grant_is_created_versioned_replaced_revoked_and_cleared_with_an_audit_trail() {
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    // no grant: the long-standing defaults
    let rec = reg::load(&rd, &t).unwrap().get("alpha").cloned().unwrap();
    assert!(rec.grant.is_none());
    assert_eq!(
        reg::resolve_permissions(&rec, now()).unwrap(),
        Resolved::Legacy
    );
    // create (version 1)
    let rec = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "offline", "auto", None),
        "cli:uid:1",
        "c1",
    )
    .unwrap();
    let g1 = rec.grant.clone().unwrap();
    assert_eq!(
        (g1.current.version, g1.current.fs.as_str()),
        (1, "workspace")
    );
    assert!(g1.current.grant_id.starts_with("grt_"));
    // replace keeps the lineage and bumps the version
    let rec = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "install", "ask", None),
        "desktop:uid:1",
        "c2",
    )
    .unwrap();
    let g2 = rec.grant.clone().unwrap();
    assert_eq!(g2.current.grant_id, g1.current.grant_id);
    assert_eq!(g2.current.version, 2);
    assert_ne!(g1.current.digest("alpha"), g2.current.digest("alpha"));
    // revoke
    let rec = reg::revoke_grant(&rd, &t, "alpha", "cli:uid:1").unwrap();
    assert_eq!(
        rec.grant.as_ref().unwrap().status(now()),
        GrantStatus::Revoked
    );
    assert_eq!(
        reg::revoke_grant(&rd, &t, "alpha", "x").unwrap_err().code,
        "already-revoked"
    );
    // granting again after a revocation starts a NEW lineage (a running task of the old one stays stopped)
    let rec = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", None),
        "cli:uid:1",
        "c3",
    )
    .unwrap();
    let g3 = rec.grant.clone().unwrap();
    assert_ne!(g3.current.grant_id, g1.current.grant_id);
    assert_eq!(g3.current.version, 3);
    assert!(g3.revoked_at_ms.is_none());
    // clear
    let rec = reg::clear_grant(&rd, &t, "alpha", "cli:uid:1").unwrap();
    assert!(rec.grant.is_none());
    assert_eq!(
        reg::clear_grant(&rd, &t, "alpha", "x").unwrap_err().code,
        "no-grant"
    );
    // audit: one line per change, in order, with who/what/digests
    let a = audit(&rd);
    let kinds: Vec<_> = a
        .iter()
        .map(|l| l["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        kinds,
        ["created", "replaced", "revoked", "created", "cleared"]
    );
    assert_eq!(a[1]["previousDigest"], a[0]["digest"]);
    assert_eq!(a[1]["by"], "desktop:uid:1");
    assert_eq!(a[2]["grantId"], a[0]["grantId"]);
    assert!(a
        .iter()
        .all(|l| l["projectId"] == "alpha" && l["generation"].as_u64().unwrap() > 0));
    // the audit file is private and append-only (0600)
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(rd.join("grants.audit.jsonl"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn capabilities_this_build_does_not_have_cannot_be_stored_and_leave_no_trace() {
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    let gen0 = reg::load(&rd, &t).unwrap().generation;
    for (fs, net) in [
        ("full", "offline"),
        ("scratch", "controlled"),
        ("scratch", "full"),
        ("host", "offline"),
        ("", ""),
    ] {
        let e =
            reg::set_grant(&rd, &t, "alpha", &spec(fs, net, "auto", None), "cli", "c").unwrap_err();
        assert!(
            e.code == "not-available" || e.code == "bad-grant",
            "{fs}/{net}: {e}"
        );
    }
    assert!(reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "sometimes", None),
        "cli",
        "c"
    )
    .is_err());
    assert!(reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", Some(now() - 1)),
        "cli",
        "c"
    )
    .is_err());
    assert!(reg::set_grant(
        &rd,
        &t,
        "nope",
        &spec("scratch", "offline", "auto", None),
        "cli",
        "c"
    )
    .is_err());
    let f = reg::load(&rd, &t).unwrap();
    assert_eq!(f.generation, gen0, "a refused grant changed the registry");
    assert!(f.get("alpha").unwrap().grant.is_none());
    assert!(
        audit(&rd).is_empty(),
        "a refused grant was audited as if it happened"
    );
}

#[test]
fn expired_and_revoked_grants_are_rejected_for_new_tasks_never_replaced_by_the_defaults() {
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    let rec = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "ask", Some(now() + 60_000)),
        "cli",
        "c",
    )
    .unwrap();
    // active now
    match reg::resolve_permissions(&rec, now()).unwrap() {
        Resolved::Granted(f) => {
            assert_eq!(f.approval, "ask");
            assert_eq!(
                f.digest,
                rec.grant.as_ref().unwrap().current.digest("alpha")
            );
        }
        other => panic!("{other:?}"),
    }
    // expired later
    assert_eq!(
        reg::resolve_permissions(&rec, now() + 120_000)
            .unwrap_err()
            .code,
        "grant-expired"
    );
    // revoked
    let rev = reg::revoke_grant(&rd, &t, "alpha", "cli").unwrap();
    assert_eq!(
        reg::resolve_permissions(&rev, now()).unwrap_err().code,
        "grant-revoked"
    );
}

#[test]
fn a_running_task_can_only_lose_permission_never_gain_it() {
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    let rec = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", Some(now() + 3_600_000)),
        "cli",
        "c",
    )
    .unwrap();
    let frozen = match reg::resolve_permissions(&rec, now()).unwrap() {
        Resolved::Granted(f) => f,
        _ => unreachable!(),
    };
    assert!(reg::task_may_act(&rec, &frozen, now()).is_ok());
    // a WIDER version of the same lineage does not change what the task holds, and does not stop it
    let wider = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "install", "auto", None),
        "cli",
        "c",
    )
    .unwrap();
    assert!(reg::task_may_act(&wider, &frozen, now()).is_ok());
    assert_eq!(
        (frozen.fs.as_str(), frozen.net.as_str()),
        ("scratch", "offline")
    );
    // the frozen expiry still ends it even though the newer version never expires
    assert_eq!(
        reg::task_may_act(&wider, &frozen, now() + 7_200_000)
            .unwrap_err()
            .code,
        "grant-expired"
    );
    // a SHORTER expiry set later also ends it
    let shorter = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", Some(now() + 10_000)),
        "cli",
        "c",
    )
    .unwrap();
    assert_eq!(
        reg::task_may_act(&shorter, &frozen, now() + 20_000)
            .unwrap_err()
            .code,
        "grant-expired"
    );
    // revocation stops it at once
    let revoked = reg::revoke_grant(&rd, &t, "alpha", "cli").unwrap();
    assert_eq!(
        reg::task_may_act(&revoked, &frozen, now())
            .unwrap_err()
            .code,
        "grant-revoked"
    );
    // a brand-new grant after the revocation is a different lineage: the old task stays stopped
    let fresh = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", None),
        "cli",
        "c",
    )
    .unwrap();
    assert_eq!(
        reg::task_may_act(&fresh, &frozen, now()).unwrap_err().code,
        "grant-replaced"
    );
    // clearing withdraws it
    let cleared = reg::clear_grant(&rd, &t, "alpha", "cli").unwrap();
    assert_eq!(
        reg::task_may_act(&cleared, &frozen, now())
            .unwrap_err()
            .code,
        "grant-withdrawn"
    );
}

#[test]
fn in_place_commands_and_the_direct_workspace_cannot_coexist_in_either_order() {
    // a managed project can be direct only with an origin folder; build the record through the registry's own API
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    reg::mutate(&rd, &t, |f| {
        let p = f.projects.iter_mut().find(|p| p.id == "alpha").unwrap();
        p.managed = true;
        p.origin = Some("/home/u/proj".into());
        Ok(())
    })
    .unwrap();
    // grant first, then direct: refused
    reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "offline", "auto", None),
        "cli",
        "c",
    )
    .unwrap();
    let e = reg::set_workspace_mode(&rd, &t, "alpha", reg::WorkspaceMode::Direct).unwrap_err();
    assert_eq!(e.code, "bad-workspace-mode");
    // a scratch grant is fine with direct; and then an in-place grant is refused
    reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("scratch", "offline", "auto", None),
        "cli",
        "c",
    )
    .unwrap();
    reg::set_workspace_mode(&rd, &t, "alpha", reg::WorkspaceMode::Direct).unwrap();
    let e = reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "offline", "auto", None),
        "cli",
        "c",
    )
    .unwrap_err();
    assert_eq!(e.code, "not-available");
}

#[test]
fn the_registry_with_a_grant_reloads_and_unknown_fields_are_still_refused() {
    let d = tempfile::tempdir().unwrap();
    let (_r, rd) = project(d.path());
    let t = Trust::default();
    reg::set_grant(
        &rd,
        &t,
        "alpha",
        &spec("workspace", "install", "ask", Some(now() + 1000)),
        "cli:uid:1",
        "cx",
    )
    .unwrap();
    let again = reg::load(&rd, &t).unwrap();
    let g = again.get("alpha").unwrap().grant.clone().unwrap();
    assert_eq!(
        (
            g.current.fs.as_str(),
            g.current.net.as_str(),
            g.current.approval.as_str()
        ),
        ("workspace", "install", "ask")
    );
    // a forged field inside the grant record (e.g. widening by hand) is rejected by the strict schema
    let text = std::fs::read_to_string(rd.join("projects.json")).unwrap();
    let forged = text.replacen(
        "\"fs\": \"workspace\"",
        "\"fs\": \"workspace\", \"full\": true",
        1,
    );
    assert_ne!(text, forged);
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(rd.join("projects.json"), forged).unwrap();
    std::fs::set_permissions(
        rd.join("projects.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(reg::load(&rd, &t).is_err());
}
