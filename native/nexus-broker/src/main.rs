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
    eprintln!("         [--workspace ID=ABS_PATH]... [--workspace-allow ID=UID,UID]...   (A5.5 repo-inspect workspaces)");
    eprintln!("         [--code-source ID=ABS_PATH]... [--code-allow ID=UID,UID]...   (A5.6 repo-code sources; the daemon also needs --enable-repo-code --worktree-root)");
    eprintln!("Runs as the issuer identity. Refuses to start unless the daemon has the model pilot enabled.");
    2
}

fn main() {
    std::process::exit(run());
}

fn authorize_live(args: &[String]) -> i32 {
    let get = |n: &str| {
        args.iter()
            .position(|a| a == n)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let r = (|| -> Result<_, String> {
        let state = PathBuf::from(get("--state-dir").ok_or("--state-dir is required")?);
        // Never authorize spending against a broker running an older build.
        let me = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
        match nexus_broker::identity::running_broker(&state, &me) {
            nexus_broker::identity::Running::Stale(pid) => {
                return Err(format!(
                    "the running broker (pid {pid}) is an older build than this binary; restart it first (no authorization written)"
                ))
            }
            nexus_broker::identity::Running::None => {
                eprintln!("nexus-broker authorize-live: note: no running broker recorded for this state directory")
            }
            nexus_broker::identity::Running::Current(_) => {}
        }
        let prompt =
            std::fs::read_to_string(get("--prompt-file").ok_or("--prompt-file is required")?)
                .map_err(|e| format!("prompt file: {e}"))?;
        let num = |n: &str| -> Result<u64, String> {
            get(n)
                .ok_or(format!("{n} is required"))?
                .parse()
                .map_err(|_| format!("{n} must be a number"))
        };
        nexus_broker::live_auth::write_record(
            &state,
            &get("--provider").ok_or("--provider is required")?,
            &get("--model").ok_or("--model is required")?,
            &prompt,
            num("--max-output-tokens")?,
            num("--expires-in-secs")?,
            args.iter().any(|a| a == "--acknowledge-billable"),
        )
    })();
    match r {
        Ok(rec) => {
            println!(
                "authorized ONE live attempt: provider={} model={} promptSha256={} maxOutputTokens={} expiresAtMs={}",
                rec.provider_id, rec.remote_model_id, rec.prompt_sha256, rec.max_output_tokens, rec.expires_at_ms
            );
            0
        }
        Err(e) => {
            eprintln!("nexus-broker authorize-live: {e}");
            2
        }
    }
}

/// `nexus-broker identity --state-dir D`: exit 0 = a current broker runs,
/// 3 = a STALE broker runs, 4 = none recorded. Read-only.
fn identity_report(args: &[String]) -> i32 {
    let Some(state) = args
        .iter()
        .position(|a| a == "--state-dir")
        .and_then(|i| args.get(i + 1))
    else {
        eprintln!("--state-dir is required");
        return 2;
    };
    let Ok(me) = std::env::current_exe() else {
        return 2;
    };
    match nexus_broker::identity::running_broker(&PathBuf::from(state), &me) {
        nexus_broker::identity::Running::Current(pid) => {
            println!("broker pid {pid}: runs the installed binary");
            0
        }
        nexus_broker::identity::Running::Stale(pid) => {
            println!("broker pid {pid}: STALE (older build than the installed binary; restart it)");
            3
        }
        nexus_broker::identity::Running::None => {
            println!("no running broker recorded");
            4
        }
    }
}

/// `--workspace ID=ABS_PATH` (repeatable) and optional
/// `--workspace-allow ID=UID,UID`.
fn parse_workspaces(args: &[String]) -> Result<Vec<nexus_broker::WorkspaceSpec>, String> {
    parse_specs(args, "--workspace", "--workspace-allow")
}

/// `--code-source ID=ABS_PATH` and optional `--code-allow ID=UID,UID` (A5.6).
fn parse_code_sources(args: &[String]) -> Result<Vec<nexus_broker::WorkspaceSpec>, String> {
    parse_specs(args, "--code-source", "--code-allow")
}

fn parse_specs(
    args: &[String],
    flag: &str,
    allow_flag: &str,
) -> Result<Vec<nexus_broker::WorkspaceSpec>, String> {
    let mut out: Vec<nexus_broker::WorkspaceSpec> = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if a != flag {
            continue;
        }
        let v = args.get(i + 1).ok_or(format!("{flag} needs ID=PATH"))?;
        let (id, path) = v.split_once('=').ok_or(format!("{flag} needs ID=PATH"))?;
        if out.iter().any(|w| w.id == id) {
            return Err(format!("duplicate workspace id {id}"));
        }
        out.push(nexus_broker::WorkspaceSpec {
            id: id.to_owned(),
            root: PathBuf::from(path),
            allowed_uids: Vec::new(),
        });
    }
    for (i, a) in args.iter().enumerate() {
        if a != allow_flag {
            continue;
        }
        let v = args
            .get(i + 1)
            .ok_or(format!("{allow_flag} needs ID=UID,UID"))?;
        let (id, uids) = v
            .split_once('=')
            .ok_or(format!("{allow_flag} needs ID=UID,UID"))?;
        let w = out
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| format!("{allow_flag} names unknown workspace {id}"))?;
        w.allowed_uids = uids
            .split(',')
            .filter_map(|x| x.trim().parse().ok())
            .collect();
    }
    Ok(out)
}

/// A5.5: `authorize-live-session` writes the bounded, single-use session
/// budget a live repo-inspect run needs (several billable provider calls).
fn authorize_live_session(args: &[String]) -> i32 {
    let get = |n: &str| {
        args.iter()
            .position(|a| a == n)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let r = (|| -> Result<_, String> {
        let state = PathBuf::from(get("--state-dir").ok_or("--state-dir is required")?);
        let me = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
        if let nexus_broker::identity::Running::Stale(pid) =
            nexus_broker::identity::running_broker(&state, &me)
        {
            return Err(format!(
                "the running broker (pid {pid}) is an older build than this binary; restart it first (no authorization written)"
            ));
        }
        let prompt =
            std::fs::read_to_string(get("--prompt-file").ok_or("--prompt-file is required")?)
                .map_err(|e| format!("prompt file: {e}"))?;
        let num = |n: &str| -> Result<u64, String> {
            get(n)
                .ok_or(format!("{n} is required"))?
                .parse()
                .map_err(|_| format!("{n} must be a number"))
        };
        nexus_broker::live_auth::write_session_record_for(
            &get("--intent-type").unwrap_or_else(|| "repo-inspect".to_owned()),
            &state,
            &get("--provider").ok_or("--provider is required")?,
            &get("--model").ok_or("--model is required")?,
            &get("--workspace").ok_or("--workspace is required")?,
            &prompt,
            num("--max-turns")? as u32,
            num("--max-tool-calls")? as u32,
            num("--max-output-tokens")?,
            num("--max-tool-result-bytes")?,
            num("--expires-in-secs")?,
            args.iter().any(|a| a == "--acknowledge-billable"),
        )
    })();
    match r {
        Ok(rec) => {
            println!(
                "authorized ONE live {} SESSION: provider={} model={} workspace={} promptSha256={} maxTurns={} maxToolCalls={} maxOutputTokensPerCall={} maxToolResultBytes={} expiresAtMs={}",
                rec.intent_type, rec.provider_id, rec.remote_model_id, rec.workspace_id, rec.prompt_sha256,
                rec.max_turns, rec.max_tool_calls, rec.max_output_tokens, rec.max_tool_result_bytes,
                rec.expires_at_ms
            );
            println!(
                "up to {} billable provider calls; selected repository contents{} will be sent to the provider",
                rec.max_turns,
                if rec.intent_type == "repo-code" { " and build/test command output" } else { "" }
            );
            0
        }
        Err(e) => {
            eprintln!("nexus-broker authorize-live-session: {e}");
            2
        }
    }
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("authorize-live") {
        return authorize_live(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("authorize-live-session") {
        return authorize_live_session(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("identity") {
        return identity_report(&args[1..]);
    }
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
            workspaces: parse_workspaces(&args)?,
            code_sources: parse_code_sources(&args)?,
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
