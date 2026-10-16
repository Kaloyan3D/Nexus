//! `nexus-broker`: the intent broker daemon. Run as the issuer identity.

use nexus_broker::BrokerConfig;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn usage() -> i32 {
    eprintln!(
        "usage: nexus-broker --state-dir D --socket S --daemon-socket S --cap F --credentials F"
    );
    eprintln!(
        "         --repo-root D --registry-data-root D [--transcript-dir D] [--ledger-workspace D]"
    );
    eprintln!("         [--allowed-uids U,U] [--socket-group GID] [--node PATH] [--max-active N]");
    eprintln!("         [--rate-per-minute N] [--allow-model provider/model]... [--read-timeout-ms N] [--total-timeout-ms N]");
    eprintln!("Runs as the issuer identity. Refuses to start unless the daemon has the model pilot enabled.");
    2
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |n: &str| {
        args.iter()
            .position(|a| a == n)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let need = |n: &str| get(n).ok_or_else(|| format!("{n} is required"));
    let build = || -> Result<BrokerConfig, String> {
        let state = PathBuf::from(need("--state-dir")?);
        let mut limits = nexus_client::TransportLimits::default();
        if let Some(v) = get("--read-timeout-ms") {
            limits.read_timeout_ms = v.parse().map_err(|_| "--read-timeout-ms".to_owned())?;
        }
        if let Some(v) = get("--total-timeout-ms") {
            limits.total_timeout_ms = v.parse().map_err(|_| "--total-timeout-ms".to_owned())?;
        }
        let allow: Vec<(String, String)> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| *a == "--allow-model")
            .filter_map(|(i, _)| args.get(i + 1))
            .filter_map(|v| v.split_once('/').map(|(p, m)| (p.to_owned(), m.to_owned())))
            .collect();
        Ok(BrokerConfig {
            ledger_workspace: get("--ledger-workspace")
                .map(PathBuf::from)
                .unwrap_or_else(|| state.join("ledger")),
            transcript_dir: get("--transcript-dir")
                .map(PathBuf::from)
                .unwrap_or_else(nexus_client::default_transcript_dir),
            socket_path: PathBuf::from(need("--socket")?),
            socket_group: get("--socket-group").and_then(|v| v.parse().ok()),
            allowed_uids: get("--allowed-uids")
                .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                .unwrap_or_default(),
            daemon_socket: PathBuf::from(need("--daemon-socket")?),
            cap_path: PathBuf::from(need("--cap")?),
            credentials_path: PathBuf::from(need("--credentials")?),
            repo_root: PathBuf::from(need("--repo-root")?),
            registry_data_root: PathBuf::from(need("--registry-data-root")?),
            node: get("--node").unwrap_or_else(|| "node".to_owned()),
            extra_trusted_owner_uids: Vec::new(),
            max_active: get("--max-active")
                .and_then(|v| v.parse().ok())
                .unwrap_or(2),
            rate_per_minute: get("--rate-per-minute")
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            limits,
            allow_models: allow,
            transport: None,
            state_dir: state,
        })
    };
    #[cfg_attr(not(feature = "test-fixtures"), allow(unused_mut))]
    let mut built = build();
    #[cfg(feature = "test-fixtures")]
    if let Ok(cfg) = built.as_mut() {
        if let (Some(ca), Some(ip)) = (get("--test-tls-ca"), get("--test-resolve")) {
            eprintln!("nexus-broker: TEST-FIXTURES BUILD: fixture CA and resolver injected (offline acceptance only)");
            if let Some(u) = get("--test-trust-owner-uid").and_then(|v| v.parse().ok()) {
                cfg.extra_trusted_owner_uids.push(u);
            }
            let der = std::fs::read(&ca).expect("--test-tls-ca file");
            let mut roots = rustls::RootCertStore::empty();
            roots
                .add(rustls::pki_types::CertificateDer::from(der))
                .expect("fixture CA parses");
            let tls = nexus_model::egress::tls_config_with_roots(roots);
            let ip: std::net::IpAddr = ip.parse().expect("--test-resolve IP");
            cfg.transport = Some(nexus_client::TransportFactory(std::sync::Arc::new(
                move |binding| {
                    nexus_model::HttpSseTransport::with_parts(
                        binding,
                        std::sync::Arc::new(nexus_model::testkit::ScriptedResolver::new(vec![
                            vec![ip],
                        ])),
                        nexus_model::egress::AddressPolicy::PublicOrLoopbackForTests,
                        tls.clone(),
                    )
                },
            )));
        }
    }
    let cfg = match built {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nexus-broker: {e}");
            return usage();
        }
    };
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as usize);
        libc::signal(libc::SIGINT, on_signal as *const () as usize);
    }
    let handle = match nexus_broker::start(cfg) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("nexus-broker: refusing to start: {e}");
            return 3;
        }
    };
    eprintln!(
        "nexus-broker: listening on {}",
        handle.socket_path().display()
    );
    while !STOP.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    handle.shutdown();
    0
}
