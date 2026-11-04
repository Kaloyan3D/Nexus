//! A3.5: real dependency-bearing cargo runs through the A3.4 sandbox using
//! the verified offline cache. Prints `NOT RUN` when the sandbox or the
//! Rust toolchain is unavailable (never a PASS claim).

use flate2::{write::GzEncoder, Compression};
use nexus_tools::depcache::*;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static SERIAL: Mutex<()> = Mutex::new(());

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "nx-dcp-{tag}-{}-{}",
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

fn tar(members: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (path, data) in members {
        let mut h = [0u8; 512];
        h[..path.len()].copy_from_slice(path.as_bytes());
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[148..156].copy_from_slice(b"        ");
        h[156] = b'0';
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        h[148..156].copy_from_slice(format!("{:06o}\0 ", sum).as_bytes());
        out.extend_from_slice(&h);
        out.extend_from_slice(data);
        out.extend(std::iter::repeat_n(0, (512 - data.len() % 512) % 512));
    }
    out.extend(std::iter::repeat_n(0, 1024));
    out
}

fn krate(name: &str, ver: &str, lib: &str, build: Option<&str>) -> Vec<u8> {
    let top = format!("{name}-{ver}");
    let toml = format!(
        "[package]\nname = \"{name}\"\nversion = \"{ver}\"\nedition = \"2021\"\n{}",
        if build.is_some() {
            "build = \"build.rs\"\n"
        } else {
            ""
        }
    );
    let (a, b, c) = (
        format!("{top}/Cargo.toml"),
        format!("{top}/src/lib.rs"),
        format!("{top}/build.rs"),
    );
    let mut m: Vec<(&str, &[u8])> = vec![(&a, toml.as_bytes()), (&b, lib.as_bytes())];
    if let Some(bs) = build {
        m.push((&c, bs.as_bytes()));
    }
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(&tar(&m)).unwrap();
    e.finish().unwrap()
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

struct Fx {
    cache_dir: PathBuf,
    cache: DepCache,
    ws: PathBuf,
}

fn fixture(tag: &str, dep_ver_in_lock: &str, krate_bytes: &[u8], admit: bool) -> Fx {
    let base = tmp(tag);
    let cache_dir = base.join("cache");
    let cache = DepCache::open(&cache_dir, true, CacheQuota::default()).unwrap();
    let d = sha(krate_bytes);
    if admit {
        cache
            .admit("depa", "1.0.0", &d, krate_bytes, "test")
            .unwrap();
    }
    let idx = format!(
        r#"{{"name":"depa","vers":"1.0.0","deps":[],"cksum":"{d}","features":{{}},"yanked":false}}"#
    );
    if admit {
        cache.admit_index_entry("depa", "1.0.0", &d, &idx).unwrap();
    }
    let ws = base.join("ws");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::write(ws.join(".nexus-offline-process-test"), "").unwrap();
    std::fs::write(
        ws.join("Cargo.toml"),
        "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[dependencies]\ndepa = \"1.0.0\"\n",
    )
    .unwrap();
    std::fs::write(
        ws.join("src/lib.rs"),
        "pub fn g() -> u32 { depa::f() + 1 }\n",
    )
    .unwrap();
    std::fs::write(
        ws.join("Cargo.lock"),
        format!(
            "version = 4\n\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"depa\",\n]\n\n[[package]]\nname = \"depa\"\nversion = \"{dep_ver_in_lock}\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"{d}\"\n"
        ),
    )
    .unwrap();
    Fx {
        cache_dir,
        cache,
        ws,
    }
}

fn run(fx: &Fx, args: &[&str]) -> Option<serde_json::Value> {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || !nexus_tools::process::Toolchain::discover()
            .cargo_home_bin
            .is_some()
    {
        println!(
            "NOT RUN: sandbox or cargo toolchain unavailable: {:?}",
            c.problems
        );
        return None;
    }
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("NEXUS_TOOLS_OFFLINE_TEST", "1");
    std::env::set_var("NEXUS_TOOLS_OFFLINE_PROCESS_TEST", "1");
    let v = nexus_tools::offline::run_offline_process(
        fx.ws.to_str().unwrap(),
        "cargo",
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        240_000,
        Some(Path::new(&fx.cache_dir)),
    )
    .expect("offline run");
    Some(v)
}

fn status(v: &serde_json::Value) -> String {
    v["result"]["status"].as_str().unwrap_or("").to_owned()
}

#[test]
fn dependency_bearing_cargo_check_and_test_run_offline() {
    let k = krate(
        "depa",
        "1.0.0",
        "pub fn f() -> u32 { 41 }\n#[test] fn t() { assert_eq!(f(), 41); }\n",
        None,
    );
    let fx = fixture("ok", "1.0.0", &k, true);
    let Some(v) = run(&fx, &["check", "--offline", "--locked"]) else {
        return;
    };
    let out = &v["result"]["output"];
    assert_eq!(status(&v), "ok", "{v}");
    assert_eq!(out["exitCode"], 0, "{}", out["stderr"]);
    assert_eq!(out["network"], "none");
    assert!(out["stderr"].as_str().unwrap().contains("depa v1.0.0"));
    let Some(v) = run(&fx, &["test", "--offline", "--locked"]) else {
        return;
    };
    assert_eq!(
        v["result"]["output"]["exitCode"], 0,
        "{}",
        v["result"]["output"]["stderr"]
    );
    // The host cache is untouched by either run.
    assert_eq!(fx.cache.verify_all().1.len(), 0);
    // And nothing was written back to the workspace.
    assert!(!fx.ws.join("target").exists());
}

#[test]
fn missing_dependency_fails_closed_before_any_process_starts() {
    let k = krate("depa", "1.0.0", "pub fn f() -> u32 { 1 }\n", None);
    let fx = fixture("missing", "1.0.0", &k, false);
    let Some(v) = run(&fx, &["check", "--offline", "--locked"]) else {
        return;
    };
    assert_eq!(status(&v), "error");
    assert_eq!(v["result"]["error"]["code"], "dependency-unavailable");
    let phases = v["journalPhases"].to_string();
    assert!(
        !phases.contains("spawned") && !phases.contains("completed"),
        "{phases}"
    );
}

#[test]
fn poisoned_cache_object_fails_closed() {
    let k = krate("depa", "1.0.0", "pub fn f() -> u32 { 1 }\n", None);
    let fx = fixture("poison", "1.0.0", &k, true);
    let d = sha(&k);
    let dir = fx.cache_dir.join("objects").join(&d).join("crate");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let f = dir.join("depa-1.0.0.crate");
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(
        &f,
        krate("depa", "1.0.0", "pub fn f() -> u32 { 666 }\n", None),
    )
    .unwrap();
    let Some(v) = run(&fx, &["check", "--offline", "--locked"]) else {
        return;
    };
    assert_eq!(
        v["result"]["error"]["code"], "dependency-unavailable",
        "{v}"
    );
    assert!(v["result"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("cache-corrupt"));
}

#[test]
fn lockfile_version_absent_from_cache_fails_closed() {
    let k = krate("depa", "1.0.0", "pub fn f() -> u32 { 1 }\n", None);
    let fx = fixture("stale", "9.9.9", &k, true);
    // Lock now names depa 9.9.9 with the 1.0.0 checksum: no index entry
    // for that identity exists (stale / wrong lockfile).
    let Some(v) = run(&fx, &["check", "--offline", "--locked"]) else {
        return;
    };
    assert_eq!(
        v["result"]["error"]["code"], "dependency-unavailable",
        "{v}"
    );
}

#[test]
fn hostile_build_script_cannot_mutate_cache_view_reach_network_or_read_host_creds() {
    // The dependency's build.rs runs inside the sandbox. It tries to
    // mutate the vendor view, create files in the cache location it can
    // see, open a network socket, and read host credentials. Any success
    // is surfaced as a build failure carrying a marker.
    let build = r#"
use std::net::TcpStream;
fn main() {
    let mut bad = Vec::new();
    if std::fs::write("/work/vendor/pwned", b"x").is_ok() { bad.push("write-vendor"); }
    if std::fs::remove_file("/work/vendor/depa-1.0.0.crate").is_ok() { bad.push("remove-crate"); }
    if std::fs::write("/work/out/cargo-home/config.toml", b"x").is_ok() { bad.push("overwrite-config"); }
    if TcpStream::connect("1.1.1.1:80").is_ok() { bad.push("network"); }
    for p in ["/home", "/root", "/etc/shadow", "/root/.ssh", "/work/out/cargo-home/credentials.toml"] {
        if std::fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false) || std::fs::read(p).is_ok() {
            bad.push("host-path");
        }
    }
    if std::env::var("HOME").map(|h| h != "/work/out/home").unwrap_or(true) { bad.push("home-env"); }
    for k in ["SSH_AUTH_SOCK", "CARGO_REGISTRY_TOKEN", "AWS_SECRET_ACCESS_KEY"] {
        if std::env::var(k).is_ok() { bad.push("cred-env"); }
    }
    if !bad.is_empty() { panic!("ESCAPE:{}", bad.join(",")); }
}
"#;
    let k = krate("depa", "1.0.0", "pub fn f() -> u32 { 1 }\n", Some(build));
    let fx = fixture("hostile", "1.0.0", &k, true);
    std::env::set_var("SSH_AUTH_SOCK", "/tmp/should-not-leak");
    std::env::set_var("CARGO_REGISTRY_TOKEN", "should-not-leak");
    let Some(v) = run(&fx, &["check", "--offline", "--locked"]) else {
        return;
    };
    let out = &v["result"]["output"];
    assert_eq!(
        out["exitCode"], 0,
        "build script observed an escape: {}",
        out["stderr"]
    );
    assert_eq!(fx.cache.verify_all().1.len(), 0);
    assert!(fx
        .cache_dir
        .join("objects")
        .join(sha(&k))
        .join("crate")
        .join("depa-1.0.0.crate")
        .is_file());
}
