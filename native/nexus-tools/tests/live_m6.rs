//! M6C live Internet acceptance — ONLY with explicit owner approval of the exact destinations.
//! Skipped (prints NOT RUN) unless `NEXUS_LIVE_M6=1`. Owner-approved hosts (2026-10-27):
//! registry.npmjs.org:443, index.crates.io:443, static.crates.io:443, github.com:443.
//! Everything runs in a disposable fixture project under a Controlled Internet grant through
//! the real egress gatekeeper; no other destination is allowed, and none may be added by the
//! commands themselves.

mod common;

use common::*;
use nexus_tools::grant::ExecPolicy;
use nexus_tools::netpolicy::{HostRule, NetPolicy};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_full, CancellationToken};
use serde_json::json;
use std::path::Path;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn live_policy() -> NetPolicy {
    NetPolicy {
        hosts: [
            "registry.npmjs.org",
            "index.crates.io",
            "static.crates.io",
            "github.com",
        ]
        .iter()
        .map(|h| HostRule {
            host: (*h).into(),
            ports: vec![443],
        })
        .collect(),
        local_ports: vec![],
    }
}

fn run(
    fx: &mut Fx,
    program: &str,
    args: serde_json::Value,
    net: Option<NetPolicy>,
) -> nexus_tools::ToolExecutionOutcome {
    run_exec(fx, program, args, net, None)
}

fn run_exec(
    fx: &mut Fx,
    program: &str,
    args: serde_json::Value,
    net: Option<NetPolicy>,
    exec: Option<ExecPolicy>,
) -> nexus_tools::ToolExecutionOutcome {
    fx.approve_process_fs(300_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": program, "args": args, "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol).expect("prepare");
    let call = authorize(&mut fx.kernel, p).expect("authorize");
    let run_dir = fx.dir.path().join(format!(
        "exec-live-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    execute_process_full(
        &mut fx.kernel,
        &call,
        &cancel,
        &pol,
        &run_dir,
        300_000,
        None,
        net,
        exec,
    )
    .expect("execute")
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
fn m6c_live_internet_acceptance_against_owner_approved_destinations() {
    if std::env::var("NEXUS_LIVE_M6").as_deref() != Ok("1") {
        println!("NOT RUN (live): NEXUS_LIVE_M6 != 1 — owner approval + this flag are required");
        return;
    }
    let c = nexus_tools::sandbox::preflight();
    if !c.available || nexus_tools::confine_host::locate_egress().is_none() {
        println!(
            "NOT RUN (live): sandbox/egress unavailable: {:?}",
            c.problems
        );
        return;
    }
    let net = live_policy();
    let mut fx = fixture("m6c-live");

    // 1. npm dependency installation from the real registry (real certs, CDN).
    fx.write(
        "package.json",
        b"{\"name\":\"m6live\",\"version\":\"1.0.0\",\"dependencies\":{\"is-odd\":\"3.0.1\"}}\n",
    );
    let t0 = std::time::Instant::now();
    let o = run(
        &mut fx,
        "npm",
        json!(["install", "--no-audit", "--no-fund"]),
        Some(net.clone()),
    );
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "npm install: {}", text(&v));
    assert!(
        fx.ws.join("node_modules/is-odd/index.js").exists(),
        "is-odd was installed"
    );
    assert!(fx.ws.join("package-lock.json").exists());
    println!("live npm install: {} ms", t0.elapsed().as_millis());

    // pnpm: not installed on this host — recorded, not silently substituted.
    if !Path::new("/usr/bin/pnpm").exists() {
        println!("live pnpm install: NOT TESTED (pnpm is not installed on this host)");
    }

    // 2. Cargo dependency fetching from the real sparse index + CDN.
    fx.write(
        "Cargo.toml",
        b"[package]\nname = \"m6live\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nitoa = \"1\"\n",
    );
    fx.write(
        "src/lib.rs",
        b"pub fn f() -> String { itoa::Buffer::new().format(42).to_owned() }\n",
    );
    let t0 = std::time::Instant::now();
    let o = run(&mut fx, "cargo", json!(["fetch"]), Some(net.clone()));
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "cargo fetch: {}", text(&v));
    let lock = fx.disk("Cargo.lock").unwrap_or_default();
    assert!(lock.contains("itoa"), "lockfile names itoa: {lock}");
    println!("live cargo fetch: {} ms", t0.elapsed().as_millis());

    // 3. HTTPS Git clone + fetch from the real github.com.
    let t0 = std::time::Instant::now();
    let o = run(
        &mut fx,
        "git",
        json!([
            "clone",
            "--depth",
            "1",
            "https://github.com/octocat/Hello-World.git",
            "cloned"
        ]),
        Some(net.clone()),
    );
    let v = out(&o);
    assert_eq!(v["verification"], "pass", "git clone: {}", text(&v));
    assert!(
        fx.ws.join("cloned/README").exists(),
        "clone content present"
    );
    // fetch writes FETCH_HEAD/refs: it runs under the explicit Git-write grant (M6B)
    let gw = Some(ExecPolicy {
        git_write: true,
        ..Default::default()
    });
    let o = run_exec(
        &mut fx,
        "sh",
        json!(["-c", "git -C cloned fetch origin && echo fetch-ok"]),
        Some(net.clone()),
        gw.clone(),
    );
    assert!(text(&out(&o)).contains("fetch-ok"), "{}", text(&out(&o)));
    println!("live git clone+fetch: {} ms", t0.elapsed().as_millis());

    // 4. A destination outside the grant is denied, actionably, and nothing expands the grant:
    //    the same commands afterwards still only reach the four approved hosts.
    let o = run(
        &mut fx,
        "sh",
        json!([
            "-c",
            "curl -sS -o /dev/null -w '%{http_code}' https://example.com/ ; echo curl-rc=$?"
        ]),
        Some(net.clone()),
    );
    let v = out(&o);
    let t = text(&v);
    assert!(
        !t.contains("curl-rc=0") && !t.contains("200"),
        "example.com must not be reached under this grant: {t}"
    );
    println!("live denial evidence: {}", t.trim());
    // the approved set is unchanged after the denial (no automatic expansion)
    let o = run(
        &mut fx,
        "git",
        json!(["-C", "cloned", "status", "--porcelain"]),
        Some(net.clone()),
    );
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
}
