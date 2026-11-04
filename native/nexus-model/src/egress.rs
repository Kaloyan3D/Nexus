//! A5.2 egress policy, address pinning and TLS establishment.
//!
//! Owns everything between "the Registry sealed this origin" and "bytes may
//! be written": destination approval, DNS resolution, address pinning and
//! the rustls handshake. Nothing else in the model path opens a socket.
//!
//! Guarantees (each pinned by tests in `tests/tls_a52.rs`):
//!
//! * The origin is resolved **exactly once** per send. Every candidate
//!   address is classified; ONE prohibited address (loopback, private,
//!   link-local, multicast, CGNAT, ULA, metadata, 6to4/Teredo/NAT64 or an
//!   IPv4-mapped form of any of those) refuses the whole destination, so a
//!   mixed answer cannot be used to "pick the good one".
//! * The connection is made to an approved *IP address*, never to the
//!   name, so a second (rebinding) resolution cannot redirect it. The
//!   original host name is kept for SNI and certificate verification.
//! * TLS verification is mandatory: webpki chain + hostname validation,
//!   TLS 1.3 preferred, 1.2 minimum, no client auth, no early data, ALPN
//!   `http/1.1`. There is no switch that disables verification. Trust
//!   anchors are the Mozilla set from `webpki-roots` (compiled in; the
//!   host trust store is never consulted, so no ambient configuration
//!   changes who is trusted).
//! * The credential is written only after the handshake succeeded.
//! * No proxy support exists: `HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` and
//!   friends are never read.
//! * Plain `http` is accepted only when every resolved address is loopback
//!   (the explicit offline fixture policy).

use crate::error::{redact, ModelError, ModelErrorCode};
use crate::stream::CancellationToken;
use nexus_contracts::{classify_host, classify_ip, DestinationVerdict};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Upper bound for the TCP connect of one candidate address.
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
/// Upper bound for the TLS handshake (also bounded by the exchange deadline).
pub const HANDSHAKE_TIMEOUT_MS: u64 = 15_000;
/// Socket slice used so cancellation/deadlines are observed promptly.
pub const IO_SLICE_MS: u64 = 100;

/// Name resolution seam. Production uses the system resolver; tests inject
/// scripted answers (including rebinding answers) to prove the policy.
pub trait Resolver: Send + Sync + std::fmt::Debug {
    /// Resolve `host` to addresses. Called at most once per send.
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

/// `getaddrinfo` via `std::net`. Never consults proxy variables.
#[derive(Debug, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok((host, port).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

/// A resolver that returns a fixed, already-obtained answer (used to feed
/// the single bounded resolution into the policy check).
#[derive(Debug)]
pub struct FixedResolver(pub Vec<IpAddr>);

impl Resolver for FixedResolver {
    fn resolve(&self, _host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}

/// Resolve on a helper thread so a stuck resolver can neither outlive the
/// exchange deadline nor ignore cancellation (`getaddrinfo` itself cannot be
/// interrupted; the abandoned thread finishes harmlessly and its answer is
/// discarded). Called at most once per send.
pub fn resolve_bounded(
    resolver: &Arc<dyn Resolver>,
    host: &str,
    port: u16,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Vec<IpAddr>, ModelError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (r, h) = (Arc::clone(resolver), host.to_owned());
    std::thread::spawn(move || {
        let _ = tx.send(r.resolve(&h, port));
    });
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        if Instant::now() >= deadline {
            return Err(ModelError::new(
                ModelErrorCode::Timeout,
                "exchange deadline expired while resolving the destination (nothing sent)",
            ));
        }
        match rx.recv_timeout(Duration::from_millis(IO_SLICE_MS / 2)) {
            Ok(Ok(v)) => return Ok(v),
            Ok(Err(e)) => {
                return Err(ModelError::new(
                    ModelErrorCode::DestinationRefused,
                    format!("destination did not resolve: {}", redact(&e.to_string())),
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(refuse("resolver terminated without an answer"))
            }
        }
    }
}

/// Which resolved addresses an `https` destination may connect to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressPolicy {
    /// Production: public addresses only.
    PublicOnly,
    /// Offline fixtures only: public **or loopback**. Private, link-local,
    /// multicast and the rest stay prohibited. Never the default; reachable
    /// only through `testkit`/`HttpSseTransport::with_parts`.
    PublicOrLoopbackForTests,
}

/// URL scheme of an approved destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

/// A destination that passed the egress policy, with the pinned addresses.
#[derive(Debug, Clone)]
pub struct ApprovedDestination {
    pub scheme: Scheme,
    /// Original host name: used for SNI, certificate verification and the
    /// `Host` header — never for connecting.
    pub host: String,
    pub port: u16,
    /// Approved socket addresses, in resolver order.
    pub addrs: Vec<SocketAddr>,
}

fn refuse(msg: impl Into<String>) -> ModelError {
    ModelError::new(ModelErrorCode::DestinationRefused, msg)
}

/// Split `scheme://host[:port]` with strict validation.
pub fn parse_origin(origin: &str) -> Result<(Scheme, String, u16), ModelError> {
    let (scheme, rest) = origin.split_once("://").ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint origin lacks a scheme",
        )
    })?;
    let scheme_v = match scheme {
        "http" => Scheme::Http,
        "https" => Scheme::Https,
        _ => {
            return Err(ModelError::new(
                ModelErrorCode::EndpointMismatch,
                "endpoint scheme is neither http nor https",
            ))
        }
    };
    let host_part = rest.split('/').next().unwrap_or("");
    if host_part.contains('@') {
        return Err(ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint origin must not carry userinfo",
        ));
    }
    let default_port = if scheme_v == Scheme::Https { 443 } else { 80 };
    let (host, port) = if let Some(stripped) = host_part.strip_prefix('[') {
        let (h, tail) = stripped.split_once(']').ok_or_else(|| {
            ModelError::new(
                ModelErrorCode::EndpointMismatch,
                "unterminated IPv6 literal",
            )
        })?;
        let port = match tail.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| {
                ModelError::new(
                    ModelErrorCode::EndpointMismatch,
                    "endpoint origin port invalid",
                )
            })?,
            None if tail.is_empty() => default_port,
            None => {
                return Err(ModelError::new(
                    ModelErrorCode::EndpointMismatch,
                    "endpoint origin is malformed",
                ))
            }
        };
        (h.to_owned(), port)
    } else {
        match host_part.rsplit_once(':') {
            Some((h, p)) => (
                h.to_owned(),
                p.parse::<u16>().map_err(|_| {
                    ModelError::new(
                        ModelErrorCode::EndpointMismatch,
                        "endpoint origin port invalid",
                    )
                })?,
            ),
            None => (host_part.to_owned(), default_port),
        }
    };
    if host.trim().is_empty() || !host.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ModelError::new(
            ModelErrorCode::EndpointMismatch,
            "endpoint host is empty or carries forbidden characters",
        ));
    }
    Ok((scheme_v, host, port))
}

fn literal_of(host: &str) -> Option<IpAddr> {
    host.trim_matches(|c| c == '[' || c == ']')
        .parse::<IpAddr>()
        .ok()
}

/// Syntactic screen, run BEFORE any resolver query: obfuscated numeric
/// hosts, local names and single-label names never reach the resolver.
fn screen_host(scheme: Scheme, host: &str, literal: Option<IpAddr>) -> Result<(), ModelError> {
    if scheme == Scheme::Https && literal.is_none() {
        let v = classify_host(host);
        if !v.is_public() {
            return Err(refuse(format!(
                "https host {} is not a public provider name ({v:?})",
                redact(host)
            )));
        }
    }
    Ok(())
}

fn classify_candidates(
    scheme: Scheme,
    host: String,
    port: u16,
    candidates: Vec<IpAddr>,
    policy: AddressPolicy,
) -> Result<ApprovedDestination, ModelError> {
    if candidates.is_empty() {
        return Err(refuse("destination resolved to no addresses"));
    }
    for ip in &candidates {
        let verdict = classify_ip(*ip);
        let allowed = match scheme {
            Scheme::Http => matches!(verdict, DestinationVerdict::Loopback),
            Scheme::Https => {
                verdict.is_public()
                    || (policy == AddressPolicy::PublicOrLoopbackForTests
                        && matches!(verdict, DestinationVerdict::Loopback))
            }
        };
        if !allowed {
            return Err(refuse(format!(
                "resolved address {ip} is not permitted for this destination ({verdict:?}); refusing the whole destination"
            )));
        }
    }
    Ok(ApprovedDestination {
        scheme,
        host,
        port,
        addrs: candidates
            .into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect(),
    })
}

/// Approve a destination: validate, resolve once, classify every address.
/// (Synchronous, uncancellable form used by tests and literals; the
/// transport uses [`approve_destination_bounded`].)
pub fn approve_destination(
    origin: &str,
    resolver: &dyn Resolver,
    policy: AddressPolicy,
) -> Result<ApprovedDestination, ModelError> {
    let (scheme, host, port) = parse_origin(origin)?;
    let literal = literal_of(&host);
    screen_host(scheme, &host, literal)?;
    let candidates = match literal {
        Some(ip) => vec![ip],
        None => resolver.resolve(&host, port).map_err(|e| {
            ModelError::new(
                ModelErrorCode::DestinationRefused,
                format!("destination did not resolve: {}", redact(&e.to_string())),
            )
        })?,
    };
    classify_candidates(scheme, host, port, candidates, policy)
}

/// Same policy as [`approve_destination`], with the resolution bounded by
/// the exchange deadline and observing cancellation.
pub fn approve_destination_bounded(
    origin: &str,
    resolver: &Arc<dyn Resolver>,
    policy: AddressPolicy,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<ApprovedDestination, ModelError> {
    let (scheme, host, port) = parse_origin(origin)?;
    let literal = literal_of(&host);
    screen_host(scheme, &host, literal)?;
    let candidates = match literal {
        Some(ip) => vec![ip],
        None => resolve_bounded(resolver, &host, port, cancel, deadline)?,
    };
    classify_candidates(scheme, host, port, candidates, policy)
}

/// Production TLS client configuration (built once).
pub fn default_tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        tls_config_with_roots(roots)
    })
    .clone()
}

/// Build a verifying client config over `roots`. Verification is always on:
/// there is no constructor that skips it.
pub fn tls_config_with_roots(roots: rustls::RootCertStore) -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .expect("TLS 1.3/1.2 are supported by the ring provider")
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg.enable_early_data = false;
    cfg.enable_sni = true;
    Arc::new(cfg)
}

/// An established, policy-checked connection.
pub enum Conn {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Conn {
    /// Best-effort orderly close (TLS close_notify, then drop).
    pub fn close(&mut self) {
        if let Conn::Tls(s) = self {
            s.conn.send_close_notify();
            let _ = s.flush();
        }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.close();
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(buf),
            Conn::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(buf),
            Conn::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(s) => s.flush(),
        }
    }
}

fn cancelled() -> ModelError {
    ModelError::new(
        ModelErrorCode::Cancelled,
        "cancelled before sending (no bytes sent)",
    )
}

fn classify_tls_error(e: &rustls::Error) -> String {
    use rustls::{CertificateError as C, Error as E};
    let what = match e {
        E::InvalidCertificate(C::UnknownIssuer) => "certificate issuer is not trusted",
        E::InvalidCertificate(C::NotValidForName)
        | E::InvalidCertificate(C::NotValidForNameContext { .. }) => {
            "certificate is not valid for the requested host name"
        }
        E::InvalidCertificate(C::Expired) | E::InvalidCertificate(C::ExpiredContext { .. }) => {
            "certificate has expired"
        }
        E::InvalidCertificate(C::NotValidYet)
        | E::InvalidCertificate(C::NotValidYetContext { .. }) => "certificate is not yet valid",
        E::InvalidCertificate(C::Revoked) => "certificate was revoked",
        E::InvalidCertificate(_) => "certificate validation failed",
        E::PeerIncompatible(_) => "peer offers no compatible TLS parameters",
        E::AlertReceived(_) => "peer aborted the handshake",
        E::NoCertificatesPresented => "peer presented no certificate",
        _ => "TLS protocol failure",
    };
    what.to_owned()
}

/// Connect to an approved destination and (for https) complete the TLS
/// handshake. Returns only a fully verified connection; on any failure no
/// application byte (and therefore no credential) has been written.
///
/// Honors `cancel` and `deadline` at every step, including the handshake.
pub fn connect(
    dest: &ApprovedDestination,
    tls: &Arc<rustls::ClientConfig>,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Conn, ModelError> {
    let mut last: Option<String> = None;
    let mut tcp: Option<TcpStream> = None;
    for addr in &dest.addrs {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(ModelError::new(
                ModelErrorCode::Timeout,
                "exchange deadline expired while connecting (nothing sent)",
            ));
        }
        let budget = Duration::from_millis(CONNECT_TIMEOUT_MS).min(left);
        match TcpStream::connect_timeout(addr, budget) {
            Ok(s) => {
                // Defense in depth: the socket really reached the address
                // that was approved.
                if s.peer_addr().ok().map(|p| p.ip()) != Some(addr.ip()) {
                    return Err(refuse("connected peer differs from the approved address"));
                }
                tcp = Some(s);
                break;
            }
            Err(e) => last = Some(redact(&e.to_string())),
        }
    }
    let tcp = tcp.ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::Disconnected,
            format!(
                "connection to the approved address failed: {}",
                last.unwrap_or_else(|| "no address".to_owned())
            ),
        )
    })?;
    let _ = tcp.set_nodelay(true);
    let slice = Duration::from_millis(IO_SLICE_MS);
    tcp.set_read_timeout(Some(slice))
        .and_then(|_| tcp.set_write_timeout(Some(slice)))
        .map_err(|e| {
            ModelError::new(
                ModelErrorCode::TransportRefused,
                format!("socket deadline unsettable: {}", redact(&e.to_string())),
            )
        })?;
    if dest.scheme == Scheme::Http {
        return Ok(Conn::Plain(tcp));
    }
    let name = rustls::pki_types::ServerName::try_from(dest.host.clone()).map_err(|_| {
        ModelError::new(
            ModelErrorCode::TlsFailed,
            "host name is not valid for TLS server-name verification",
        )
    })?;
    let mut conn = rustls::ClientConnection::new(tls.clone(), name).map_err(|e| {
        ModelError::new(
            ModelErrorCode::TlsFailed,
            format!("TLS session could not start: {}", classify_tls_error(&e)),
        )
    })?;
    let mut tcp = tcp;
    let hs_deadline = deadline.min(Instant::now() + Duration::from_millis(HANDSHAKE_TIMEOUT_MS));
    while conn.is_handshaking() {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        if Instant::now() >= hs_deadline {
            return Err(ModelError::new(
                ModelErrorCode::Timeout,
                "TLS handshake deadline expired (nothing sent)",
            ));
        }
        match conn.complete_io(&mut tcp) {
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => {
                // rustls wraps its own errors in io::Error(InvalidData).
                let detail = e
                    .get_ref()
                    .and_then(|i| i.downcast_ref::<rustls::Error>())
                    .map(classify_tls_error)
                    .unwrap_or_else(|| format!("handshake I/O failed: {}", redact(&e.to_string())));
                return Err(ModelError::new(
                    ModelErrorCode::TlsFailed,
                    format!("TLS handshake failed: {detail}"),
                ));
            }
        }
    }
    Ok(Conn::Tls(Box::new(rustls::StreamOwned::new(conn, tcp))))
}
