//! M5: Controlled Internet end to end - the real egress service, the real bubblewrap/Landlock sandbox with
//! its own (empty) network namespace, the real in-sandbox bridge, and local fixture servers standing in for the
//! internet (public-looking names are mapped to the fixtures by the operator test hooks).

mod common;

use common::*;
use nexus_tools::egress_host::EgressSettings;
use nexus_tools::netpolicy::{HostRule, NetPolicy};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_net, CancellationToken};
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    let have = nexus_tools::confine_host::locate_egress().is_some();
    if !c.available
        || c.landlock_abi.is_none()
        || !c.launch_gate
        || !have
        || !std::path::Path::new("/usr/bin/curl").exists()
    {
        println!(
            "NOT RUN ({t}): sandbox/Landlock/launch gate/egress/curl unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

pub struct Net {
    pub policy: NetPolicy,
    pub resolve: Vec<(&'static str, &'static str)>,
    /// (public-looking ip:port, fixture port on this machine)
    pub connect: Vec<(String, u16)>,
}

fn cmd_policy(n: &Net) -> CommandPolicy {
    let mut e = EgressSettings::default();
    for (h, ip) in &n.resolve {
        e.test_resolve.insert((*h).into(), (*ip).into());
    }
    for (a, p) in &n.connect {
        e.test_connect.insert(a.clone(), format!("127.0.0.1:{p}"));
    }
    CommandPolicy::standard(Toolchain::discover())
        .with_workbench()
        .with_egress_settings(e)
}

pub fn rule(h: &str, ports: &[u16]) -> HostRule {
    HostRule {
        host: h.into(),
        ports: ports.to_vec(),
    }
}

/// A small HTTP server on this machine; `f(head)` is the whole response. Counts the requests it received.
fn http_server(
    f: impl Fn(&str) -> String + Send + Sync + 'static,
) -> (u16, Arc<AtomicU64>, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let hits = Arc::new(AtomicU64::new(0));
    let heads = Arc::new(Mutex::new(Vec::new()));
    let (h2, hd2) = (hits.clone(), heads.clone());
    let f = Arc::new(f);
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let (f, h, hd) = (f.clone(), h2.clone(), hd2.clone());
            std::thread::spawn(move || {
                let mut c = c;
                let mut buf = vec![0u8; 8192];
                let mut head = Vec::new();
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match c.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                h.fetch_add(1, Ordering::SeqCst);
                let head = String::from_utf8_lossy(&head).into_owned();
                hd.lock().unwrap().push(head.clone());
                let _ = c.write_all(f(&head).as_bytes());
            });
        }
    });
    (port, hits, heads)
}

fn ok_body(b: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{b}", b.len())
}

fn run_net(
    fx: &mut Fx,
    script: &str,
    n: &Net,
    narrow: Option<&dyn Fn(&NetPolicy) -> bool>,
    cancel_after: Option<Duration>,
) -> (serde_json::Value, Duration) {
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = cmd_policy(n);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    if let Some(d) = cancel_after {
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(d);
            c2.cancel();
        });
    }
    let t = Instant::now();
    let o = execute_process_net(
        &mut fx.kernel,
        &call,
        &cancel,
        &pol,
        &dir,
        120_000,
        None,
        Some(n.policy.clone()),
        narrow,
    )
    .unwrap();
    let el = t.elapsed();
    (
        o.result
            .output
            .clone()
            .unwrap_or_else(|| json!({"error": o.result.error.map(|e| e.message)})),
        el,
    )
}

fn text(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}

fn fixture_net(fx_ports: &[(&'static str, &'static str, u16, u16)]) -> Net {
    // (host, public-looking ip, port the client uses, fixture port)
    Net {
        policy: NetPolicy::default(),
        resolve: fx_ports.iter().map(|(h, ip, _, _)| (*h, *ip)).collect(),
        connect: fx_ports
            .iter()
            .map(|(_, ip, p, fp)| (format!("{ip}:{p}"), *fp))
            .collect(),
    }
}

#[test]
fn a_command_reaches_only_the_allowed_destinations_and_every_bypass_attempt_fails() {
    if !ready("reach") {
        return;
    }
    let (fp, hits, heads) = http_server(|h| {
        if h.contains("/redirect") {
            "HTTP/1.1 302 Found\r\nLocation: http://evil.example.net/steal\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".into()
        } else {
            ok_body("ALLOWED-BODY")
        }
    });
    let (ep, ehits, _) = http_server(|_| ok_body("EVIL-BODY"));
    let mut n = fixture_net(&[
        ("files.example.org", "8.8.4.4", 80, fp),
        ("evil.example.net", "8.8.8.8", 80, ep),
    ]);
    n.policy = NetPolicy {
        hosts: vec![rule("files.example.org", &[80])],
        local_ports: vec![],
    };
    let mut fx = fixture("m5-reach");
    fx.approve_process_fs(120_000, "workspace");
    let script = format!(
        "echo allowed=$(curl -sS --max-time 10 http://files.example.org/data?token=SECRETQUERY 2>&1); \
         echo unapproved=$(curl -sS --max-time 10 http://evil.example.net/ 2>&1 | head -c 200); \
         echo ip-literal=$(curl -sS --max-time 10 http://8.8.4.4/ 2>&1 | head -c 120); \
         echo https-port=$(curl -sS --max-time 10 https://files.example.org/ 2>&1 | head -c 120); \
         echo redirect=$(curl -sSL --max-time 10 http://files.example.org/redirect 2>&1 | head -c 200); \
         echo noproxy=$(curl -sS --noproxy '*' --max-time 5 http://files.example.org/ 2>&1 | head -c 120); \
         echo ownproxy=$(HTTP_PROXY=http://8.8.4.4:3128 http_proxy=http://8.8.4.4:3128 curl -sS --max-time 5 http://files.example.org/ 2>&1 | head -c 120); \
         echo direct-ip-noproxy=$(curl -sS --noproxy '*' --max-time 5 http://8.8.4.4:{fp}/ 2>&1 | head -c 120); \
         echo tcp=$(python3 -c \"import socket;s=socket.socket();s.settimeout(4)\ntry:\n s.connect(('8.8.8.8',53));print('CONNECTED')\nexcept Exception as e:\n print('no-route',type(e).__name__)\"); \
         echo udp=$(python3 -c \"import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(3)\ntry:\n s.sendto(b'x',('8.8.8.8',53));print(len(s.recvfrom(10)[0]))\nexcept Exception as e:\n print('no-route',type(e).__name__)\"); \
         echo dns=$(getent hosts files.example.org || echo no-resolver)"
    );
    let (v, _) = run_net(&mut fx, &script, &n, None, None);
    let t = text(&v);
    assert!(t.contains("allowed=ALLOWED-BODY"), "{t}");
    assert!(
        t.contains("unapproved=") && t.contains("Nexus network policy") && !t.contains("EVIL-BODY"),
        "{t}"
    );
    assert!(
        t.contains("ip-literal=")
            && t.lines()
                .any(|l| l.starts_with("ip-literal=") && l.contains("IP addresses")),
        "{t}"
    );
    assert!(
        t.lines().any(|l| l.starts_with("https-port=")
            && (l.contains("403") || l.contains("not in the allowed list"))),
        "{t}"
    );
    assert!(
        !t.contains("redirect=EVIL-BODY")
            && t.contains("redirect=")
            && t.contains("Nexus network policy"),
        "the redirect escaped the policy: {t}"
    );
    for k in ["noproxy", "ownproxy", "direct-ip-noproxy"] {
        let line = t
            .lines()
            .find(|l| l.starts_with(&format!("{k}=")))
            .unwrap_or("");
        assert!(
            !line.contains("ALLOWED-BODY") && !line.contains("EVIL-BODY"),
            "{k}: {t}"
        );
    }
    assert!(
        t.contains("tcp=no-route") && t.contains("udp=no-route") && t.contains("dns=no-resolver"),
        "{t}"
    );
    assert_eq!(
        ehits.load(Ordering::SeqCst),
        0,
        "the unapproved server was contacted"
    );
    // the allowed server saw exactly what the client sent, once (the unapproved and redirected requests never left)
    assert!(
        heads
            .lock()
            .unwrap()
            .iter()
            .any(|h| h.starts_with("GET /data?token=SECRETQUERY HTTP/1.1")),
        "{:?}",
        heads.lock().unwrap()
    );
    assert!(hits.load(Ordering::SeqCst) >= 2);
    // the evidence names destinations and counts - never URLs or tokens
    let sum = v["networkSummary"].to_string();
    assert!(
        sum.contains("files.example.org:80")
            && sum.contains("evil.example.net:80")
            && sum.contains("denied"),
        "{sum}"
    );
    assert!(
        !sum.contains("SECRETQUERY") && !sum.contains("/data"),
        "{sum}"
    );
    assert_eq!(v["network"], "controlled");
    assert!(v["networkSummary"]["bytesDown"].as_u64().unwrap_or(0) > 0);
}

#[test]
fn rebinding_private_loopback_and_metadata_answers_are_refused_even_for_allowed_names() {
    if !ready("rebind") {
        return;
    }
    let (fp, hits, _) = http_server(|_| ok_body("INTERNAL-SERVICE"));
    let mut n = Net {
        policy: NetPolicy {
            hosts: vec![
                rule("rebind.example.org", &[80]),
                rule("meta.example.org", &[80]),
                rule("loop.example.org", &[80]),
            ],
            local_ports: vec![],
        },
        resolve: vec![
            ("rebind.example.org", "10.0.0.5"),
            ("meta.example.org", "169.254.169.254"),
            ("loop.example.org", "127.0.0.1"),
        ],
        connect: vec![],
    };
    // even if the "private" address would reach a real service on this machine, the connection is never made
    n.connect.push(("10.0.0.5:80".into(), fp));
    n.connect.push(("127.0.0.1:80".into(), fp));
    let mut fx = fixture("m5-rebind");
    fx.approve_process_fs(120_000, "workspace");
    let (v, _) = run_net(&mut fx, "for h in rebind meta loop; do echo $h=$(curl -sS --max-time 8 http://$h.example.org/ 2>&1 | head -c 220); done", &n, None, None);
    let t = text(&v);
    assert!(!t.contains("INTERNAL-SERVICE"), "{t}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "a private address was contacted on behalf of a name"
    );
    assert_eq!(t.matches("resolves to").count(), 3, "{t}");
}

#[test]
fn an_explicitly_granted_local_port_is_reachable_and_nothing_else_on_this_machine_is() {
    if !ready("local") {
        return;
    }
    let (dev, dev_hits, _) = http_server(|_| ok_body("DEV-SERVER"));
    let (other, other_hits, _) = http_server(|_| ok_body("SECRET-LOCAL-SERVICE"));
    let n = Net {
        policy: NetPolicy {
            hosts: vec![],
            local_ports: vec![dev],
        },
        resolve: vec![],
        connect: vec![],
    };
    let mut fx = fixture("m5-local");
    fx.approve_process_fs(120_000, "workspace");
    let (v, _) = run_net(
        &mut fx,
        &format!("echo dev=$(curl -sS --max-time 8 http://127.0.0.1:{dev}/ 2>&1); echo other=$(curl -sS --noproxy '*' --max-time 5 http://127.0.0.1:{other}/ 2>&1 | head -c 100); echo viaproxy=$(curl -sS --max-time 5 --proxy http://127.0.0.1:3128 http://127.0.0.1:{other}/ 2>&1 | head -c 160)"),
        &n,
        None,
        None,
    );
    let t = text(&v);
    assert!(t.contains("dev=DEV-SERVER"), "{t}");
    assert!(
        !t.contains("SECRET-LOCAL-SERVICE") && other_hits.load(Ordering::SeqCst) == 0,
        "{t}"
    );
    assert!(dev_hits.load(Ordering::SeqCst) >= 1);
    assert!(
        t.lines()
            .any(|l| l.starts_with("viaproxy=") && !l.contains("SECRET")),
        "{t}"
    );
}

#[test]
fn cancellation_and_a_withdrawn_policy_end_connections_and_a_dead_gatekeeper_means_refusal_not_a_fallback(
) {
    if !ready("lifecycle") {
        return;
    }
    // a slow download: 60 chunks over 12 s
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let slow = l.local_addr().unwrap().port();
    let sent = Arc::new(AtomicU64::new(0));
    let s2 = sent.clone();
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let s3 = s2.clone();
            std::thread::spawn(move || {
                let mut c = c;
                let mut b = [0u8; 4096];
                let _ = c.read(&mut b);
                let _ = c.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
                for _ in 0..60 {
                    if c.write_all(&[b'x'; 1024]).is_err() {
                        return;
                    }
                    s3.fetch_add(1024, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(200));
                }
            });
        }
    });
    let mut n = fixture_net(&[("slow.example.org", "8.8.4.4", 80, slow)]);
    n.policy = NetPolicy {
        hosts: vec![rule("slow.example.org", &[80])],
        local_ports: vec![],
    };
    // 1. cancellation: the command and the gatekeeper are gone promptly
    let mut fx = fixture("m5-cancel");
    fx.approve_process_fs(120_000, "workspace");
    let (v, el) = run_net(
        &mut fx,
        "curl -sS --max-time 60 http://slow.example.org/ -o /dev/null; echo curl-ended",
        &n,
        None,
        Some(Duration::from_millis(2500)),
    );
    assert_eq!(v["reason"], "cancelled", "{v}");
    assert!(el < Duration::from_secs(8), "cancellation took {el:?}");
    std::thread::sleep(Duration::from_millis(300));
    let stopped_at = sent.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(1000));
    assert!(
        sent.load(Ordering::SeqCst) <= stopped_at + 2048,
        "the download continued after the cancel"
    );
    assert!(
        v["networkSummary"]["connections"].as_u64().unwrap_or(0) >= 1,
        "{v}"
    );
    // 2. a policy narrowed during the command: the connection ends at once, the command itself continues
    let started = Instant::now();
    let probe = move |_: &NetPolicy| started.elapsed() > Duration::from_millis(2500);
    let mut fx = fixture("m5-narrow");
    fx.approve_process_fs(120_000, "workspace");
    let t0 = Instant::now();
    let (v, _) = run_net(&mut fx, "curl -sS --max-time 40 http://slow.example.org/ -o /dev/null; echo curl-rc=$?; echo command-continued", &n, Some(&probe), None);
    let t = text(&v);
    assert!(t.contains("command-continued"), "{t}");
    assert_eq!(
        v["networkSummary"]["terminatedWhileOpen"], 1,
        "the open connection must have been cut: {}",
        v["networkSummary"]
    );
    assert!(
        sent_after_narrow(&sent) < 40 * 1024,
        "the download kept going"
    );
    assert!(
        t0.elapsed() < Duration::from_secs(15),
        "the connection outlived the narrowing: {:?}",
        t0.elapsed()
    );
    assert_eq!(
        v["networkSummary"]["endedEarly"], "network permissions narrowed",
        "{v}"
    );
    assert_eq!(v["reason"], "exited");
    // 3. the gatekeeper dies mid-command: later connections fail - nothing reaches the network another way
    let (fp, hits, _) = http_server(|_| ok_body("LATE-BODY"));
    let mut n2 = fixture_net(&[("late.example.org", "8.8.4.4", 80, fp)]);
    n2.policy = NetPolicy {
        hosts: vec![rule("late.example.org", &[80])],
        local_ports: vec![],
    };
    let mut fx = fixture("m5-dead");
    fx.approve_process_fs(120_000, "workspace");
    let script = "echo before=$(curl -sS --max-time 8 http://late.example.org/ 2>&1); sleep 3; echo after=$(curl -sS --max-time 8 http://late.example.org/ 2>&1 | head -c 120); echo direct=$(curl -sS --noproxy '*' --max-time 4 http://8.8.4.4/ 2>&1 | head -c 120)";
    let killer = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(1800));
        let _ = std::process::Command::new("pkill")
            .args(["-f", "/nexus/egress --dir"])
            .status();
    });
    let (v, _) = run_net(&mut fx, script, &n2, None, None);
    killer.join().unwrap();
    let t = text(&v);
    assert!(t.contains("before=LATE-BODY"), "{t}");
    assert!(
        !t.contains("after=LATE-BODY"),
        "a connection succeeded after the gatekeeper died: {t}"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "no second request may have reached the server"
    );
}

#[test]
fn without_the_gatekeeper_the_command_does_not_start_and_offline_stays_offline() {
    if !ready("nogate") {
        return;
    }
    let (fp, hits, _) = http_server(|_| ok_body("X"));
    let mut n = fixture_net(&[("a.example.org", "8.8.4.4", 80, fp)]);
    n.policy = NetPolicy {
        hosts: vec![rule("a.example.org", &[80])],
        local_ports: vec![],
    };
    let mut fx = fixture("m5-noegress");
    fx.approve_process_fs(120_000, "workspace");
    let e = EgressSettings {
        bin: Some(std::path::PathBuf::from("/nonexistent/nexus-egress")),
        ..Default::default()
    };
    let pol = CommandPolicy::standard(Toolchain::discover())
        .with_workbench()
        .with_egress_settings(e);
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "echo ran > ran.txt"], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    let o = execute_process_net(
        &mut fx.kernel,
        &call,
        &cancel,
        &pol,
        &dir,
        60_000,
        None,
        Some(n.policy.clone()),
        None,
    )
    .unwrap();
    let e = o.result.error.expect("refused");
    assert!(
        e.message.contains("egress") && e.message.contains("nothing was run"),
        "{}",
        e.message
    );
    assert!(!fx.ws.join("ran.txt").exists());
    // offline (no policy): no route, no proxy variables
    let mut fx = fixture("m5-offline");
    fx.approve_process_fs(120_000, "workspace");
    let r = fx.request("proc.run", json!({"program": "sh", "args": ["-c", "env | grep -ci proxy; curl -sS --max-time 4 http://a.example.org/ 2>&1 | head -c 100; echo done"], "cwd": "."}));
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = cmd_policy(&n);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    let o =
        nexus_tools::execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &dir, 60_000, None)
            .unwrap();
    let v = o.result.output.unwrap();
    let t = text(&v);
    assert!(
        t.starts_with("0\n") && t.contains("done") && !t.contains("<"),
        "{t}"
    );
    assert_eq!(v["network"], "none");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[test]
fn the_model_cannot_name_a_network_a_proxy_or_a_destination() {
    if !ready("args") {
        return;
    }
    let mut fx = fixture("m5-args");
    fx.approve_process_fs(120_000, "workspace");
    for bad in [
        "net",
        "network",
        "proxy",
        "allowHost",
        "allowHosts",
        "egress",
        "destinations",
        "netPolicy",
        "controlled",
        "env",
    ] {
        let r = fx.request(
            "proc.run",
            json!({"program": "sh", "args": ["-c", "true"], "cwd": ".", bad: true}),
        );
        assert!(
            fx.prepare_p(r, &cmd_policy(&fixture_net(&[]))).is_err(),
            "'{bad}' must be refused"
        );
    }
}

fn sent_after_narrow(sent: &AtomicU64) -> u64 {
    std::thread::sleep(Duration::from_millis(500));
    sent.load(Ordering::SeqCst)
}

/// Measurements (not assertions of speed): `cargo test --release -p nexus-tools --test egress_m5 perf_m5 -- --ignored --nocapture`.
#[test]
#[ignore]
fn perf_m5_measurements() {
    if !ready("perf") {
        return;
    }
    const BIG: u64 = 512 * 1024 * 1024;
    // a server: small bodies, a streamed 512 MiB body at /big, an endless drip at /slow
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let fp = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            std::thread::spawn(move || {
                let mut c = c;
                let mut head = Vec::new();
                let mut b = [0u8; 4096];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match c.read(&mut b) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&b[..n]),
                    }
                }
                let h = String::from_utf8_lossy(&head).into_owned();
                if h.contains("GET /big") {
                    let _ = c.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {BIG}\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    let chunk = vec![7u8; 1 << 20];
                    for _ in 0..(BIG >> 20) {
                        if c.write_all(&chunk).is_err() {
                            return;
                        }
                    }
                } else if h.contains("GET /slow") {
                    let _ = c.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
                    while c.write_all(&[b'x'; 512]).is_ok() {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                } else {
                    let _ = c.write_all(ok_body("small").as_bytes());
                }
            });
        }
    });
    let mut n = fixture_net(&[("perf.example.org", "8.8.4.4", 80, fp)]);
    n.policy = NetPolicy {
        hosts: vec![rule("perf.example.org", &[80])],
        local_ports: vec![],
    };
    let secs = |c: &std::process::Output| {
        String::from_utf8_lossy(&c.stdout)
            .trim()
            .parse::<f64>()
            .unwrap_or(f64::NAN)
    };
    // ---- baselines on the host, no sandbox, no proxy
    let t = Instant::now();
    for _ in 0..100 {
        std::process::Command::new("curl")
            .args([
                "-s",
                "--noproxy",
                "*",
                "-o",
                "/dev/null",
                &format!("http://127.0.0.1:{fp}/s"),
            ])
            .status()
            .unwrap();
    }
    let direct_small = t.elapsed().as_secs_f64() * 10.0; // ms per request
    let o = std::process::Command::new("curl")
        .args([
            "-s",
            "--noproxy",
            "*",
            "-o",
            "/dev/null",
            "-w",
            "%{time_total}",
            &format!("http://127.0.0.1:{fp}/big"),
        ])
        .output()
        .unwrap();
    let direct_big = secs(&o);
    // ---- the same through the sandbox + gatekeeper
    let mut fx = fixture("m5-perf");
    fx.approve_process_fs(300_000, "workspace");
    let t = Instant::now();
    let (v, whole) = run_net(&mut fx, "true", &n, None, None);
    let startup = t.elapsed();
    assert_eq!(v["network"], "controlled");
    let mut fx = fixture("m5-perf2");
    fx.approve_process_fs(300_000, "workspace");
    let (v, whole2) = run_net(
        &mut fx,
        "for i in $(seq 100); do curl -s -o /dev/null http://perf.example.org/s; done",
        &n,
        None,
        None,
    );
    let _ = (&v, whole);
    let via_small = (whole2.as_secs_f64() - startup.as_secs_f64()) * 10.0;
    // the large download, sampling the gatekeeper's memory and CPU while it runs
    let peak = Arc::new(Mutex::new((0u64, 0u64)));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (pk, st) = (peak.clone(), stop.clone());
    let sampler = std::thread::spawn(move || {
        while !st.load(Ordering::SeqCst) {
            for e in std::fs::read_dir("/proc").unwrap().flatten() {
                let p = e.path();
                let Ok(cmd) = std::fs::read(p.join("cmdline")) else {
                    continue;
                };
                let argv0 = cmd.split(|b| *b == 0).next().unwrap_or(&[]);
                if !(String::from_utf8_lossy(argv0).ends_with("/egress")
                    && String::from_utf8_lossy(&cmd).contains("--dir"))
                {
                    continue;
                }
                let rss = std::fs::read_to_string(p.join("status"))
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|l| l.starts_with("VmHWM"))
                            .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
                    })
                    .unwrap_or(0);
                let cpu = std::fs::read_to_string(p.join("stat"))
                    .ok()
                    .and_then(|s| {
                        let f: Vec<&str> = s.rsplit(") ").next()?.split_whitespace().collect();
                        Some(f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?)
                    })
                    .unwrap_or(0);
                let mut g = pk.lock().unwrap();
                g.0 = g.0.max(rss);
                g.1 = g.1.max(cpu);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let mut fx = fixture("m5-perf3");
    fx.approve_process_fs(300_000, "workspace");
    let (v, _) = run_net(&mut fx, "curl -s -o /dev/null -w 'big-total=%{time_total} bytes=%{size_download}\\n' http://perf.example.org/big", &n, None, None);
    stop.store(true, Ordering::SeqCst);
    sampler.join().unwrap();
    let t = text(&v);
    let via_big: f64 = t
        .split("big-total=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(f64::NAN);
    let (rss_kb, cpu_ticks) = *peak.lock().unwrap();
    // ---- cancellation and narrowing latency
    let mut fx = fixture("m5-perf4");
    fx.approve_process_fs(300_000, "workspace");
    let (_, el) = run_net(
        &mut fx,
        "curl -s --max-time 60 http://perf.example.org/slow -o /dev/null",
        &n,
        None,
        Some(Duration::from_millis(1500)),
    );
    let cancel_ms = el.as_millis() as i64 - 1500;
    let narrowed_at = Arc::new(Mutex::new(None::<std::time::SystemTime>));
    let na = narrowed_at.clone();
    let started = Instant::now();
    let probe = move |_: &NetPolicy| {
        if started.elapsed() > Duration::from_millis(2500) {
            na.lock()
                .unwrap()
                .get_or_insert_with(std::time::SystemTime::now);
            true
        } else {
            false
        }
    };
    let mut fx = fixture("m5-perf5");
    fx.approve_process_fs(300_000, "workspace");
    let (v, _) = run_net(
        &mut fx,
        "curl -s --max-time 60 http://perf.example.org/slow -o /dev/null; date +ended=%s%N",
        &n,
        Some(&probe),
        None,
    );
    let ended: u128 = text(&v)
        .split("ended=")
        .nth(1)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let at = narrowed_at
        .lock()
        .unwrap()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let narrow_ms = (ended as i128 - at as i128) as f64 / 1e6;
    // ---- policy decision cost
    let pol = NetPolicy {
        hosts: (0..50)
            .map(|i| rule(&format!("h{i}.example.org"), &[443]))
            .chain([rule("*.cdn.example.org", &[443])])
            .collect(),
        local_ports: vec![],
    };
    let t = Instant::now();
    let mut hit = 0;
    for i in 0..200_000 {
        if pol.allows(
            if i % 2 == 0 {
                "x.cdn.example.org"
            } else {
                "evil.example.net"
            },
            443,
        ) {
            hit += 1;
        }
    }
    let policy_ns = t.elapsed().as_nanos() as f64 / 200_000.0;
    println!("PERF direct small request (curl process incl.): {direct_small:.1} ms");
    println!("PERF via sandbox+gatekeeper small request (curl process incl.): {via_small:.1} ms");
    println!(
        "PERF sandbox+gatekeeper startup (empty command, whole execution): {} ms",
        startup.as_millis()
    );
    println!(
        "PERF 512 MiB direct: {direct_big:.2} s = {:.0} MiB/s",
        512.0 / direct_big
    );
    println!(
        "PERF 512 MiB via gatekeeper: {via_big:.2} s = {:.0} MiB/s",
        512.0 / via_big
    );
    println!(
        "PERF gatekeeper peak RSS during the download: {} KiB; CPU ticks (1/100 s): {cpu_ticks}",
        rss_kb
    );
    println!("PERF cancel latency (cancel request -> execution returned): {cancel_ms} ms");
    println!("PERF narrowing latency (decision -> in-flight transfer cut): {narrow_ms:.0} ms");
    println!("PERF policy decision: {policy_ns:.0} ns per host check ({hit} hits)");
}
