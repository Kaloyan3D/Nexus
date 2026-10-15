//! A3.5 dependency-cache adversarial tests. All archives are synthetic and
//! built in-process; nothing touches the network or a package home.

use flate2::{write::GzEncoder, Compression};
use nexus_tools::depcache::*;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------- fixtures

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "nx-dc-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
    d
}

struct Member<'a> {
    path: &'a str,
    typ: u8,
    data: &'a [u8],
    link: &'a str,
}

fn file<'a>(path: &'a str, data: &'a [u8]) -> Member<'a> {
    Member {
        path,
        typ: b'0',
        data,
        link: "",
    }
}

fn tar(members: &[Member]) -> Vec<u8> {
    let mut out = Vec::new();
    for m in members {
        let mut h = [0u8; 512];
        let name = m.path.as_bytes();
        let (prefix, base) = if name.len() > 100 {
            let cut = name[..name.len().min(155)]
                .iter()
                .rposition(|b| *b == b'/')
                .unwrap();
            (&name[..cut], &name[cut + 1..])
        } else {
            (&name[..0], name)
        };
        h[..base.len()].copy_from_slice(base);
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", m.data.len()).as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[148..156].copy_from_slice(b"        ");
        h[156] = m.typ;
        h[157..157 + m.link.len()].copy_from_slice(m.link.as_bytes());
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[345..345 + prefix.len()].copy_from_slice(prefix);
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        h[148..156].copy_from_slice(format!("{:06o}\0 ", sum).as_bytes());
        out.extend_from_slice(&h);
        out.extend_from_slice(m.data);
        out.extend(std::iter::repeat_n(0, (512 - m.data.len() % 512) % 512));
    }
    out.extend(std::iter::repeat_n(0, 1024));
    out
}

fn gz(raw: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(raw).unwrap();
    e.finish().unwrap()
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn good_crate(name: &str, ver: &str) -> Vec<u8> {
    let top = format!("{name}-{ver}");
    let toml = format!("[package]\nname = \"{name}\"\nversion = \"{ver}\"\n");
    let p1 = format!("{top}/Cargo.toml");
    let p2 = format!("{top}/src/lib.rs");
    gz(&tar(&[
        file(&p1, toml.as_bytes()),
        file(&p2, b"pub fn f() {}\n"),
    ]))
}

fn cache(tag: &str) -> (PathBuf, DepCache) {
    let d = tmp(tag).join("cache");
    let c = DepCache::open(&d, true, CacheQuota::default()).unwrap();
    (d, c)
}

fn lock_for(pkgs: &[(&str, &str, &str)]) -> String {
    let mut s = String::from("version = 4\n\n");
    for (n, v, c) in pkgs {
        s.push_str(&format!(
            "[[package]]\nname = \"{n}\"\nversion = \"{v}\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"{c}\"\n\n"
        ));
    }
    s
}

fn objects(c: &Path) -> Vec<String> {
    let mut v: Vec<_> = std::fs::read_dir(c.join("objects"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn assert_nothing_published(c: &Path) {
    assert!(objects(c).is_empty(), "objects present: {:?}", objects(c));
}

// ------------------------------------------------------------- happy

#[test]
fn admission_verifies_and_is_idempotent() {
    let (root, c) = cache("happy");
    let bytes = good_crate("alpha", "1.2.3");
    let digest = sha(&bytes);
    assert_eq!(
        c.admit("alpha", "1.2.3", &digest, &bytes, "t").unwrap(),
        Admitted::Created
    );
    assert_eq!(
        c.admit("alpha", "1.2.3", &digest, &bytes, "t").unwrap(),
        Admitted::Identical
    );
    let prov = c.verify_object(&digest).unwrap();
    assert_eq!(
        (prov.name.as_str(), prov.version.as_str()),
        ("alpha", "1.2.3")
    );
    assert_eq!(c.stats().objects, 1);
    // Sealed read-only.
    let f = root
        .join("objects")
        .join(&digest)
        .join("crate/alpha-1.2.3.crate");
    assert_eq!(
        std::fs::metadata(&f).unwrap().permissions().mode() & 0o222,
        0
    );
}

#[test]
fn materialized_view_is_exact_and_uses_lockfile_checksums() {
    let (_r, c) = cache("mat");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let line = format!(
        r#"{{"name":"alpha","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    c.admit_index_entry("alpha", "1.0.0", &d, &line).unwrap();
    let lock = parse_cargo_lock(&lock_for(&[("alpha", "1.0.0", &d)])).unwrap();
    let dest = tmp("matview").join("vendor");
    let rep = c.materialize(&lock, &dest).unwrap();
    assert_eq!(rep.packages, 1);
    assert!(dest.join("alpha-1.0.0.crate").is_file());
    let idx = std::fs::read_to_string(dest.join("index/al/ph/alpha")).unwrap();
    assert!(idx.contains(&d));
}

// ------------------------------------------------------- admission

#[test]
fn checksum_mismatch_is_rejected_and_nothing_is_published() {
    let (r, c) = cache("cks");
    let b = good_crate("alpha", "1.0.0");
    let wrong = sha(b"something else");
    let e = c.admit("alpha", "1.0.0", &wrong, &b, "t").unwrap_err();
    assert_eq!(e.code, "checksum-mismatch");
    assert_nothing_published(&r);
}

fn rejects(tag: &str, code: &str, raw: Vec<u8>) {
    let (r, c) = cache(tag);
    let b = gz(&raw);
    let e = c.admit("alpha", "1.0.0", &sha(&b), &b, "t").unwrap_err();
    assert_eq!(e.code, code, "{tag}: {e}");
    assert_nothing_published(&r);
}

#[test]
fn malicious_archives_are_refused() {
    let toml = b"[package]\n";
    rejects(
        "trav",
        "archive-path",
        tar(&[
            file("alpha-1.0.0/Cargo.toml", toml),
            file("alpha-1.0.0/../../evil", b"x"),
        ]),
    );
    rejects("abs", "archive-path", tar(&[file("/etc/passwd", b"x")]));
    rejects(
        "top",
        "archive-path",
        tar(&[file("other-9.9.9/Cargo.toml", toml)]),
    );
    rejects(
        "bslash",
        "archive-path",
        tar(&[file("alpha-1.0.0\\evil", b"x")]),
    );
    rejects(
        "dupe",
        "archive-path",
        tar(&[
            file("alpha-1.0.0/Cargo.toml", toml),
            file("alpha-1.0.0/A", b"1"),
            file("alpha-1.0.0/a", b"2"),
        ]),
    );
    rejects(
        "sym",
        "archive-link",
        tar(&[
            file("alpha-1.0.0/Cargo.toml", toml),
            Member {
                path: "alpha-1.0.0/link",
                typ: b'2',
                data: b"",
                link: "/etc/shadow",
            },
        ]),
    );
    rejects(
        "hard",
        "archive-link",
        tar(&[
            file("alpha-1.0.0/Cargo.toml", toml),
            Member {
                path: "alpha-1.0.0/h",
                typ: b'1',
                data: b"",
                link: "alpha-1.0.0/Cargo.toml",
            },
        ]),
    );
    rejects(
        "dev",
        "archive-type",
        tar(&[
            file("alpha-1.0.0/Cargo.toml", toml),
            Member {
                path: "alpha-1.0.0/null",
                typ: b'3',
                data: b"",
                link: "",
            },
        ]),
    );
    rejects(
        "nomanifest",
        "archive-shape",
        tar(&[file("alpha-1.0.0/src/lib.rs", b"x")]),
    );
    rejects("empty", "archive-empty", tar(&[]));
}

#[test]
fn truncated_or_garbage_archives_are_refused() {
    let (r, c) = cache("garb");
    let g = b"this is not gzip".to_vec();
    assert!(c.admit("alpha", "1.0.0", &sha(&g), &g, "t").is_err());
    let full = good_crate("alpha", "1.0.0");
    let cut = full[..full.len() / 2].to_vec();
    assert!(c.admit("alpha", "1.0.0", &sha(&cut), &cut, "t").is_err());
    assert_nothing_published(&r);
}

#[test]
fn decompression_bomb_is_bounded() {
    let d = tmp("bomb").join("cache");
    let q = CacheQuota {
        max_unpacked_bytes: 64 * 1024,
        ..Default::default()
    };
    let c = DepCache::open(&d, true, q).unwrap();
    let big = vec![b'a'; 4 * 1024 * 1024];
    let b = gz(&tar(&[
        file("alpha-1.0.0/Cargo.toml", b"[package]\n"),
        file("alpha-1.0.0/big", &big),
    ]));
    let e = c.admit("alpha", "1.0.0", &sha(&b), &b, "t").unwrap_err();
    assert_eq!(e.code, "quota");
    assert_nothing_published(&d);
}

#[test]
fn object_count_and_total_size_quotas_fail_closed() {
    let d = tmp("quota").join("cache");
    let q = CacheQuota {
        max_objects: 1,
        ..Default::default()
    };
    let c = DepCache::open(&d, true, q).unwrap();
    let a = good_crate("alpha", "1.0.0");
    let b = good_crate("beta", "1.0.0");
    c.admit("alpha", "1.0.0", &sha(&a), &a, "t").unwrap();
    let e = c.admit("beta", "1.0.0", &sha(&b), &b, "t").unwrap_err();
    assert_eq!(e.code, "quota");
    assert_eq!(c.stats().objects, 1);
}

#[test]
fn unsafe_package_identity_is_refused() {
    let (_r, c) = cache("ident");
    let b = good_crate("alpha", "1.0.0");
    for n in ["../x", "a/b", "", ".hidden", "a b"] {
        assert!(c.admit(n, "1.0.0", &sha(&b), &b, "t").is_err(), "{n}");
    }
    assert!(parse_cargo_lock(&lock_for(&[("../etc", "1.0.0", &sha(b"x"))])).is_err());
}

// ---------------------------------------------- poisoning / integrity

#[test]
fn tampered_object_is_detected_and_run_fails_closed() {
    let (r, c) = cache("tamper");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let line = format!(
        r#"{{"name":"alpha","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    c.admit_index_entry("alpha", "1.0.0", &d, &line).unwrap();
    // Attacker with filesystem access replaces the archive in place.
    let dir = r.join("objects").join(&d).join("crate");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let f = dir.join("alpha-1.0.0.crate");
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&f, good_crate("alpha", "6.6.6")).unwrap();
    assert_eq!(c.verify_object(&d).unwrap_err().code, "cache-corrupt");
    assert_eq!(c.verify_all().1.len(), 1);
    let lock = parse_cargo_lock(&lock_for(&[("alpha", "1.0.0", &d)])).unwrap();
    let e = c
        .materialize(&lock, &tmp("tamperview").join("v"))
        .unwrap_err();
    assert_eq!(e.code, "cache-corrupt");
}

#[test]
fn extra_file_added_to_object_is_detected() {
    let (r, c) = cache("extra");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let dir = r.join("objects").join(&d).join("crate");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.join("evil.crate"), b"x").unwrap();
    assert_eq!(c.verify_object(&d).unwrap_err().code, "cache-corrupt");
}

#[test]
fn symlinked_object_member_is_refused() {
    let (r, c) = cache("symobj");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let dir = r.join("objects").join(&d).join("crate");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let f = dir.join("alpha-1.0.0.crate");
    std::fs::remove_file(&f).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", &f).unwrap();
    assert_eq!(c.verify_object(&d).unwrap_err().code, "cache-corrupt");
}

#[test]
fn a_different_object_can_never_replace_an_admitted_one() {
    let (_r, c) = cache("replace");
    let a = good_crate("alpha", "1.0.0");
    let d = sha(&a);
    c.admit("alpha", "1.0.0", &d, &a, "t").unwrap();
    // Same claimed checksum, different bytes: refused by the checksum gate.
    let evil = good_crate("alpha", "1.0.0-evil");
    assert_eq!(
        c.admit("alpha", "1.0.0", &d, &evil, "t").unwrap_err().code,
        "checksum-mismatch"
    );
    c.verify_object(&d).unwrap();
}

#[test]
fn index_entry_must_match_lockfile_and_is_immutable() {
    let (_r, c) = cache("idx");
    let d = sha(b"x");
    let good = format!(
        r#"{{"name":"alpha","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    let bad_name = good.replace("alpha", "beta");
    let bad_ck = good.replace(&d, &sha(b"y"));
    assert!(c
        .admit_index_entry("alpha", "1.0.0", &d, &bad_name)
        .is_err());
    assert!(c.admit_index_entry("alpha", "1.0.0", &d, &bad_ck).is_err());
    assert!(c
        .admit_index_entry("alpha", "1.0.0", &d, "{not json")
        .is_err());
    assert!(c
        .admit_index_entry("alpha", "1.0.0", &d, &format!("{good}\n{good}"))
        .is_err());
    c.admit_index_entry("alpha", "1.0.0", &d, &good).unwrap();
    let altered = good.replace(r#""deps":[]"#, r#""deps":[{"name":"evil"}]"#);
    assert!(c.admit_index_entry("alpha", "1.0.0", &d, &altered).is_err());
}

// ------------------------------------------------- lockfile policy

#[test]
fn wrong_or_unknown_lockfile_fails_closed_listing_packages() {
    let (_r, c) = cache("wronglock");
    let d = sha(b"never admitted");
    let lock = parse_cargo_lock(&lock_for(&[("ghost", "0.1.0", &d)])).unwrap();
    let e = c.materialize(&lock, &tmp("wl").join("v")).unwrap_err();
    assert_eq!(e.code, "dependency-unavailable");
    assert!(e.message.contains("ghost-0.1.0"));
}

#[test]
fn git_and_alternate_registries_are_unsupported() {
    let text = "version = 4\n[[package]]\nname = \"g\"\nversion = \"0.1.0\"\nsource = \"git+https://example.com/g\"\n\n[[package]]\nname = \"r\"\nversion = \"0.1.0\"\nsource = \"registry+https://evil.example/index\"\nchecksum = \"".to_owned() + &sha(b"r") + "\"\n";
    let lock = parse_cargo_lock(&text).unwrap();
    assert_eq!(lock.unsupported.len(), 2);
    let (_r, c) = cache("unsup");
    assert_eq!(
        c.materialize(&lock, &tmp("u").join("v")).unwrap_err().code,
        "dependency-unavailable"
    );
}

#[test]
fn registry_package_without_checksum_is_rejected() {
    let t = "version = 4\n[[package]]\nname = \"a\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
    assert_eq!(parse_cargo_lock(t).unwrap_err().code, "lockfile-invalid");
}

// ---------------------------------------- concurrency / interruption

#[test]
fn concurrent_population_converges_on_one_verified_object() {
    let (r, c) = cache("conc");
    let b = std::sync::Arc::new(good_crate("alpha", "1.0.0"));
    let d = sha(&b);
    let mut hs = Vec::new();
    for _ in 0..8 {
        let (c, b, d) = (c.clone(), b.clone(), d.clone());
        hs.push(std::thread::spawn(move || {
            c.admit("alpha", "1.0.0", &d, &b, "t")
        }));
    }
    let results: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(results.iter().all(|r| r.is_ok()), "{results:?}");
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == Ok(Admitted::Created))
            .count(),
        1
    );
    assert_eq!(objects(&r), vec![d.clone()]);
    c.verify_object(&d).unwrap();
}

#[test]
fn interrupted_admission_is_never_visible_and_is_collected() {
    let (r, c) = cache("intr");
    // Simulate a crash mid-population: a half-built staging directory.
    let st = r.join("objects").join(".tmp-deadbeefdeadbeef");
    std::fs::create_dir_all(st.join("crate")).unwrap();
    std::fs::write(st.join("crate/partial.crate"), b"half").unwrap();
    assert_eq!(c.stats().objects, 0);
    assert_eq!(c.stats().stale_staging, 1);
    let lock = parse_cargo_lock(&lock_for(&[("alpha", "1.0.0", &sha(b"a"))])).unwrap();
    assert!(c.materialize(&lock, &tmp("intrv").join("v")).is_err());
    assert_eq!(c.gc_staging(), 0, "fresh staging must not be collected");
    assert_eq!(c.gc_staging_older_than(0), 1);
    assert_eq!(c.stats().stale_staging, 0);
}

// ------------------------------------------------------ cache root

#[test]
fn cache_root_must_be_private_real_and_versioned() {
    let base = tmp("root");
    let open = |p: &Path| DepCache::open(p, false, CacheQuota::default());
    // group/other accessible
    let loose = base.join("loose");
    std::fs::create_dir(&loose).unwrap();
    std::fs::write(loose.join("VERSION"), "nexus-depcache/1\n").unwrap();
    std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(open(&loose).unwrap_err().code, "cache-root");
    // symlink root
    let real = base.join("real");
    DepCache::open(&real, true, CacheQuota::default()).unwrap();
    let link = base.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(open(&link).unwrap_err().code, "cache-root");
    // relative path
    assert_eq!(open(Path::new("relative")).unwrap_err().code, "cache-root");
    // wrong version
    std::fs::write(real.join("VERSION"), "nexus-depcache/999\n").unwrap();
    assert_eq!(open(&real).unwrap_err().code, "cache-version");
    // uninitialised
    let empty = base.join("empty");
    std::fs::create_dir(&empty).unwrap();
    std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(open(&empty).unwrap_err().code, "cache-version");
}

#[test]
fn integrity_survives_reopen() {
    let (r, c) = cache("reopen");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    drop(c);
    let c2 = DepCache::open(&r, false, CacheQuota::default()).unwrap();
    assert_eq!(c2.verify_all().0, 1);
    assert_eq!(c2.list()[0].name, "alpha");
}

#[test]
fn bulk_admission_reports_missing_and_rejected_without_partial_trust() {
    let (_r, c) = cache("bulk");
    let src = tmp("bulksrc");
    let good = good_crate("alpha", "1.0.0");
    std::fs::write(src.join("alpha-1.0.0.crate"), &good).unwrap();
    // beta's file is present but corrupt relative to the lockfile checksum.
    let beta = good_crate("beta", "1.0.0");
    std::fs::write(src.join("beta-1.0.0.crate"), &beta).unwrap();
    let lock = parse_cargo_lock(&lock_for(&[
        ("alpha", "1.0.0", &sha(&good)),
        ("beta", "1.0.0", &sha(b"not the real checksum")),
        ("gamma", "1.0.0", &sha(b"absent")),
    ]))
    .unwrap();
    let rep = c.admit_from_dir(&src, None, &lock, "t");
    assert_eq!(rep.created, vec!["alpha-1.0.0"]);
    assert_eq!(rep.rejected.len(), 1);
    assert_eq!(rep.missing, vec!["gamma-1.0.0"]);
    assert!(!rep.complete());
    assert_eq!(c.stats().objects, 1);
}

#[test]
fn index_entry_swapped_after_admission_is_refused_at_use() {
    let (r, c) = cache("idxswap");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let line = format!(
        r#"{{"name":"alpha","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    c.admit_index_entry("alpha", "1.0.0", &d, &line).unwrap();
    let lock = parse_cargo_lock(&lock_for(&[("alpha", "1.0.0", &d)])).unwrap();
    let f = r.join("index").join(format!("{d}.json"));
    // Same-UID attacker rewrites the dependency list.
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(
        &f,
        line.replace(r#""deps":[]"#, r#""deps":[{"name":"evil"}]"#)
            .replace("alpha", "beta"),
    )
    .unwrap();
    let e = c
        .materialize(&lock, &tmp("idxswapv").join("v"))
        .unwrap_err();
    assert_eq!(e.code, "cache-corrupt");
    // Symlinked entry is refused too.
    std::fs::remove_file(&f).unwrap();
    std::os::unix::fs::symlink("/etc/hostname", &f).unwrap();
    assert!(c.materialize(&lock, &tmp("idxswapv2").join("v")).is_err());
}

#[test]
fn materialized_view_matches_checksum_and_symlinked_object_is_not_followed() {
    let (r, c) = cache("viewhash");
    let b = good_crate("alpha", "1.0.0");
    let d = sha(&b);
    c.admit("alpha", "1.0.0", &d, &b, "t").unwrap();
    let line = format!(
        r#"{{"name":"alpha","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    c.admit_index_entry("alpha", "1.0.0", &d, &line).unwrap();
    let lock = parse_cargo_lock(&lock_for(&[("alpha", "1.0.0", &d)])).unwrap();
    let dest = tmp("viewhashv").join("v");
    c.materialize(&lock, &dest).unwrap();
    assert_eq!(
        sha(&std::fs::read(dest.join("alpha-1.0.0.crate")).unwrap()),
        d
    );
    // Replace the object file with a symlink to a same-content file:
    // content matches, but a symlink is never accepted.
    let dir = r.join("objects").join(&d).join("crate");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let f = dir.join("alpha-1.0.0.crate");
    let outside = tmp("outside").join("same.crate");
    std::fs::write(&outside, &b).unwrap();
    std::fs::remove_file(&f).unwrap();
    std::os::unix::fs::symlink(&outside, &f).unwrap();
    assert!(c.verify_object(&d).is_err());
    assert!(c.materialize(&lock, &tmp("viewhashv2").join("v")).is_err());
}
