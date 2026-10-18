//! A6.1.3 operator project registry: identity, pin, scope, ownership, symlinks,
//! malformed records, concurrent and interrupted updates. Real git, no network.
use nexus_tools::registry::{self as reg, Trust};
use std::os::unix::fs::{symlink, PermissionsExt};
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
fn repo(base: &Path, name: &str) -> (PathBuf, String) {
    let r = base.join(name);
    std::fs::create_dir_all(r.join("src")).unwrap();
    std::fs::write(r.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(&r, &["init", "-q"]);
    git(&r, &["add", "-A"]);
    git(&r, &["commit", "-qm", "i"]);
    let c = git(&r, &["rev-parse", "HEAD"]);
    (std::fs::canonicalize(&r).unwrap(), c)
}
fn t() -> Trust {
    Trust::default()
}

#[test]
fn add_list_show_remove_and_pin_to_head() {
    let d = tempfile::tempdir().unwrap();
    let (r, head) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    let rec = reg::add(&rd, &t(), "alpha", &r, None, vec!["src/".into()]).unwrap();
    assert_eq!(rec.pinned_commit, head);
    assert_eq!(
        std::fs::metadata(&rd).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(rd.join("projects.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let f = reg::load(&rd, &t()).unwrap();
    assert_eq!(f.generation, 1);
    assert_eq!(f.projects.len(), 1);
    reg::remove(&rd, &t(), "alpha").unwrap();
    assert_eq!(reg::load(&rd, &t()).unwrap().projects.len(), 0);
    assert_eq!(
        reg::remove(&rd, &t(), "alpha").unwrap_err().code,
        "not-found"
    );
}

#[test]
fn invalid_ids_commits_and_scopes_are_refused() {
    let d = tempfile::tempdir().unwrap();
    let (r, head) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    for bad in ["", ".hidden", "a/b", "a b", "x\0y", &"a".repeat(65)] {
        assert_eq!(
            reg::add(&rd, &t(), bad, &r, None, vec![]).unwrap_err().code,
            "bad-id",
            "{bad:?}"
        );
    }
    assert_eq!(
        reg::add(&rd, &t(), "a", &r, Some(&"0".repeat(40)), vec![])
            .unwrap_err()
            .code,
        "commit-mismatch"
    );
    assert_eq!(
        reg::add(&rd, &t(), "a", &r, Some("ABC"), vec![])
            .unwrap_err()
            .code,
        "bad-commit"
    );
    assert_eq!(
        reg::add(&rd, &t(), "a", &r, Some(&head.to_uppercase()), vec![])
            .unwrap_err()
            .code,
        "bad-commit"
    );
    for bad in ["../x", "/etc", "a//b", ".git/config", ".", "a\\b", ""] {
        assert_eq!(
            reg::add(&rd, &t(), "a", &r, None, vec![bad.into()])
                .unwrap_err()
                .code,
            "bad-write-allow",
            "{bad:?}"
        );
    }
    assert!(reg::load(&rd, &t())
        .map(|f| f.projects.is_empty())
        .unwrap_or(true));
}

#[test]
fn dirty_missing_relative_and_duplicate_sources_are_refused() {
    let d = tempfile::tempdir().unwrap();
    let (r, _) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    std::fs::write(r.join("src/lib.rs"), "dirty\n").unwrap();
    assert_eq!(
        reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap_err().code,
        "bad-source"
    );
    git(&r, &["checkout", "--", "."]);
    assert_eq!(
        reg::add(&rd, &t(), "a", Path::new("rel/path"), None, vec![])
            .unwrap_err()
            .code,
        "bad-path"
    );
    assert_eq!(
        reg::add(&rd, &t(), "a", &d.path().join("nope"), None, vec![])
            .unwrap_err()
            .code,
        "bad-path"
    );
    reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap();
    assert_eq!(
        reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap_err().code,
        "duplicate-id"
    );
    assert_eq!(
        reg::add(&rd, &t(), "b", &r, None, vec![]).unwrap_err().code,
        "duplicate-source"
    );
}

#[test]
fn a_symlinked_source_is_canonicalized_and_a_later_swap_is_detected() {
    let d = tempfile::tempdir().unwrap();
    let (r, _) = repo(d.path(), "real");
    let link = d.path().join("link");
    symlink(&r, &link).unwrap();
    let rd = d.path().join("reg");
    let rec = reg::add(&rd, &t(), "a", &link, None, vec![]).unwrap();
    assert_eq!(rec.source_path, r.to_string_lossy());
    // The registered path is replaced by a symlink to another repo: refuse at use time.
    let (other, _) = repo(d.path(), "other");
    std::fs::rename(&r, d.path().join("moved")).unwrap();
    symlink(&other, &r).unwrap();
    assert_eq!(
        reg::resolve(&rd, &t(), "a").unwrap_err().code,
        "source-moved"
    );
}

#[test]
fn spoofed_unknown_project_ids_do_not_resolve() {
    let d = tempfile::tempdir().unwrap();
    let (r, _) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap();
    for id in ["b", "A", "a ", "a/../a", "", "a\0"] {
        assert_eq!(
            reg::resolve(&rd, &t(), id).unwrap_err().code,
            "unknown-project",
            "{id:?}"
        );
    }
    assert_eq!(reg::resolve(&rd, &t(), "a").unwrap().id, "a");
}

#[test]
fn repin_requires_an_explicit_matching_clean_head() {
    let d = tempfile::tempdir().unwrap();
    let (r, old) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap();
    std::fs::write(r.join("src/new.rs"), "x\n").unwrap();
    git(&r, &["add", "-A"]);
    git(&r, &["commit", "-qm", "two"]);
    let new = git(&r, &["rev-parse", "HEAD"]);
    assert_eq!(
        reg::repin(&rd, &t(), "a", &old).unwrap_err().code,
        "commit-mismatch"
    );
    assert_eq!(
        reg::repin(&rd, &t(), "a", "xyz").unwrap_err().code,
        "bad-commit"
    );
    assert_eq!(
        reg::load(&rd, &t())
            .unwrap()
            .get("a")
            .unwrap()
            .pinned_commit,
        old
    );
    let (o, n) = reg::repin(&rd, &t(), "a", &new).unwrap();
    assert_eq!((o, n), (old, new.clone()));
    assert_eq!(
        reg::load(&rd, &t())
            .unwrap()
            .get("a")
            .unwrap()
            .pinned_commit,
        new
    );
}

#[test]
fn untrusted_permissions_symlinks_and_malformed_files_fail_closed() {
    let d = tempfile::tempdir().unwrap();
    let (r, _) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap();
    let f = rd.join("projects.json");
    // group/world-writable file
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(reg::load(&rd, &t()).unwrap_err().code, "registry-untrusted");
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    // group/world-writable directory
    std::fs::set_permissions(&rd, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(reg::load(&rd, &t()).unwrap_err().code, "registry-untrusted");
    assert_eq!(
        reg::add(&rd, &t(), "b", &r, None, vec![]).unwrap_err().code,
        "registry-untrusted"
    );
    std::fs::set_permissions(&rd, std::fs::Permissions::from_mode(0o700)).unwrap();
    // wrong trusted owner
    let other = Trust {
        owner_uids: vec![unsafe { libc::geteuid() } + 1],
    };
    assert_eq!(
        reg::load(&rd, &other).unwrap_err().code,
        "registry-untrusted"
    );
    assert_eq!(
        reg::add(&rd, &other, "b", &r, None, vec![])
            .unwrap_err()
            .code,
        "registry-untrusted"
    );
    // symlinked registry file
    let real = d.path().join("real.json");
    std::fs::rename(&f, &real).unwrap();
    symlink(&real, &f).unwrap();
    assert_eq!(reg::load(&rd, &t()).unwrap_err().code, "registry-untrusted");
    std::fs::remove_file(&f).unwrap();
    std::fs::rename(&real, &f).unwrap();
    // symlinked registry directory
    let ld = d.path().join("regl");
    symlink(&rd, &ld).unwrap();
    assert_eq!(reg::load(&ld, &t()).unwrap_err().code, "registry-untrusted");
    // hard-linked file
    std::fs::hard_link(&f, d.path().join("hl.json")).unwrap();
    assert_eq!(reg::load(&rd, &t()).unwrap_err().code, "registry-untrusted");
    std::fs::remove_file(d.path().join("hl.json")).unwrap();
    // malformed, unknown field, bad schema, duplicate ids, bad record, oversize
    let good = std::fs::read_to_string(&f).unwrap();
    let cases = [
        "{".to_string(),
        good.replace("\"generation\"", "\"extra\": 1, \"generation\""),
        good.replace(reg::SCHEMA, "other.v9"),
        good.replace("\"pinnedCommit\": \"", "\"pinnedCommit\": \"zz"),
        good.replace("\"id\": \"a\"", "\"id\": \"../a\""),
        good.replace("\"sourcePath\": \"/", "\"sourcePath\": \"rel/"),
        format!("{}{}", good, " ".repeat(2 * 1024 * 1024)),
    ];
    for c in cases {
        std::fs::write(&f, &c).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            reg::load(&rd, &t()).is_err(),
            "a tampered registry must never load"
        );
    }
    // a missing directory is an error; a missing file in a good dir is empty
    assert_eq!(
        reg::load(&d.path().join("none"), &t()).unwrap_err().code,
        "registry-missing"
    );
    std::fs::remove_file(&f).unwrap();
    assert!(reg::load(&rd, &t()).unwrap().projects.is_empty());
}

#[test]
fn concurrent_updates_are_serialized_and_never_lose_a_record() {
    let d = tempfile::tempdir().unwrap();
    let rd = d.path().join("reg");
    let mut repos = Vec::new();
    for i in 0..6 {
        repos.push(repo(d.path(), &format!("p{i}")).0);
    }
    let hs: Vec<_> = repos
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let rd = rd.clone();
            std::thread::spawn(move || {
                reg::add(&rd, &t(), &format!("proj{i}"), &r, None, vec![]).unwrap()
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let f = reg::load(&rd, &t()).unwrap();
    assert_eq!(f.projects.len(), 6);
    assert_eq!(f.generation, 6);
}

#[test]
fn an_interrupted_update_leaves_the_previous_registry_intact() {
    let d = tempfile::tempdir().unwrap();
    let (r, _) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    reg::add(&rd, &t(), "a", &r, None, vec![]).unwrap();
    // A crashed writer left a partial temp file; the published file is untouched.
    std::fs::write(rd.join(".projects.json.tmp-1"), b"{\"schema\":").unwrap();
    let f = reg::load(&rd, &t()).unwrap();
    assert_eq!(f.projects.len(), 1);
    // A failing mutation closure changes nothing and does not bump the generation.
    let e = reg::mutate(&rd, &t(), |_| -> Result<(), reg::RegError> {
        Err(reg::RegError {
            code: "boom",
            message: "x".into(),
        })
    })
    .unwrap_err();
    assert_eq!(e.code, "boom");
    assert_eq!(reg::load(&rd, &t()).unwrap().generation, 1);
}

#[test]
fn deferred_verification_needs_an_explicit_commit_and_the_file_follows_the_directory_group_intent()
{
    let d = tempfile::tempdir().unwrap();
    let (r, head) = repo(d.path(), "p1");
    let rd = d.path().join("reg");
    // --defer-verify never guesses the pin
    assert_eq!(
        reg::add_with(&rd, &t(), "a", &r, None, vec![], vec![], true)
            .unwrap_err()
            .code,
        "bad-commit"
    );
    assert_eq!(
        reg::add_with(&rd, &t(), "a", &r, Some("zz"), vec![], vec![], true)
            .unwrap_err()
            .code,
        "bad-commit"
    );
    // a non-repository is still refused without running git
    assert_eq!(
        reg::add_with(&rd, &t(), "a", d.path(), Some(&head), vec![], vec![], true)
            .unwrap_err()
            .code,
        "bad-source"
    );
    // private directory -> private file
    let rec = reg::add_with(
        &rd,
        &t(),
        "a",
        &r,
        Some(&head),
        vec![],
        vec![1000, 1001],
        true,
    )
    .unwrap();
    assert_eq!(rec.allowed_uids, [1000, 1001]);
    assert_eq!(
        std::fs::metadata(rd.join("projects.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // directory shared read-only with a group -> file group-readable, never group-writable
    std::fs::set_permissions(&rd, std::fs::Permissions::from_mode(0o750)).unwrap();
    reg::set_allowed_uids(&rd, &t(), "a", vec![]).unwrap();
    assert_eq!(
        std::fs::metadata(rd.join("projects.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert!(reg::load(&rd, &t())
        .unwrap()
        .get("a")
        .unwrap()
        .allowed_uids
        .is_empty());
    // a deferred re-pin still needs the path to resolve to itself
    let (o, n) = reg::repin_with(&rd, &t(), "a", &"1".repeat(40), true).unwrap();
    assert_eq!((o, n), (head, "1".repeat(40)));
}
