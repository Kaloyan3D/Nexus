//! M5C: real package managers and clients through Controlled Internet. Registries and a git host are local
//! fixtures reached through the real egress service from a real sandbox; behaviour is observed, not assumed.

use nexus_tools::egress_host::EgressSettings;
use nexus_tools::netpolicy::{HostRule, NetPolicy};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_net, CancellationToken};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

mod common;
use common::*;

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || c.landlock_abi.is_none()
        || !c.launch_gate
        || nexus_tools::confine_host::locate_egress().is_none()
        || !Path::new("/usr/bin/python3").exists()
    {
        println!("NOT RUN ({t}): sandbox/Landlock/launch gate/egress/python unavailable");
        return false;
    }
    true
}

struct Fixtures {
    _dir: tempfile::TempDir,
    children: Vec<Child>,
    port: u16,
    tls_port: u16,
    ca: PathBuf,
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        for c in &mut self.children {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn py() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/m5_fixtures.py")
}

fn wait_port(f: &Path) -> u16 {
    for _ in 0..300 {
        if let Ok(t) = std::fs::read_to_string(f) {
            if let Ok(p) = t.trim().parse() {
                return p;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("fixture server did not start");
}

fn fixtures() -> Fixtures {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    assert!(Command::new("python3")
        .arg(py())
        .arg("build")
        .arg(&root)
        .status()
        .unwrap()
        .success());
    let pf = dir.path().join("port");
    let c1 = Command::new("python3")
        .arg(py())
        .arg("serve")
        .arg(&root)
        .arg(&pf)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let port = wait_port(&pf);
    // a TLS server (self-signed) for the CONNECT tunnel
    let (cert, key) = (dir.path().join("c.pem"), dir.path().join("k.pem"));
    assert!(Command::new("openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .args([
            "-days",
            "1",
            "-subj",
            "/CN=secure.fixture-tls.org",
            "-addext",
            "subjectAltName=DNS:secure.fixture-tls.org"
        ])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let pf2 = dir.path().join("port2");
    let c2 = Command::new("python3")
        .arg(py())
        .arg("tls")
        .arg(&root)
        .arg(&pf2)
        .arg(&cert)
        .arg(&key)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let tls_port = wait_port(&pf2);
    Fixtures {
        ca: cert,
        _dir: dir,
        children: vec![c1, c2],
        port,
        tls_port,
    }
}

const NAMES: [(&str, &str); 5] = [
    ("registry.npm-fixture.org", "8.8.4.4"),
    ("pypi.fixture-py.org", "8.8.4.5"),
    ("index.crates-fixture.org", "8.8.4.6"),
    ("git.fixture-git.org", "8.8.4.7"),
    ("secure.fixture-tls.org", "8.8.4.8"),
];

fn net_for(f: &Fixtures, allow: &[&str]) -> (NetPolicy, CommandPolicy) {
    let mut e = EgressSettings::default();
    for (h, ip) in NAMES {
        e.test_resolve.insert(h.into(), ip.into());
        let (port, target) = if h.starts_with("secure") {
            (443, f.tls_port)
        } else {
            (80, f.port)
        };
        e.test_connect
            .insert(format!("{ip}:{port}"), format!("127.0.0.1:{target}"));
    }
    let pol = NetPolicy {
        hosts: allow
            .iter()
            .map(|h| HostRule {
                host: (*h).into(),
                ports: vec![if h.starts_with("secure") { 443 } else { 80 }],
            })
            .collect(),
        local_ports: vec![],
    };
    (
        pol,
        CommandPolicy::standard(Toolchain::discover())
            .with_workbench()
            .with_egress_settings(e),
    )
}

fn run(fx: &mut Fx, script: &str, np: &NetPolicy, pol: &CommandPolicy) -> serde_json::Value {
    fx.approve_process_fs(300_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    let o = execute_process_net(
        &mut fx.kernel,
        &call,
        &cancel,
        pol,
        &dir,
        300_000,
        None,
        Some(np.clone()),
        None,
    )
    .unwrap();
    o.result
        .output
        .clone()
        .unwrap_or_else(|| json!({"error": o.result.error.map(|e| e.message)}))
}

fn text(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}

#[test]
fn npm_install_works_through_the_gatekeeper_and_fails_cleanly_without_permission() {
    if !ready("npm") || !Path::new("/usr/bin/npm").exists() {
        return;
    }
    let f = fixtures();
    let mut fx = fixture("m5-npm");
    fx.write(
        "package.json",
        br#"{"name":"app","version":"1.0.0","dependencies":{"fixture-lib":"1.0.0"}}"#,
    );
    let (np, pol) = net_for(&f, &["registry.npm-fixture.org"]);
    let v = run(&mut fx, "npm install --registry http://registry.npm-fixture.org/ --no-audit --no-fund --loglevel=error 2>&1; echo rc=$?; node -e \"console.log(require('fixture-lib')())\"", &np, &pol);
    let t = text(&v);
    assert!(
        t.contains("rc=0") && t.contains("fixture-lib says hello"),
        "{t}"
    );
    assert!(
        fx.ws.join("node_modules/fixture-lib/index.js").exists()
            && fx.ws.join("package-lock.json").exists()
    );
    // evidence: truthful about the install
    let sum = &v["networkSummary"];
    assert!(
        sum["destinations"]
            .to_string()
            .contains("registry.npm-fixture.org:80")
            && sum["bytesDown"].as_u64().unwrap_or(0) > 500,
        "{sum}"
    );
    // without the registry in the policy: the install fails, the denial names the host, nothing is installed
    let mut fx = fixture("m5-npm-denied");
    fx.write(
        "package.json",
        br#"{"name":"app","version":"1.0.0","dependencies":{"fixture-lib":"1.0.0"}}"#,
    );
    let (np, pol) = net_for(&f, &["pypi.fixture-py.org"]);
    let v = run(&mut fx, "npm install --registry http://registry.npm-fixture.org/ --no-audit --no-fund --loglevel=error 2>&1 | head -c 600; echo rc=$?", &np, &pol);
    assert!(!fx.ws.join("node_modules/fixture-lib").exists());
    assert!(
        v["networkSummary"]["denied"]
            .to_string()
            .contains("registry.npm-fixture.org:80"),
        "{}",
        v["networkSummary"]
    );
}

#[test]
fn pip_install_works_through_the_gatekeeper() {
    if !ready("pip") || !Path::new("/usr/bin/pip").exists() {
        return;
    }
    let f = fixtures();
    let mut fx = fixture("m5-pip");
    let (np, pol) = net_for(&f, &["pypi.fixture-py.org"]);
    let v = run(&mut fx, "pip install -q --index-url http://pypi.fixture-py.org/simple/ --trusted-host pypi.fixture-py.org --target /work/out/pylib fixture-pkg 2>&1 | tail -3; PYTHONPATH=/work/out/pylib python3 -c 'import fixture_pkg; print(fixture_pkg.hello())'", &np, &pol);
    let t = text(&v);
    assert!(t.contains("fixture-pkg says hello"), "{t}");
    assert!(v["networkSummary"]["destinations"]
        .to_string()
        .contains("pypi.fixture-py.org:80"));
}

#[test]
fn cargo_fetch_and_build_work_through_the_gatekeeper() {
    if !ready("cargo")
        || (!Path::new("/usr/bin/cargo").exists()
            && !Path::new(&format!(
                "{}/.cargo/bin/cargo",
                std::env::var("HOME").unwrap_or_default()
            ))
            .exists())
    {
        return;
    }
    let f = fixtures();
    let mut fx = fixture("m5-cargo");
    fx.write("Cargo.toml", b"[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nfixture-crate = \"0.1.0\"\n");
    fx.write(
        "src/main.rs",
        b"fn main() { println!(\"{}\", fixture_crate::hello()); }\n",
    );
    fx.write(".cargo/config.toml", b"[source.crates-io]\nreplace-with = \"fx\"\n[source.fx]\nregistry = \"sparse+http://index.crates-fixture.org/\"\n");
    let (np, pol) = net_for(&f, &["index.crates-fixture.org"]);
    let v = run(
        &mut fx,
        "cargo fetch 2>&1 | tail -5; echo fetch-rc=$?; cargo run -q 2>&1 | tail -5",
        &np,
        &pol,
    );
    let t = text(&v);
    assert!(t.contains("fixture-crate says hello"), "{t}");
    assert!(
        v["networkSummary"]["destinations"]
            .to_string()
            .contains("index.crates-fixture.org:80"),
        "{}",
        v["networkSummary"]
    );
}

#[test]
fn git_clone_over_http_works_and_ssh_is_an_actionable_unsupported_transport() {
    if !ready("git") || !Path::new("/usr/bin/git").exists() {
        return;
    }
    let f = fixtures();
    let mut fx = fixture("m5-git");
    let (np, pol) = net_for(&f, &["git.fixture-git.org"]);
    let v = run(
        &mut fx,
        "git clone -q http://git.fixture-git.org/repo.git cloned 2>&1 | tail -3; cat cloned/README.md; \
         echo ssh=$(GIT_SSH_COMMAND='ssh -o ConnectTimeout=4 -o StrictHostKeyChecking=no -o BatchMode=yes' git ls-remote ssh://git@git.fixture-git.org/repo.git 2>&1 | head -c 200)",
        &np,
        &pol,
    );
    let t = text(&v);
    assert!(t.contains("fixture repository"), "{t}");
    assert!(fx.ws.join("cloned/.git").exists());
    // ssh has no route: it fails by itself (name resolution / connection), it does not bypass anything
    let ssh = t.lines().find(|l| l.starts_with("ssh=")).unwrap_or("");
    assert!(ssh.len() > 6 && !ssh.contains("refs/heads"), "{t}");
}

#[test]
fn https_tunnels_node_fetch_and_the_clients_that_ignore_proxy_settings_fail_without_a_bypass() {
    if !ready("tls") || !Path::new("/usr/bin/node").exists() || !Path::new("/usr/bin/curl").exists()
    {
        return;
    }
    let f = fixtures();
    let mut fx = fixture("m5-tls");
    std::fs::copy(&f.ca, fx.ws.join("fixture-ca.txt")).unwrap();
    let (np, pol) = net_for(&f, &["secure.fixture-tls.org"]);
    let script = "echo curl=$(curl -sS --max-time 10 --cacert /work/src/fixture-ca.txt -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://secure.fixture-tls.org/fixture-lib 2>&1); \
        echo node-fetch=$(NODE_EXTRA_CA_CERTS=/work/src/fixture-ca.txt node -e \"fetch('https://secure.fixture-tls.org/fixture-lib').then(r=>r.json()).then(j=>console.log('OK',j.name)).catch(e=>console.log('FAIL',e.cause&&e.cause.code||e.message))\" 2>&1); \
        echo node-no-proxy-env=$(env -u NODE_USE_ENV_PROXY NODE_EXTRA_CA_CERTS=/work/src/fixture-ca.txt node -e \"fetch('https://secure.fixture-tls.org/fixture-lib').then(()=>console.log('OK')).catch(e=>console.log('FAIL',e.cause&&e.cause.code||e.message))\" 2>&1); \
        echo wget=$(wget -q -O - --timeout=8 --ca-certificate=/work/src/fixture-ca.txt https://secure.fixture-tls.org/fixture-lib 2>&1 | head -c 60)";
    let v = run(&mut fx, script, &np, &pol);
    let t = text(&v);
    assert!(t.contains("curl=200/0"), "{t}");
    assert!(t.contains("node-fetch=OK fixture-lib"), "{t}");
    // a client that does not use the proxy cannot reach anything: a clear failure, not a bypass
    assert!(t.contains("node-no-proxy-env=FAIL"), "{t}");
    assert!(
        t.lines()
            .any(|l| l.starts_with("wget=") && l.contains("fixture-lib")),
        "wget honors the proxy variables: {t}"
    );
    assert!(v["networkSummary"]["destinations"]
        .to_string()
        .contains("secure.fixture-tls.org:443"));
}

#[test]
fn pnpm_is_reported_honestly_when_it_is_not_installed() {
    if !Path::new("/usr/bin/pnpm").exists() && !Path::new("/usr/local/bin/pnpm").exists() {
        println!("NOT RUN (pnpm): pnpm is not installed on this host; it uses the same HTTP(S) proxy variables as npm but was not exercised");
    }
}
