//! `nexus-egress`: the only way a command sandbox in Controlled mode reaches a network (M5).
//!
//! One egress process serves ONE execution. It runs outside the command's sandbox but inside its own tiny
//! one (no project, no credentials, no checkpoints, no Nexus data: only its socket directory and name
//! resolution), is started by the daemon from the execution's frozen grant, and is killed when the command
//! ends, is cancelled, is revoked or has its permissions narrowed. The command's sandbox has NO network
//! interface except a loopback; its only channel is a unix socket to this process, reached through a bridge
//! that listens on `127.0.0.1` inside the sandbox. If this process is absent or dead, connections simply fail:
//! there is no fallback route to the host network.
//!
//! Transports: `CONNECT host:port` (HTTPS and any TCP-over-proxy: git, npm, pip, cargo, curl, Node with
//! `NODE_USE_ENV_PROXY`), absolute-URI HTTP requests (plain `http://`, one request per connection), and
//! fixed TCP forwards to explicitly granted ports of services on the user's own machine. HTTPS content is
//! never inspected; the policy sees the host name and port the client asked for.
//!
//! Enforcement happens at connection time: the requested name must match a rule and port; IP literals are
//! refused; the name is resolved HERE, every returned address that is private/loopback/link-local/metadata/
//! reserved is dropped, and the connection goes to a validated address (never resolved a second time), so a
//! DNS answer cannot steer a connection to the user's own network. A redirect is a new request through the
//! same proxy and is judged again.
//!
//! What this is not: a data-loss-prevention boundary. A command can send anything it can read to a host the
//! user allowed. The audit trail records destinations, ports, byte counts and outcomes - never URLs, headers,
//! credentials or payloads.

use crate::netpolicy::{forbidden_ip, NetPolicy};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SOCKET_NAME: &str = "e.sock";
pub const CONFIG_NAME: &str = "policy.json";
pub const AUDIT_NAME: &str = "audit.jsonl";
pub const READY_NAME: &str = "ready";
pub const FORWARD_PREFACE: &str = "NEXUS-FORWARD ";
/// Port of the HTTP proxy inside the command's sandbox.
pub const PROXY_PORT: u16 = 3128;
/// Protocol of the policy file and socket between the daemon, the egress service and the bridge.
pub const PROTOCOL: &str = "nexus-egress/1";
pub const STOP_NAME: &str = "stop";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EgressLimits {
    pub max_conns: u32,
    pub max_conn_secs: u64,
    pub idle_secs: u64,
    /// Bytes in both directions over the life of the execution.
    pub max_total_bytes: u64,
    pub dns_timeout_secs: u64,
    pub connect_timeout_secs: u64,
}

impl Default for EgressLimits {
    fn default() -> Self {
        Self {
            max_conns: 128,
            max_conn_secs: 1800,
            idle_secs: 120,
            max_total_bytes: 4 * 1024 * 1024 * 1024,
            dns_timeout_secs: 5,
            connect_timeout_secs: 10,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EgressConfig {
    pub policy: NetPolicy,
    pub policy_digest: String,
    #[serde(default)]
    pub limits: EgressLimits,
    /// Operator test hooks (a daemon flag refused by the production profile): resolve a name to a fixed
    /// address, and connect a fixed address to another socket address. Empty in every real run.
    #[serde(default)]
    pub test_resolve: BTreeMap<String, String>,
    #[serde(default)]
    pub test_connect: BTreeMap<String, String>,
}

struct State {
    cfg: EgressConfig,
    audit: Mutex<std::fs::File>,
    next_id: AtomicU64,
    active: AtomicU32,
    total_bytes: AtomicU64,
    shutdown: AtomicBool,
    started: Instant,
}

static TERM: AtomicBool = AtomicBool::new(false);
extern "C" fn on_term(_: libc::c_int) {
    TERM.store(true, Ordering::SeqCst);
}

impl State {
    fn log(&self, v: serde_json::Value) {
        if let Ok(mut f) = self.audit.lock() {
            let _ = writeln!(f, "{v}");
        }
    }
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// Printable ASCII only, bounded: what a name looks like in the audit trail.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_graphic())
        .take(253)
        .collect()
}

pub fn serve(dir: &Path) -> std::io::Result<()> {
    let cfg: EgressConfig = serde_json::from_slice(&std::fs::read(dir.join(CONFIG_NAME))?)
        .map_err(|e| std::io::Error::other(format!("bad policy file: {e}")))?;
    if cfg.policy.validate().is_err() || cfg.policy.digest() != cfg.policy_digest {
        return Err(std::io::Error::other(
            "the policy file does not match its digest",
        ));
    }
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_term as *const () as libc::sighandler_t);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let sock = dir.join(SOCKET_NAME);
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    listener.set_nonblocking(true)?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    let audit = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(AUDIT_NAME))?;
    let st = Arc::new(State {
        cfg,
        audit: Mutex::new(audit),
        next_id: AtomicU64::new(1),
        active: AtomicU32::new(0),
        total_bytes: AtomicU64::new(0),
        shutdown: AtomicBool::new(false),
        started: Instant::now(),
    });
    st.log(serde_json::json!({"ev": "start", "policyDigest": st.cfg.policy_digest, "rules": st.cfg.policy.hosts.len(), "localPorts": st.cfg.policy.local_ports}));
    std::fs::write(dir.join(READY_NAME), b"1")?;
    loop {
        if TERM.load(Ordering::SeqCst) || dir.join(STOP_NAME).exists() {
            TERM.store(true, Ordering::SeqCst);
            st.shutdown.store(true, Ordering::SeqCst);
            break;
        }
        match listener.accept() {
            Ok((s, _)) => {
                if st.active.load(Ordering::SeqCst) >= st.cfg.limits.max_conns {
                    let mut s = s;
                    let _ = s.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                st.active.fetch_add(1, Ordering::SeqCst);
                let st2 = st.clone();
                std::thread::spawn(move || {
                    handle(&st2, s);
                    st2.active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(15))
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    // graceful end: connections notice the flag, write their closing record and leave
    let until = Instant::now() + Duration::from_millis(600);
    while st.active.load(Ordering::SeqCst) > 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    st.log(serde_json::json!({"ev": "stop", "totalBytes": st.total_bytes.load(Ordering::SeqCst)}));
    Ok(())
}

fn respond(s: &mut UnixStream, code: u16, reason: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(msg.as_bytes());
}

fn deny_text(host: &str, port: u16, why: &str) -> String {
    format!(
        "Nexus network policy: {why}.\nDestination: {host}:{port}\nThis project's Controlled Internet permissions do not allow it. Nothing was sent. Ask the user to allow it, e.g.: nexus project grant <project> set ... --allow-host {host}\n"
    )
}

/// Read the first bytes of a connection: a request head ending in a blank line, or a one-line forward preface.
fn read_head(s: &mut UnixStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.starts_with(FORWARD_PREFACE.as_bytes()) {
            if let Some(i) = buf.iter().position(|b| *b == b'\n') {
                let rest = buf.split_off(i + 1);
                return Some((buf, rest));
            }
        } else if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Some((buf, rest));
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
}

/// `host`, `port` from a `host:port` / `[v6]:port` authority; the host is lowercased without a trailing dot.
fn split_authority(a: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    let (h, p) = if let Some(r) = a.strip_prefix('[') {
        let (h, rest) = r.split_once(']')?;
        (h.to_owned(), rest.strip_prefix(':').map(str::to_owned))
    } else if let Some((h, p)) = a.rsplit_once(':') {
        (h.to_owned(), Some(p.to_owned()))
    } else {
        (a.to_owned(), None)
    };
    let port = match p {
        Some(p) => p.parse::<u16>().ok()?,
        None => default_port?,
    };
    if h.is_empty() || port == 0 {
        return None;
    }
    Some((
        h.to_ascii_lowercase().trim_end_matches('.').to_owned(),
        port,
    ))
}

fn looks_like_address(h: &str) -> bool {
    h.parse::<IpAddr>().is_ok()
        || h.contains(':')
        || h.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        || h.rsplit('.')
            .next()
            .is_some_and(|t| t.starts_with("0x") || !t.bytes().any(|b| b.is_ascii_alphabetic()))
}

enum Verdict {
    Allowed(Vec<SocketAddr>),
    Denied(String),
}

fn resolve_with_timeout(host: &str, port: u16, secs: u64) -> Result<Vec<SocketAddr>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let h = host.to_owned();
    std::thread::spawn(move || {
        let r = (h.as_str(), port)
            .to_socket_addrs()
            .map(|i| i.collect::<Vec<_>>());
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(Ok(v)) if !v.is_empty() => Ok(v),
        Ok(_) => Err("the name did not resolve".into()),
        Err(_) => Err("name resolution timed out".into()),
    }
}

fn judge(st: &State, host: &str, port: u16) -> Verdict {
    if looks_like_address(host) {
        return Verdict::Denied(
            "IP addresses cannot be used as destinations; the policy is written in host names"
                .into(),
        );
    }
    if !st.cfg.policy.allows(host, port) {
        return Verdict::Denied("this destination is not in the allowed list".into());
    }
    let addrs: Vec<SocketAddr> = match st.cfg.test_resolve.get(host) {
        Some(ip) => match ip.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => return Verdict::Denied("bad test resolution".into()),
        },
        None => match resolve_with_timeout(host, port, st.cfg.limits.dns_timeout_secs) {
            Ok(a) => a,
            Err(e) => return Verdict::Denied(e),
        },
    };
    let mut ok: Vec<SocketAddr> = Vec::new();
    let mut why: Option<String> = None;
    for a in addrs {
        match forbidden_ip(a.ip()) {
            None => ok.push(a),
            Some(w) => why = why.or(Some(format!("the name resolves to a {w}; connections to the user's own network and to cloud metadata are never made on behalf of a host name"))),
        }
    }
    if ok.is_empty() {
        return Verdict::Denied(why.unwrap_or_else(|| "no usable address".into()));
    }
    // IPv6 and IPv4 both stay available; the validated list is what gets connected, in the resolver's order
    Verdict::Allowed(ok)
}

fn connect_validated(st: &State, addrs: &[SocketAddr]) -> Result<(TcpStream, SocketAddr), String> {
    let to = Duration::from_secs(st.cfg.limits.connect_timeout_secs);
    let mut last = "connection failed".to_owned();
    for a in addrs {
        let target = match st.cfg.test_connect.get(&a.to_string()) {
            Some(t) => t
                .parse::<SocketAddr>()
                .map_err(|_| "bad test connect map".to_owned())?,
            None => *a,
        };
        match TcpStream::connect_timeout(&target, to) {
            Ok(s) => return Ok((s, *a)),
            Err(e) => last = format!("connection failed: {}", e.kind()),
        }
    }
    Err(last)
}

fn handle(st: &Arc<State>, mut s: UnixStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let Some((head, rest)) = read_head(&mut s) else {
        return;
    };
    if let Some(p) = head.strip_prefix(FORWARD_PREFACE.as_bytes()) {
        let port: Option<u16> = std::str::from_utf8(p)
            .ok()
            .and_then(|t| t.trim().parse().ok());
        return forward(st, s, port, rest);
    }
    let Ok(text) = std::str::from_utf8(&head) else {
        return respond(&mut s, 400, "Bad Request", "not a proxy request\n");
    };
    let mut lines = text.split("\r\n");
    let req = lines.next().unwrap_or("");
    let mut parts = req.split(' ');
    let (method, target, version) = (
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
        parts.next().unwrap_or(""),
    );
    if !version.starts_with("HTTP/1.") || parts.next().is_some() {
        return respond(
            &mut s,
            400,
            "Bad Request",
            "this is the Nexus network proxy; send a proxy request\n",
        );
    }
    let (kind, host, port, origin_form) = if method.eq_ignore_ascii_case("CONNECT") {
        match split_authority(target, None) {
            Some((h, p)) => ("connect", h, p, String::new()),
            None => return respond(&mut s, 400, "Bad Request", "CONNECT needs host:port\n"),
        }
    } else if let Some(r) = target.strip_prefix("http://") {
        let (auth, path) = match r.find('/') {
            Some(i) => (&r[..i], &r[i..]),
            None => (r, "/"),
        };
        if auth.contains('@') {
            return respond(
                &mut s,
                400,
                "Bad Request",
                "credentials in the URL are not accepted by the proxy\n",
            );
        }
        match split_authority(auth, Some(80)) {
            Some((h, p)) => ("http", h, p, path.to_owned()),
            None => return respond(&mut s, 400, "Bad Request", "bad URL\n"),
        }
    } else {
        return respond(
            &mut s,
            400,
            "Bad Request",
            "this is the Nexus network proxy; send CONNECT host:port or an absolute http:// URL\n",
        );
    };
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let addrs = match judge(st, &host, port) {
        Verdict::Allowed(a) => a,
        Verdict::Denied(why) => {
            st.log(serde_json::json!({"ev": "deny", "id": id, "kind": kind, "host": clean(&host), "port": port, "reason": why, "atMs": st.now_ms()}));
            return respond(
                &mut s,
                403,
                "Forbidden",
                &deny_text(&clean(&host), port, &why),
            );
        }
    };
    let (up, addr) = match connect_validated(st, &addrs) {
        Ok(v) => v,
        Err(e) => {
            st.log(serde_json::json!({"ev": "fail", "id": id, "kind": kind, "host": clean(&host), "port": port, "reason": e, "atMs": st.now_ms()}));
            return respond(
                &mut s,
                502,
                "Bad Gateway",
                &format!("Nexus network proxy: {e}\n"),
            );
        }
    };
    st.log(serde_json::json!({"ev": "open", "id": id, "kind": kind, "host": clean(&host), "port": port, "ip": addr.ip().to_string(), "atMs": st.now_ms()}));
    let mut pending = rest;
    if kind == "connect" {
        if s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .is_err()
        {
            return;
        }
    } else {
        // forward the request in origin form, one request per connection
        let mut out = format!("{method} {origin_form} {version}\r\n");
        let mut has_host = false;
        for l in lines {
            if l.is_empty() {
                continue;
            }
            let name = l.split(':').next().unwrap_or("").to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "proxy-connection" | "proxy-authorization" | "connection" | "keep-alive"
            ) {
                continue;
            }
            has_host |= name == "host";
            out.push_str(l);
            out.push_str("\r\n");
        }
        if !has_host {
            out.push_str(&format!("Host: {host}\r\n"));
        }
        out.push_str("Connection: close\r\n\r\n");
        let mut v = out.into_bytes();
        v.extend_from_slice(&pending);
        pending = v;
    }
    pipe(st, id, s, up, pending);
}

fn forward(st: &Arc<State>, s: UnixStream, port: Option<u16>, rest: Vec<u8>) {
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let Some(port) = port.filter(|p| st.cfg.policy.allows_local(*p)) else {
        st.log(serde_json::json!({"ev": "deny", "id": id, "kind": "forward", "host": "127.0.0.1", "port": port, "reason": "local port not allowed", "atMs": st.now_ms()}));
        return;
    };
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpStream::connect_timeout(
        &target,
        Duration::from_secs(st.cfg.limits.connect_timeout_secs),
    ) {
        Ok(up) => {
            st.log(serde_json::json!({"ev": "open", "id": id, "kind": "forward", "host": "127.0.0.1", "port": port, "ip": "127.0.0.1", "atMs": st.now_ms()}));
            pipe(st, id, s, up, rest);
        }
        Err(e) => {
            st.log(serde_json::json!({"ev": "fail", "id": id, "kind": "forward", "host": "127.0.0.1", "port": port, "reason": format!("connection failed: {:?}", e.kind()), "atMs": st.now_ms()}));
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

struct Conn<'a> {
    st: &'a State,
    started: Instant,
    kill: AtomicBool,
    why: Mutex<Option<&'static str>>,
    last: AtomicU64,
}

impl Conn<'_> {
    fn stop(&self, why: &'static str) {
        let mut w = self.why.lock().unwrap_or_else(|p| p.into_inner());
        if w.is_none() {
            *w = Some(why);
        }
        self.kill.store(true, Ordering::SeqCst);
    }

    /// The reason this connection must end now, if any.
    fn must_stop(&self) -> bool {
        let lim = &self.st.cfg.limits;
        if self.kill.load(Ordering::SeqCst) {
            return true;
        }
        if self.st.shutdown.load(Ordering::SeqCst) || TERM.load(Ordering::SeqCst) {
            self.stop("shutdown");
        } else if self.started.elapsed().as_secs() >= lim.max_conn_secs {
            self.stop("lifetime");
        } else if self.st.total_bytes.load(Ordering::Relaxed) >= lim.max_total_bytes {
            self.stop("budget");
        }
        self.kill.load(Ordering::SeqCst)
    }
}

/// One direction of a connection: bounded buffer (no transfer is ever held whole), byte accounting, limits.
fn copy_dir<R: Read, W: Write>(c: &Conn, mut r: R, mut w: W, counter: &AtomicU64) {
    let mut buf = vec![0u8; 64 * 1024];
    let idle = c.st.cfg.limits.idle_secs;
    loop {
        if c.must_stop() {
            return;
        }
        match r.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if w.write_all(&buf[..n]).is_err() {
                    return;
                }
                counter.fetch_add(n as u64, Ordering::Relaxed);
                c.st.total_bytes.fetch_add(n as u64, Ordering::Relaxed);
                c.last
                    .store(c.started.elapsed().as_secs(), Ordering::Relaxed);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if c.started
                    .elapsed()
                    .as_secs()
                    .saturating_sub(c.last.load(Ordering::Relaxed))
                    >= idle
                {
                    c.stop("idle");
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

/// Copy both ways until both sides are done or a limit ends the connection.
fn pipe(st: &Arc<State>, id: u64, client: UnixStream, up: TcpStream, pending: Vec<u8>) {
    let conn = Conn {
        st,
        started: Instant::now(),
        kill: AtomicBool::new(false),
        why: Mutex::new(None),
        last: AtomicU64::new(0),
    };
    let (up_bytes, down_bytes) = (AtomicU64::new(0), AtomicU64::new(0));
    let _ = client.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = up.set_read_timeout(Some(Duration::from_millis(400)));
    let mut ok = true;
    if !pending.is_empty() {
        let mut u = &up;
        ok = u.write_all(&pending).is_ok();
        up_bytes.fetch_add(pending.len() as u64, Ordering::Relaxed);
        st.total_bytes
            .fetch_add(pending.len() as u64, Ordering::Relaxed);
    }
    if ok {
        std::thread::scope(|sc| {
            sc.spawn(|| {
                copy_dir(&conn, &client, &up, &up_bytes);
                let _ = up.shutdown(Shutdown::Write);
            });
            sc.spawn(|| {
                copy_dir(&conn, &up, &client, &down_bytes);
                let _ = client.shutdown(Shutdown::Write);
            });
        });
    }
    let how = conn
        .why
        .lock()
        .map(|w| w.unwrap_or("done"))
        .unwrap_or("done");
    st.log(serde_json::json!({
        "ev": "close", "id": id, "bytesUp": up_bytes.load(Ordering::Relaxed), "bytesDown": down_bytes.load(Ordering::Relaxed),
        "ms": conn.started.elapsed().as_millis() as u64, "how": how, "atMs": st.now_ms(),
    }));
}

/// What the supervisor learns from an audit trail: counts, bytes, denied destinations (names and ports only).
pub fn summarize(audit: &str) -> serde_json::Value {
    let (mut opens, mut closes, mut up, mut down) = (0u64, 0u64, 0u64, 0u64);
    let mut denied: Vec<String> = Vec::new();
    let mut allowed: std::collections::BTreeSet<String> = Default::default();
    let mut ended: BTreeMap<String, u64> = BTreeMap::new();
    let mut open_ids: std::collections::BTreeSet<u64> = Default::default();
    let mut failures = 0u64;
    for l in audit.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
            continue;
        };
        let id = v["id"].as_u64().unwrap_or(0);
        match v["ev"].as_str() {
            Some("open") => {
                opens += 1;
                open_ids.insert(id);
                allowed.insert(format!(
                    "{}:{}",
                    v["host"].as_str().unwrap_or("?"),
                    v["port"]
                ));
            }
            Some("close") => {
                closes += 1;
                open_ids.remove(&id);
                up += v["bytesUp"].as_u64().unwrap_or(0);
                down += v["bytesDown"].as_u64().unwrap_or(0);
                *ended
                    .entry(v["how"].as_str().unwrap_or("done").to_owned())
                    .or_default() += 1;
            }
            Some("deny") => {
                let d = format!("{}:{}", v["host"].as_str().unwrap_or("?"), v["port"]);
                if !denied.contains(&d) && denied.len() < 50 {
                    denied.push(d);
                }
            }
            Some("fail") => failures += 1,
            _ => {}
        }
    }
    serde_json::json!({
        "connections": opens, "closed": closes, "terminatedWhileOpen": open_ids.len(),
        "bytesUp": up, "bytesDown": down, "endedBy": ended,
        "destinations": allowed, "denied": denied, "connectFailures": failures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netpolicy::HostRule;
    use std::net::TcpListener;

    /// An egress service on its own socket whose public-looking names are test-mapped to local servers.
    struct Rig {
        dir: tempfile::TempDir,
    }

    fn rig(
        policy: NetPolicy,
        resolve: &[(&str, &str)],
        connect: &[(&str, String)],
        limits: EgressLimits,
    ) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let cfg = EgressConfig {
            policy_digest: policy.digest(),
            policy,
            limits,
            test_resolve: resolve
                .iter()
                .map(|(a, b)| ((*a).into(), (*b).into()))
                .collect(),
            test_connect: connect
                .iter()
                .map(|(a, b)| ((*a).into(), b.clone()))
                .collect(),
        };
        std::fs::write(
            dir.path().join(CONFIG_NAME),
            serde_json::to_vec(&cfg).unwrap(),
        )
        .unwrap();
        let d = dir.path().to_path_buf();
        std::thread::spawn(move || {
            let _ = serve(&d);
        });
        for _ in 0..200 {
            if dir.path().join(READY_NAME).exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Rig { dir }
    }

    impl Rig {
        fn conn(&self) -> UnixStream {
            let s = UnixStream::connect(self.dir.path().join(SOCKET_NAME)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            s
        }
        fn audit(&self) -> String {
            std::thread::sleep(Duration::from_millis(150));
            std::fs::read_to_string(self.dir.path().join(AUDIT_NAME)).unwrap_or_default()
        }
    }

    fn pol(hosts: &[(&str, &[u16])], local: &[u16]) -> NetPolicy {
        NetPolicy {
            hosts: hosts
                .iter()
                .map(|(h, p)| HostRule {
                    host: (*h).into(),
                    ports: p.to_vec(),
                })
                .collect(),
            local_ports: local.to_vec(),
        }
    }

    /// A server that answers every connection with `banner`, then echoes what it receives (and keeps a copy).
    fn echo_server(banner: &'static str) -> (u16, Arc<Mutex<Vec<u8>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let s3 = s2.clone();
                std::thread::spawn(move || {
                    let mut c = c;
                    let _ = c.write_all(banner.as_bytes());
                    let mut b = [0u8; 4096];
                    while let Ok(n) = c.read(&mut b) {
                        if n == 0 {
                            break;
                        }
                        s3.lock().unwrap().extend_from_slice(&b[..n]);
                        let _ = c.write_all(&b[..n]);
                    }
                });
            }
        });
        (port, seen)
    }

    fn status(resp: &str) -> u16 {
        resp.split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0)
    }

    fn read_some(s: &mut UnixStream) -> String {
        let mut b = vec![0u8; 8192];
        let n = s.read(&mut b).unwrap_or(0);
        String::from_utf8_lossy(&b[..n]).into_owned()
    }

    #[test]
    fn an_allowed_name_is_tunnelled_to_its_validated_address_and_everything_else_is_refused() {
        let (port, _) = echo_server("HELLO");
        let r = rig(
            pol(&[("api.example.com", &[443])], &[]),
            &[
                ("api.example.com", "8.8.4.4"),
                ("rebind.example.com", "10.1.2.3"),
                ("meta.example.com", "169.254.169.254"),
                ("loop.example.com", "127.0.0.1"),
                ("v6.example.com", "::ffff:127.0.0.1"),
            ],
            &[("8.8.4.4:443", format!("127.0.0.1:{port}"))],
            EgressLimits::default(),
        );
        let mut c = r.conn();
        c.write_all(b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n")
            .unwrap();
        let head = read_some(&mut c);
        assert_eq!(status(&head), 200, "{head}");
        let mut rest = head.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
        while !rest.contains("HELLO") {
            rest += &read_some(&mut c);
        }
        c.write_all(b"ping").unwrap();
        assert!(read_some(&mut c).contains("ping"));
        drop(c);
        // refused: other host, other port, IP literals, names that resolve to private/loopback/metadata space
        for (req, why) in [
            ("CONNECT other.example.com:443", "not in the allowed list"),
            ("CONNECT api.example.com:22", "not in the allowed list"),
            ("CONNECT 8.8.8.8:443", "IP addresses"),
            ("CONNECT [2606:4700::1111]:443", "IP addresses"),
            ("CONNECT 127.0.0.1:80", "IP addresses"),
            ("CONNECT 0x7f.1:443", "IP addresses"),
            (
                "CONNECT api.example.com.evil.test:443",
                "not in the allowed list",
            ),
        ] {
            let mut c = r.conn();
            c.write_all(format!("{req} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                .unwrap();
            let t = read_some(&mut c);
            assert_eq!(status(&t), 403, "{req}: {t}");
            assert!(t.contains(why), "{req}: {t}");
            assert!(
                t.contains("Nothing was sent") && t.contains("--allow-host"),
                "{t}"
            );
        }
        // DNS rebinding: an ALLOWED name whose answer is private / loopback / metadata
        let r2 = rig(
            pol(
                &[
                    ("rebind.example.com", &[443]),
                    ("meta.example.com", &[443]),
                    ("loop.example.com", &[443]),
                    ("v6.example.com", &[443]),
                ],
                &[],
            ),
            &[
                ("rebind.example.com", "10.1.2.3"),
                ("meta.example.com", "169.254.169.254"),
                ("loop.example.com", "127.0.0.1"),
                ("v6.example.com", "::ffff:127.0.0.1"),
            ],
            &[],
            EgressLimits::default(),
        );
        for h in ["rebind", "meta", "loop", "v6"] {
            let mut c = r2.conn();
            c.write_all(format!("CONNECT {h}.example.com:443 HTTP/1.1\r\n\r\n").as_bytes())
                .unwrap();
            let t = read_some(&mut c);
            assert_eq!(status(&t), 403, "{h}: {t}");
            assert!(t.contains("resolves to"), "{h}: {t}");
        }
        let a = r.audit();
        assert!(
            a.contains("\"ev\":\"open\"")
                && a.contains("api.example.com")
                && a.contains("\"ev\":\"deny\"")
        );
    }

    #[test]
    fn a_plain_http_request_is_forwarded_in_origin_form_without_proxy_headers_and_closes() {
        let (port, seen) = echo_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        let r = rig(
            pol(&[("files.example.org", &[80])], &[]),
            &[("files.example.org", "8.8.8.8")],
            &[("8.8.8.8:80", format!("127.0.0.1:{port}"))],
            EgressLimits::default(),
        );
        let mut c = r.conn();
        c.write_all(b"GET http://files.example.org/pkg/a.tgz?token=SECRET123 HTTP/1.1\r\nHost: files.example.org\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic AAA\r\nAuthorization: Bearer BBB\r\nUser-Agent: t\r\n\r\n").unwrap();
        let mut got = String::new();
        while !got.contains("ok") {
            let t = read_some(&mut c);
            if t.is_empty() {
                break;
            }
            got += &t;
        }
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        let sent = String::from_utf8_lossy(&seen.lock().unwrap()).into_owned();
        assert!(
            sent.starts_with("GET /pkg/a.tgz?token=SECRET123 HTTP/1.1\r\n"),
            "{sent}"
        );
        assert!(
            sent.contains("Connection: close") && sent.contains("Authorization: Bearer BBB"),
            "{sent}"
        );
        assert!(!sent.to_ascii_lowercase().contains("proxy-"), "{sent}");
        // https:// in a plain request, credentials in the URL, origin-form requests: refused
        for req in [
            "GET https://files.example.org/ HTTP/1.1",
            "GET http://u:p@files.example.org/ HTTP/1.1",
            "GET /x HTTP/1.1",
        ] {
            let mut c = r.conn();
            c.write_all(format!("{req}\r\nHost: x\r\n\r\n").as_bytes())
                .unwrap();
            assert_eq!(status(&read_some(&mut c)), 400, "{req}");
        }
        // the audit trail names destinations, never URLs, query strings, credentials or headers
        let a = r.audit();
        for secret in ["SECRET123", "Bearer", "BBB", "a.tgz", "Authorization"] {
            assert!(
                !a.contains(secret),
                "{secret} leaked into the audit trail: {a}"
            );
        }
        assert!(a.contains("files.example.org"));
    }

    #[test]
    fn a_redirect_is_just_another_request_and_is_judged_again() {
        let (port, _) = echo_server("HTTP/1.1 302 Found\r\nLocation: http://evil.example.net/steal\r\nContent-Length: 0\r\n\r\n");
        let r = rig(
            pol(&[("start.example.org", &[80])], &[]),
            &[
                ("start.example.org", "8.8.8.8"),
                ("evil.example.net", "8.8.4.4"),
            ],
            &[("8.8.8.8:80", format!("127.0.0.1:{port}"))],
            EgressLimits::default(),
        );
        let mut c = r.conn();
        c.write_all(b"GET http://start.example.org/ HTTP/1.1\r\nHost: start.example.org\r\n\r\n")
            .unwrap();
        let t = read_some(&mut c);
        assert!(t.contains("302") && t.contains("evil.example.net"), "{t}");
        // the client follows the redirect through the same proxy
        let mut c = r.conn();
        c.write_all(
            b"GET http://evil.example.net/steal HTTP/1.1\r\nHost: evil.example.net\r\n\r\n",
        )
        .unwrap();
        let t = read_some(&mut c);
        assert_eq!(status(&t), 403, "{t}");
    }

    #[test]
    fn only_granted_local_ports_are_forwarded_and_only_to_this_machine() {
        let (port, _) = echo_server("DEV");
        let (other, _) = echo_server("SECRETSERVICE");
        let r = rig(pol(&[], &[port]), &[], &[], EgressLimits::default());
        let mut c = r.conn();
        c.write_all(format!("{FORWARD_PREFACE}{port}\n").as_bytes())
            .unwrap();
        assert!(read_some(&mut c).contains("DEV"));
        let mut c = r.conn();
        c.write_all(format!("{FORWARD_PREFACE}{other}\n").as_bytes())
            .unwrap();
        assert_eq!(
            read_some(&mut c),
            "",
            "an ungranted local port must not connect"
        );
        // a local port cannot be reached by name or address through the proxy either
        for t in [
            format!("CONNECT localhost:{port}"),
            format!("CONNECT 127.0.0.1:{port}"),
        ] {
            let mut c = r.conn();
            c.write_all(format!("{t} HTTP/1.1\r\n\r\n").as_bytes())
                .unwrap();
            assert_eq!(status(&read_some(&mut c)), 403);
        }
        let a = r.audit();
        assert!(a.contains("local port not allowed"));
    }

    #[test]
    fn idle_lifetime_budget_and_concurrency_limits_end_connections() {
        let (port, _) = echo_server("X");
        let lim = EgressLimits {
            idle_secs: 1,
            max_conns: 2,
            max_total_bytes: 4096,
            ..Default::default()
        };
        let r = rig(
            pol(&[("a.example.com", &[443])], &[]),
            &[("a.example.com", "8.8.8.8")],
            &[("8.8.8.8:443", format!("127.0.0.1:{port}"))],
            lim,
        );
        let open = |r: &Rig| {
            let mut c = r.conn();
            c.write_all(b"CONNECT a.example.com:443 HTTP/1.1\r\n\r\n")
                .unwrap();
            let t = read_some(&mut c);
            (c, t)
        };
        let (mut c1, t1) = open(&r);
        assert_eq!(status(&t1), 200);
        let (_c2, t2) = open(&r);
        assert_eq!(status(&t2), 200);
        // a third connection beyond the limit is refused
        let mut c3 = r.conn();
        c3.write_all(b"CONNECT a.example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        assert_eq!(status(&read_some(&mut c3)), 503);
        // idle connections are closed
        std::thread::sleep(Duration::from_millis(2600));
        let mut b = [0u8; 16];
        let mut n = 1;
        for _ in 0..4 {
            n = c1.read(&mut b).unwrap_or(0); // (the server's banner may still be queued)
            if n == 0 {
                break;
            }
        }
        assert_eq!(n, 0, "an idle tunnel stayed open");
        assert!(r.audit().contains("\"how\":\"idle\""));
        // the byte budget ends transfers
        let (mut c4, t4) = open(&r);
        assert_eq!(status(&t4), 200);
        let big = vec![b'z'; 8192];
        let _ = c4.write_all(&big);
        std::thread::sleep(Duration::from_millis(1500));
        let mut sink = vec![0u8; 65536];
        let mut total = 0;
        while let Ok(n) = c4.read(&mut sink) {
            if n == 0 {
                break;
            }
            total += n;
            if total > 1_000_000 {
                break;
            }
        }
        assert!(r.audit().contains("\"how\":\"budget\"") || r.audit().contains("\"how\":\"idle\""));
    }

    #[test]
    fn the_summary_counts_connections_bytes_and_denied_destinations_only() {
        let (port, _) = echo_server("Z");
        let r = rig(
            pol(&[("a.example.com", &[443])], &[]),
            &[("a.example.com", "8.8.8.8")],
            &[("8.8.8.8:443", format!("127.0.0.1:{port}"))],
            EgressLimits::default(),
        );
        let mut c = r.conn();
        c.write_all(b"CONNECT a.example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        read_some(&mut c);
        c.write_all(b"12345").unwrap();
        read_some(&mut c);
        drop(c);
        let mut d = r.conn();
        d.write_all(b"CONNECT nope.example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        read_some(&mut d);
        let sum = summarize(&r.audit());
        assert_eq!(sum["connections"], 1, "{sum}");
        assert!(sum["bytesUp"].as_u64().unwrap() >= 5, "{sum}");
        assert_eq!(sum["denied"], serde_json::json!(["nope.example.com:443"]));
        assert_eq!(
            sum["destinations"],
            serde_json::json!(["a.example.com:443"])
        );
    }

    #[test]
    fn a_policy_file_that_does_not_match_its_digest_is_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = EgressConfig {
            policy: pol(&[("a.example.com", &[443])], &[]),
            policy_digest: "0".repeat(64),
            ..Default::default()
        };
        std::fs::write(
            dir.path().join(CONFIG_NAME),
            serde_json::to_vec(&cfg).unwrap(),
        )
        .unwrap();
        assert!(serve(dir.path()).is_err());
    }
}
