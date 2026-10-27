//! Nexus native CLI (A2.4 Phase 3).
//!
//! Independent of DSH, its wrappers, and the DSH web frontend. All state
//! arrives through nexus-client v1: daemon IPC for kernel status and an
//! explicitly isolated mock workflow for `run --mock`. Real execution
//! reports the live blockers and exits without network traffic.

use nexus_client::{ClientConfig, ExitCode};
use std::path::PathBuf;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn help_text() -> String {
    let mut s = String::new();
    s.push_str("nexus 0.1.0 -- Nexus native CLI (Client API v1)\n");
    s.push_str("\nUSAGE:\n");
    s.push_str("    nexus [GLOBAL FLAGS] <COMMAND> [ARGS]\n");
    s.push_str("\nGLOBAL FLAGS:\n");
    s.push_str("    --socket <path>       daemon socket (or NEXUS_SOCKET)\n");
    s.push_str("    --ledger-dir <dir>    Controller ledger dir (or NEXUS_LEDGER_DIR)\n");
    s.push_str("    --json                machine-readable JSON output\n");
    s.push_str("    -h, --help            print this help\n");
    s.push_str("    -V, --version         print version\n");
    s.push_str("\nCOMMANDS:\n");
    s.push_str("    status                daemon + readiness status\n");
    s.push_str("    doctor                local checks (daemon, socket, toolchain)\n");
    s.push_str("    tasks                 list tasks from the read-only ledger\n");
    s.push_str("    task show <task-id>   task details\n");
    s.push_str("    models                registry model catalog (mock offline; live blocked)\n");
    s.push_str("    config show           client configuration (paths only, no secrets)\n");
    s.push_str(
        "    run --mock \"<prompt>\"  isolated mock execution (never contacts a live provider)\n",
    );
    s.push_str("    run                   live execution gate (always blocked in A2.4)\n");
    s.push_str("    interactive           line-based interactive session (mock only)\n");
    s.push_str("    intent submit|status|result|follow|cancel|list|models|workspaces   A5.3 unprivileged intent client (talks to nexus-broker only;\n");
    s.push_str("                          needs no issuer capability and no provider credential; see `nexus intent --help`)\n");
    s.push_str("    model prepare --request <file>      A5.1 pure request preparation (digest, target, endpoint); sends nothing\n");
    s.push_str("    model run --request <file> --grant <file> --cap <file> --credentials <file>\n");
    s.push_str("                          A5.1 user-initiated, text-only, model-only run (needs a daemon started\n");
    s.push_str("                          with --enable-model-pilot and a Controller-issued model-only grant)\n");
    s.push_str("    model status|cancel|recover <conversation-id>   inspect / stop / close out a model run\n");
    s.push_str("    model list            recorded model-only conversations\n");
    s.push_str("    integrity             read-only journal integrity (states the verification scope; never a bare 'secure')\n");
    s.push_str("    project <add|list|show|remove|repin|set-scope|set-clients> ...   OPERATOR project registry (changes need ownership of the registry directory; the Desktop cannot register)\n");
    s.push_str("    runtime <status|start|stop>   A6.1.4: the native runtime for this user (starts nexusd + broker automatically)\n");
    s.push_str("    provider <connect|consent|revoke|status>   A6.1.4: one-time provider connection and consent\n");
    s.push_str("    engine <status|prefer adaptive|stable|setup --acknowledge-billable>   Phase 2: which engine NEW coding tasks use (default: Nexus Adaptive); one-time adaptive setup\n");
    s.push_str("    code run <project> --input FILE|-   A6.1.4: run a coding task with the interactive limits (same path as the Desktop)\n");
    s.push_str("    approvals [--task <instance-id>]   read-only human-approval status (approve/deny only via the terminal approver)\n");
    s.push_str("    tools list            native read-only tools (fs.list, fs.read, fs.search)\n");
    s.push_str("    tools inspect <id>    tool contract, arguments, budgets and policy\n");
    s.push_str("    tools events --task <instance-id> [--attempt <attempt-id> [--after <seq>]]\n");
    s.push_str(
        "                          real tool execution records from the daemon (read-only)\n",
    );
    s.push_str("    tools processes --task <instance-id> [--attempt <attempt-id>]\n");
    s.push_str("                          read-only sandboxed-process execution history\n");
    s.push_str("    tools depcache <admit|verify|list|stats|gc> --cache <abs dir> [--lockfile <Cargo.lock> --from-dir <dir>]  (operator, offline)\n");
    s.push_str("    tools run-offline-process --offline-test --allow-process-test --workspace <dir> <cargo|npm|tsc> [args...]\n");
    s.push_str(
        "                          offline sandbox test (needs NEXUS_TOOLS_OFFLINE_TEST=1,\n",
    );
    s.push_str(
        "                          NEXUS_TOOLS_OFFLINE_PROCESS_TEST=1, a temp-dir workspace\n",
    );
    s.push_str("                          with a .nexus-offline-process-test marker)\n");
    s.push_str("    tools run-offline --offline-test --workspace <dir> <id> '<args-json>'\n");
    s.push_str("                          offline/test execution under an EPHEMERAL kernel\n");
    s.push_str(
        "                          (needs NEXUS_TOOLS_OFFLINE_TEST=1; not Controller-authorized)\n",
    );
    s.push_str("\nEXAMPLES:\n");
    s.push_str("    nexus status\n");
    s.push_str("    nexus tasks --json\n");
    s.push_str("    nexus run --mock \"Test native runtime\"\n");
    s.push_str("\nEXIT CODES: 0 ok, 1 internal, 2 usage, 3 disconnected, 4 unauthorized, 5 live-blocked, 6 mock-failed.\n");
    s
}

struct Global {
    socket: Option<PathBuf>,
    ledger: Option<PathBuf>,
    json: bool,
}

fn parse_global(args: &[String]) -> Result<(Global, Vec<String>), String> {
    let mut g = Global {
        socket: None,
        ledger: None,
        json: false,
    };
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => {
                g.json = true;
                i += 1;
            }
            "--socket" => {
                i += 1;
                if i >= args.len() {
                    return Err("--socket needs a path".to_owned());
                }
                g.socket = Some(PathBuf::from(&args[i]));
                i += 1;
            }
            s if s.starts_with("--socket=") => {
                g.socket = Some(PathBuf::from(&s["--socket=".len()..]));
                i += 1;
            }
            "--ledger-dir" => {
                i += 1;
                if i >= args.len() {
                    return Err("--ledger-dir needs a directory".to_owned());
                }
                g.ledger = Some(PathBuf::from(&args[i]));
                i += 1;
            }
            s if s.starts_with("--ledger-dir=") => {
                g.ledger = Some(PathBuf::from(&s["--ledger-dir=".len()..]));
                i += 1;
            }
            other => {
                rest.push(other.to_owned());
                i += 1;
            }
        }
    }
    Ok((g, rest))
}

fn emit(cfg: &ClientConfig, value: &serde_json::Value, human: &str) {
    if cfg.json {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
        );
    } else {
        println!("{human}");
    }
}

/// A4.2 read-only approval status. There is deliberately no approve/deny
/// here: those exist only in the trusted terminal approver (`nexus-approver`)
/// running as the independent approver identity.
fn cmd_approvals(args: &[String], cfg: &ClientConfig) -> ExitCode {
    let usage = |m: &str| emit_err(cfg.json, &nexus_client::ClientError::usage(m));
    let mut task: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--task" => {
                i += 1;
                task = args.get(i).cloned();
            }
            "--json" => {}
            other => return usage(&format!("unknown argument '{other}'")),
        }
        i += 1;
    }
    match nexus_client::approvals(cfg, task.as_deref()) {
        Ok(v) => {
            let human = if !v.available {
                format!(
                    "approvals unavailable: {}",
                    v.reason.clone().unwrap_or_default()
                )
            } else if v.approvals.is_empty() {
                "no approval requests".to_owned()
            } else {
                let mut h = String::new();
                for a in &v.approvals {
                    h.push_str(&format!(
                        "{}  {:<8} {} {}  {}\n",
                        a.approval_id,
                        a.state,
                        a.tool_id,
                        a.paths.join(","),
                        a.decision_reason.clone().unwrap_or_default()
                    ));
                }
                h.push_str(
                    "approve/deny: run nexus-approver in a terminal as the approver identity",
                );
                h
            };
            emit(
                cfg,
                &serde_json::to_value(&v).unwrap_or(serde_json::Value::Null),
                &human,
            );
            ExitCode::Ok
        }
        Err(e) => emit_err(cfg.json, &e),
    }
}

fn emit_err(cfg_json: bool, err: &nexus_client::ClientError) -> ExitCode {
    if cfg_json {
        eprintln!(
            "{}",
            serde_json::json!({ "ok": false, "code": err.code, "message": err.message, "exit": err.exit as u32 })
        );
    } else {
        eprintln!("nexus: error [{}]: {}", err.code, err.message);
    }
    err.exit
}

fn cmd_status(cfg: &ClientConfig) -> ExitCode {
    match nexus_client::status(cfg) {
        Ok(v) => {
            let state = v.get("state").and_then(|x| x.as_str()).unwrap_or("?");
            let trust = v.get("trustMode").and_then(|x| x.as_str()).unwrap_or("?");
            let accepted = v
                .get("acceptedCommands")
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let total = v.get("totalCommands").and_then(|x| x.as_u64()).unwrap_or(0);
            let events = v.get("eventCount").and_then(|x| x.as_u64()).unwrap_or(0);
            emit(cfg, &v, &format!("nexus daemon: {state} (trust {trust}, commands {accepted}/{total}, events {events})\ndispatch: disabled (A2.4 mock scope only)"));
            ExitCode::Ok
        }
        Err(e) => emit_err(cfg.json, &e),
    }
}

fn cmd_doctor(cfg: &ClientConfig) -> ExitCode {
    let (up, detail) = nexus_client::api::probe_daemon(cfg);
    let sock_exists = cfg.socket_path.exists();
    let ready = nexus_client::readiness(cfg).unwrap_or(serde_json::json!({"ok": false}));
    let verdict = ready
        .pointer("/readiness/verdict")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    let value = serde_json::json!({ "ok": up, "daemon": detail, "socketExists": sock_exists, "readinessVerdict": verdict, "readiness": ready, "dispatchEnabled": false, "clientApiVersion": nexus_client::CLIENT_API_VERSION });
    let human = format!(
        "{}\nsocket: {} ({})\nreadiness: {verdict} (dispatch disabled)\nclient API: v{}",
        if up {
            "doctor: daemon reachable"
        } else {
            "doctor: daemon NOT reachable"
        },
        cfg.socket_path.display(),
        if sock_exists { "present" } else { "absent" },
        nexus_client::CLIENT_API_VERSION
    );
    emit(cfg, &value, &human);
    if up {
        ExitCode::Ok
    } else {
        ExitCode::Disconnected
    }
}

fn cmd_tasks(cfg: &ClientConfig) -> ExitCode {
    match nexus_client::tasks(cfg) {
        Ok(v) => {
            emit(
                cfg,
                &v,
                &format!(
                    "tasks source: {}",
                    v.get("source").and_then(|x| x.as_str()).unwrap_or("?")
                ),
            );
            ExitCode::Ok
        }
        Err(e) => emit_err(cfg.json, &e),
    }
}

fn cmd_task_show(cfg: &ClientConfig, id: &str) -> ExitCode {
    if id.is_empty() {
        return emit_err(
            cfg.json,
            &nexus_client::ClientError::usage("task show needs <task-id>"),
        );
    }
    match nexus_client::task_show(cfg, id) {
        Ok(v) => {
            emit(cfg, &v, &format!("task {id}: see JSON for ledger record (kernel receipts pin execution per command)"));
            ExitCode::Ok
        }
        Err(e) => emit_err(cfg.json, &e),
    }
}

fn cmd_models(cfg: &ClientConfig) -> ExitCode {
    let v = nexus_client::models();
    emit(cfg, &v, "models (offline mock catalog; live blocked):\n  e2e-mock-model [mock-e2e, loopback only]\n  remote-model-a [offline-test, loopback only]\nlive: BLOCKED (see --json for blockers)");
    ExitCode::Ok
}

fn cmd_config(cfg: &ClientConfig) -> ExitCode {
    let v = cfg.summary_json();
    emit(
        cfg,
        &v,
        &format!(
            "client API v{}\nsocket: {}\nledger: {}",
            nexus_client::CLIENT_API_VERSION,
            cfg.socket_path.display(),
            cfg.ledger_dir
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "(unset)".to_owned())
        ),
    );
    ExitCode::Ok
}

fn cmd_run(cmd_args: &[String], cfg: &ClientConfig) -> ExitCode {
    let mut mock = false;
    let mut prompt_parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < cmd_args.len() {
        match cmd_args[i].as_str() {
            "--mock" => {
                mock = true;
                i += 1;
            }
            s if s.starts_with("--mock=") => {
                mock = true;
                prompt_parts.push(s["--mock=".len()..].to_owned());
                i += 1;
            }
            "--json" => {
                i += 1;
            }
            other => {
                prompt_parts.push(other.to_owned());
                i += 1;
            }
        }
    }
    if !mock {
        let b = nexus_client::live_blockers();
        emit(cfg, &b, "run: LIVE EXECUTION BLOCKED in A2.4\n- no live scope authorization (kernel refuses non-mock-e2e)\n- no TLS termination (https refused fail-closed)\n- no billing metadata / credential path\n- multi-UID re-proof pending\nUse `run --mock \"<prompt>\"` for isolated mock execution.");
        return ExitCode::BlockedLive;
    }
    let prompt = prompt_parts.join(" ");
    if prompt.trim().is_empty() {
        return emit_err(
            cfg.json,
            &nexus_client::ClientError::usage(
                "run --mock needs a prompt, e.g. run --mock \"Test native runtime\"",
            ),
        );
    }
    match nexus_client::run_mock(&prompt) {
        Ok(r) => {
            let value = serde_json::json!({ "ok": true, "mock": true, "commandId": r.command_id, "attemptId": r.attempt_id, "requestDigest": r.request_digest, "text": r.text, "finishReason": r.finish_reason, "usage": { "input": r.usage_in, "output": r.usage_out }, "events": r.events });
            emit(
                cfg,
                &value,
                &format!(
                    "[mock] {} ({} events, attempt {})",
                    r.text,
                    r.events.len(),
                    r.attempt_id
                ),
            );
            if !cfg.json {
                println!(
                    "[mock] command {} attempt {} digest {}",
                    r.command_id, r.attempt_id, r.request_digest
                );
            }
            ExitCode::Ok
        }
        Err(e) => {
            let mut e2 = e;
            e2.exit = ExitCode::MockFailed;
            emit_err(cfg.json, &e2)
        }
    }
}

fn read_json_file(path: &str) -> Result<serde_json::Value, nexus_client::ClientError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| nexus_client::ClientError::usage(format!("cannot read {path}: {e}")))?;
    serde_json::from_str(&raw)
        .map_err(|_| nexus_client::ClientError::usage(format!("{path} is not valid JSON")))
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// A5.1 model-only commands. Every path here is explicit user invocation;
/// there is no daemon mode, no polling loop, and no retry.
fn cmd_model(args: &[String], cfg: &ClientConfig) -> ExitCode {
    let mut cfg = cfg.clone();
    if let Some(dir) = flag_value(args, "--transcript-dir") {
        cfg.transcript_dir = PathBuf::from(dir);
    }
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let positional = || {
        args.iter()
            .skip(1)
            .find(|a| !a.starts_with("--"))
            .cloned()
            .unwrap_or_default()
    };
    let result: Result<serde_json::Value, nexus_client::ClientError> = (|| match sub {
        "prepare" => {
            let path = flag_value(args, "--request").ok_or_else(|| {
                nexus_client::ClientError::usage("model prepare needs --request <file>")
            })?;
            let req: nexus_client::ModelRunRequest = serde_json::from_value(read_json_file(&path)?)
                .map_err(|e| nexus_client::ClientError::usage(format!("request shape: {e}")))?;
            let p = nexus_client::prepare_model_run(&req)?;
            serde_json::to_value(p).map_err(|e| nexus_client::ClientError::internal(e.to_string()))
        }
        "run" => {
            let need = |n: &str| {
                flag_value(args, n).ok_or_else(|| {
                    nexus_client::ClientError::usage(format!("model run needs {n} <file>"))
                })
            };
            let req: nexus_client::ModelRunRequest =
                serde_json::from_value(read_json_file(&need("--request")?)?)
                    .map_err(|e| nexus_client::ClientError::usage(format!("request shape: {e}")))?;
            let grant_doc = read_json_file(&need("--grant")?)?;
            let grant = grant_doc.get("grant").cloned().unwrap_or(grant_doc);
            let mut limits = nexus_client::TransportLimits::default();
            for (flag, slot) in [
                ("--read-timeout-ms", 0usize),
                ("--total-timeout-ms", 1),
                ("--max-text-bytes", 2),
            ] {
                if let Some(v) = flag_value(args, flag) {
                    let n: u64 = v.parse().map_err(|_| {
                        nexus_client::ClientError::usage(format!("{flag} must be an integer"))
                    })?;
                    match slot {
                        0 => limits.read_timeout_ms = n,
                        1 => limits.total_timeout_ms = n,
                        _ => limits.max_text_bytes = n as usize,
                    }
                }
            }
            let opts = nexus_client::ModelRunOptions {
                cap_path: PathBuf::from(need("--cap")?),
                credentials_path: PathBuf::from(need("--credentials")?),
                limits,
                transport: None,
            };
            let human = !cfg.json;
            let out = nexus_client::run_model_only(&cfg, &opts, &req, &grant, &mut |u| {
                if human {
                    match u {
                        nexus_client::ModelRunUpdate::Conversation { id } => {
                            eprintln!("[model] conversation {id}")
                        }
                        nexus_client::ModelRunUpdate::State { state } => {
                            eprintln!("[model] state {}", state.as_str())
                        }
                        nexus_client::ModelRunUpdate::Text { delta } => print!("{delta}"),
                    }
                }
            })?;
            if human {
                println!();
            }
            serde_json::to_value(out)
                .map_err(|e| nexus_client::ClientError::internal(e.to_string()))
        }
        "status" => serde_json::to_value(nexus_client::model_run_status(&cfg, &positional())?)
            .map_err(|e| nexus_client::ClientError::internal(e.to_string())),
        "recover" => serde_json::to_value(nexus_client::recover_model_run(&cfg, &positional())?)
            .map_err(|e| nexus_client::ClientError::internal(e.to_string())),
        "cancel" => {
            nexus_client::request_model_cancel(&cfg, &positional())?;
            Ok(serde_json::json!({ "ok": true, "cancelRequested": true }))
        }
        "list" => serde_json::to_value(nexus_client::list_model_conversations(&cfg))
            .map_err(|e| nexus_client::ClientError::internal(e.to_string())),
        _ => Err(nexus_client::ClientError::usage(
            "usage: nexus model <prepare|run|status|cancel|recover|list> (see --help)",
        )),
    })();
    match result {
        Ok(v) => {
            let human = serde_json::to_string_pretty(&v).unwrap_or_default();
            emit(&cfg, &v, &human);
            ExitCode::Ok
        }
        Err(e) => emit_err(cfg.json, &e),
    }
}

const INTENT_HELP: &str = "nexus intent <submit|status|result|follow|cancel|list|models|workspaces|code-sources|diff|engine> [--json]\n\
  submit  (--input FILE|- | --intent FILE|-) [--model provider/model] [--idempotency-key K]\n\
          [--request-id R] [--max-output-tokens N] [--follow | --wait]\n\
          [--engineering-mode ID]   repo-code only, with --model: e.g. engineering-v2-adaptive (opt-in beta; needs an\n\
                                    operator-saved ModeConfiguration; absent = the default engineering-v2)\n\
          [--type model-only|repo-inspect|repo-code]   repo-inspect = read-only agentic inspection (A5.5);\n\
          repo-code = controlled coding in an ISOLATED COPY (A5.6): every edit and command needs an\n\
          independent approval (nexus-approver); nothing is committed, pushed or merged.\n\
          --workspace ID (an identity from `workspaces` / `code-sources`, never a path)\n\
          [--max-edits N] [--max-tests N]   repo-code only\n\
          [--max-turns N] [--max-tool-calls N] [--max-tool-result-bytes N] [--max-runtime-secs N]\n\
          --follow emits NDJSON events: submitted, state, tool (every proposed/executed call), text, end\n\
  workspaces                        list the read-only workspace identities this client may inspect\n\
  code-sources                      list the source repositories this client may ask Nexus to modify\n\
  diff <runId>                      the reviewable change set of a repo-code run (isolated copy vs recorded commit)\n\
  thread list|show|send             A7.1 persistent conversations (interactive profile): list, read, or send a message\n\
                                    (`thread send <project> [--thread ID] [--mode auto|review|edit] [--fresh] --input FILE|-`)\n\
  status|result|cancel <runId>      follow <runId> [--from-offset N]      list [--limit N]      models\n\
Global: --broker-socket PATH (or NEXUS_BROKER_SOCKET). JSON envelope schema: nexus.intent.cli/v1.\n\
Exit codes: 0 ok / completed, 2 usage or rejected, 3 broker unreachable, 4 unauthorized, 6 run ended without completing.\n\
Pass a STABLE --idempotency-key when you may retry: the same key + payload never creates a second billable attempt.";

fn intent_class(code: &str, exit: ExitCode) -> &'static str {
    match exit {
        ExitCode::Unauthorized => "auth",
        ExitCode::Disconnected => "transport",
        ExitCode::Usage if code == "bad-usage" => "usage",
        ExitCode::Usage => "rejected",
        _ => "internal",
    }
}

fn intent_error(cfg: &ClientConfig, e: &nexus_client::ClientError) -> ExitCode {
    if cfg.json {
        println!(
            "{}",
            serde_json::json!({
                "schema": nexus_client::intent_client::CLI_SCHEMA, "ok": false,
                "error": { "code": e.code, "message": e.message, "class": intent_class(e.code, e.exit) },
            })
        );
    } else {
        eprintln!("nexus: error [{}]: {}", e.code, e.message);
    }
    e.exit
}

fn intent_ok(cfg: &ClientConfig, mut body: serde_json::Value, human: &str) {
    if cfg.json {
        body["schema"] = serde_json::json!(nexus_client::intent_client::CLI_SCHEMA);
        body["ok"] = serde_json::json!(true);
        println!("{body}");
    } else {
        println!("{human}");
    }
}

fn read_input(path: &str) -> Result<String, nexus_client::ClientError> {
    use std::io::Read;
    let mut s = String::new();
    if path == "-" {
        std::io::stdin()
            .take(256 * 1024)
            .read_to_string(&mut s)
            .map_err(|e| nexus_client::ClientError::usage(format!("cannot read stdin: {e}")))?;
    } else {
        s = std::fs::read_to_string(path)
            .map_err(|e| nexus_client::ClientError::usage(format!("cannot read {path}: {e}")))?;
    }
    Ok(s)
}

fn run_line(r: &nexus_client::intent_client::IntentRun) -> String {
    let outcome = r
        .coding_outcome
        .as_ref()
        .map(|o| {
            format!(
                " [coding: change {} · verification {}]",
                o.change, o.verification
            )
        })
        .unwrap_or_default();
    format!(
        "{} {} {}/{} {}{}",
        r.run_id,
        r.state,
        r.provider_id.as_deref().unwrap_or("?"),
        r.remote_model_id.as_deref().unwrap_or("?"),
        r.error_code.as_deref().unwrap_or(""),
        outcome
    )
}

/// Follow a run to its end, emitting NDJSON events (--json) or live text.
fn follow_run(
    cfg: &ClientConfig,
    sock: &std::path::Path,
    id: &str,
    mut offset: u64,
) -> Result<nexus_client::intent_client::IntentRun, nexus_client::ClientError> {
    let mut seen: Option<String> = None;
    let mut tools_seen = 0usize;
    let mut pending_seen: Option<String> = None;
    loop {
        let f = nexus_client::intent_client::follow(sock, id, offset, seen.as_deref(), 1_500)?;
        // A5.5: observe proposed/executed tool calls as they appear.
        for a in f.run.tool_activity.iter().skip(tools_seen) {
            if cfg.json {
                println!(
                    "{}",
                    serde_json::json!({ "schema": nexus_client::intent_client::CLI_SCHEMA, "event": "tool", "runId": id, "activity": a })
                );
            } else {
                eprintln!(
                    "[tool {}] turn {} {} {} -> {}{}",
                    a.index,
                    a.turn,
                    a.tool,
                    a.args_summary,
                    a.status,
                    a.error_code
                        .as_deref()
                        .map(|c| format!(" ({c})"))
                        .unwrap_or_default()
                );
            }
        }
        tools_seen = tools_seen.max(f.run.tool_activity.len());
        // A5.6: surface (once per approval) what is waiting for an independent reviewer.
        if let Some(pa) = f.run.pending_approval.as_ref() {
            if pending_seen.as_deref() != Some(pa.approval_id.as_str()) {
                pending_seen = Some(pa.approval_id.clone());
                if cfg.json {
                    println!(
                        "{}",
                        serde_json::json!({ "schema": nexus_client::intent_client::CLI_SCHEMA, "event": "approval-pending", "runId": id, "approval": pa })
                    );
                } else {
                    eprintln!(
                        "[approval pending] {} {} {} - waiting for an independent approver (nothing has run)",
                        pa.approval_id,
                        pa.operation.as_deref().unwrap_or("operation"),
                        pa.target.as_deref().unwrap_or(&pa.summary)
                    );
                }
            }
        }
        if seen.as_deref() != Some(f.run.state.as_str()) {
            seen = Some(f.run.state.clone());
            if cfg.json {
                println!(
                    "{}",
                    serde_json::json!({ "schema": nexus_client::intent_client::CLI_SCHEMA, "event": "state", "run": f.run })
                );
            } else {
                eprintln!("[intent] state {}", f.run.state);
            }
        }
        if !f.text_delta.is_empty() {
            if cfg.json {
                println!(
                    "{}",
                    serde_json::json!({ "schema": nexus_client::intent_client::CLI_SCHEMA, "event": "text", "runId": id, "delta": f.text_delta, "offset": offset, "nextOffset": f.next_offset })
                );
            } else {
                print!("{}", f.text_delta);
                let _ = std::io::Write::flush(&mut std::io::stdout());
            }
        }
        offset = f.next_offset;
        if f.run.terminal && f.text_delta.is_empty() {
            if cfg.json {
                println!(
                    "{}",
                    serde_json::json!({ "schema": nexus_client::intent_client::CLI_SCHEMA, "event": "end", "run": f.run })
                );
            } else {
                println!();
            }
            return Ok(f.run);
        }
    }
}

/// A5.3 intent client. Unprivileged by construction: it speaks only to the
/// broker socket and never reads a capability or credential file.
fn cmd_intent(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_client::intent_client as ic;
    let sock = flag_value(args, "--broker-socket")
        .map(PathBuf::from)
        .unwrap_or_else(ic::default_broker_socket);
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    if sub.is_empty() || sub == "--help" {
        println!("{INTENT_HELP}");
        return ExitCode::Ok;
    }
    let pos = || {
        args.iter()
            .skip(1)
            .find(|a| !a.starts_with("--"))
            .cloned()
            .unwrap_or_default()
    };
    let r: Result<ExitCode, nexus_client::ClientError> = (|| {
        match sub {
        "desktop" => {
            // Exactly what Nexus Desktop's Tauri backend calls (same functions).
            use nexus_client::desktop_contract as dc;
            let verb = args.get(1).map(|s| s.as_str()).unwrap_or("");
            let id = args
                .iter()
                .skip(2)
                .find(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or_default();
            let num = |f: &str| flag_value(args, f).and_then(|v| v.parse::<u64>().ok());
            let value = match verb {
                "conversation" => dc::conversation_read(cfg, &sock, &id, num("--after"), num("--before"), num("--limit").map(|n| n as u32))?,
                "status" => serde_json::to_value(dc::model_run_status(cfg, &sock, &id)?).unwrap_or_default(),
                "list" => serde_json::to_value(dc::list_model_conversations(cfg, &sock)).unwrap_or_default(),
                "cancel" => {
                    dc::cancel_model_run(cfg, &sock, &id)?;
                    serde_json::json!({ "cancelRequested": true })
                }
                _ => return Err(nexus_client::ClientError::usage("usage: nexus intent desktop <conversation|status|list|cancel> [conversation-id]")),
            };
            intent_ok(cfg, serde_json::json!({ "value": value }), &value.to_string());
            Ok(ExitCode::Ok)
        }
        "models" => {
            if args.iter().any(|a| a == "--targets") {
                let t = ic::registry_targets(&sock)?;
                let human = t
                    .iter()
                    .map(|x| {
                        format!(
                            "{}/{} route={} conn={} ctx={} out={} {}",
                            x.provider_id,
                            x.remote_model_id,
                            x.route_id,
                            x.connection_id.as_deref().unwrap_or("-"),
                            x.context_limit_tokens,
                            x.output_limit_tokens,
                            if x.issuable { "issuable" } else { "blocked" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                intent_ok(cfg, serde_json::json!({ "targets": t }), &human);
                return Ok(ExitCode::Ok);
            }
            let m = ic::models(&sock)?;
            let human = m
                .iter()
                .map(|x| format!("{}/{} ({}, max out {})", x.provider_id, x.remote_model_id, x.endpoint_kind, x.output_limit_tokens))
                .collect::<Vec<_>>()
                .join("\n");
            intent_ok(cfg, serde_json::json!({ "models": m }), &human);
            Ok(ExitCode::Ok)
        }
        "code-sources" => {
            let w = ic::code_sources(&sock)?;
            let human = w.iter().map(|x| x.source_id.clone()).collect::<Vec<_>>().join("\n");
            intent_ok(cfg, serde_json::json!({ "sources": w }), &human);
            Ok(ExitCode::Ok)
        }
        "diff" => {
            let id = pos();
            if id.is_empty() {
                return Err(nexus_client::ClientError::usage("usage: nexus intent diff <runId>"));
            }
            let d = ic::diff(&sock, &id)?;
            let human = format!(
                "{} files changed (base {}, diff {})\n{}{}",
                d.files.len(),
                d.base_commit,
                d.diff_digest,
                d.diff,
                if d.diff_truncated { "\n[diff truncated]" } else { "" }
            );
            intent_ok(cfg, serde_json::to_value(&d).unwrap_or_default(), &human);
            Ok(ExitCode::Ok)
        }
        "workspaces" => {
            let w = ic::workspaces(&sock)?;
            let human = w.iter().map(|x| x.workspace_id.clone()).collect::<Vec<_>>().join("\n");
            intent_ok(cfg, serde_json::json!({ "workspaces": w }), &human);
            Ok(ExitCode::Ok)
        }
        "submit" => {
            let intent = if let Some(p) = flag_value(args, "--intent") {
                let v: serde_json::Value = serde_json::from_str(&read_input(&p)?)
                    .map_err(|_| nexus_client::ClientError::usage("--intent is not valid JSON"))?;
                nexus_client::intent_contract::NexusIntentV1::parse(&v)
                    .map_err(|e| nexus_client::ClientError::usage(format!("{}: {}", e.code, e.message)))?
            } else {
                let p = flag_value(args, "--input").ok_or_else(|| {
                    nexus_client::ClientError::usage("submit needs --input FILE|- or --intent FILE|-")
                })?;
                let content = read_input(&p)?;
                let model = flag_value(args, "--model")
                    .map(|m| {
                        let route = flag_value(args, "--route");
                        let mut parts = m.splitn(3, '/');
                        let p = parts.next().unwrap_or("");
                        let r = parts.next().unwrap_or("");
                        let l = parts.next().map(|s| s.to_owned());
                        if p.is_empty() || r.is_empty() {
                            return Err(nexus_client::ClientError::usage("--model must be provider/model[/logical]"));
                        }
                        Ok::<_, nexus_client::ClientError>(nexus_client::intent_contract::ModelSelection {
                            provider_id: p.to_owned(),
                            remote_model_id: r.to_owned(),
                            logical_model_id: l,
                            route_id: route,
                            // S10-A: an Engineering Mode is chosen only by this explicit flag; absent,
                            // the broker applies the default (`engineering-v2` -> muse-v0)
                            mode_id: flag_value(args, "--engineering-mode"),
                        })
                    })
                    .transpose()?;
                if flag_value(args, "--engineering-mode").is_some() && model.is_none() {
                    return Err(nexus_client::ClientError::usage(
                        "--engineering-mode needs --model provider/model (and --type repo-code): the mode is part of the explicit selection",
                    ));
                }
                let max_out = flag_value(args, "--max-output-tokens")
                    .map(|v| v.parse::<u64>().map_err(|_| nexus_client::ClientError::usage("--max-output-tokens must be an integer")))
                    .transpose()?;
                let num_flag = |f: &str| -> Result<Option<u64>, nexus_client::ClientError> {
                    flag_value(args, f)
                        .map(|v| v.parse::<u64>().map_err(|_| nexus_client::ClientError::usage(format!("{f} must be an integer"))))
                        .transpose()
                };
                let intent_type = flag_value(args, "--type").unwrap_or_else(|| "model-only".to_owned());
                nexus_client::intent_contract::NexusIntentV1 {
                    schema_version: 1,
                    request_id: flag_value(args, "--request-id").unwrap_or_else(|| ic::fresh_key("cli")),
                    idempotency_key: flag_value(args, "--idempotency-key").unwrap_or_else(|| ic::fresh_key("idem")),
                    intent_type,
                    content,
                    model,
                    workspace_id: flag_value(args, "--workspace"),
                    limits: nexus_client::intent_contract::IntentLimits {
                        max_output_tokens: max_out,
                        max_turns: num_flag("--max-turns")?.map(|n| n as u32),
                        max_tool_calls: num_flag("--max-tool-calls")?.map(|n| n as u32),
                        max_tool_result_bytes: num_flag("--max-tool-result-bytes")?,
                        max_runtime_secs: num_flag("--max-runtime-secs")?,
                        max_edits: num_flag("--max-edits")?.map(|n| n as u32),
                        max_tests: num_flag("--max-tests")?.map(|n| n as u32),
                    },
                    response_mode: if args.iter().any(|a| a == "--wait") {
                        nexus_client::intent_contract::ResponseMode::Final
                    } else {
                        nexus_client::intent_contract::ResponseMode::Stream
                    },
                    client_label: Some("nexus-cli".to_owned()),
                }
            };
            let reply = ic::submit(&sock, &intent)?;
            let id = reply.run.run_id.clone();
            let followed = args.iter().any(|a| a == "--follow");
            let waited = args.iter().any(|a| a == "--wait");
            if !followed && !waited {
                intent_ok(cfg, serde_json::json!({ "run": reply.run, "replay": reply.replay }), &format!("submitted {}", run_line(&reply.run)));
                return Ok(ExitCode::Ok);
            }
            if followed {
                if cfg.json {
                    println!("{}", serde_json::json!({ "schema": ic::CLI_SCHEMA, "event": "submitted", "run": reply.run, "replay": reply.replay }));
                } else {
                    eprintln!("[intent] submitted {}", run_line(&reply.run));
                }
                let end = follow_run(cfg, &sock, &id, 0)?;
                return Ok(if end.state == "completed" { ExitCode::Ok } else { ExitCode::MockFailed });
            }
            let mut offset = 0;
            let end = loop {
                let f = ic::follow(&sock, &id, offset, None, 1_500)?;
                offset = f.next_offset;
                if f.run.terminal && f.text_delta.is_empty() {
                    break f.run;
                }
            };
            let res = ic::result(&sock, &id)?;
            intent_ok(cfg, serde_json::json!({ "run": res.run, "text": res.text, "replay": reply.replay }), &res.text);
            Ok(if end.state == "completed" { ExitCode::Ok } else { ExitCode::MockFailed })
        }
        "status" => {
            let run = ic::status(&sock, &pos())?;
            intent_ok(cfg, serde_json::json!({ "run": run }), &run_line(&run));
            Ok(ExitCode::Ok)
        }
        "result" => {
            let res = ic::result(&sock, &pos())?;
            intent_ok(cfg, serde_json::json!({ "run": res.run, "text": res.text }), &res.text);
            Ok(if res.run.state == "completed" { ExitCode::Ok } else { ExitCode::MockFailed })
        }
        "follow" => {
            let off = flag_value(args, "--from-offset").and_then(|v| v.parse().ok()).unwrap_or(0);
            let end = follow_run(cfg, &sock, &pos(), off)?;
            Ok(if end.state == "completed" { ExitCode::Ok } else { ExitCode::MockFailed })
        }
        "thread" => {
            // A7.1 persistent conversations: the same client functions the Desktop uses.
            let verb = args.get(1).map(|s| s.as_str()).unwrap_or("");
            let nth = |n: usize| {
                args.iter()
                    .skip(2)
                    .filter(|a| !a.starts_with("--"))
                    .nth(n)
                    .cloned()
                    .unwrap_or_default()
            };
            match verb {
                "list" => {
                    let v = ic::thread_list(&sock, flag_value(args, "--project").as_deref(), args.iter().any(|a| a == "--all"))?;
                    let human = v["threads"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|t| {
                                    format!(
                                        "{} {} runs={} {} {}",
                                        t["threadId"].as_str().unwrap_or("?"),
                                        t["projectId"].as_str().unwrap_or("?"),
                                        t["runCount"],
                                        if t["active"] == true { "ACTIVE" } else { t["lastState"].as_str().unwrap_or("") },
                                        t["title"].as_str().unwrap_or("")
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    intent_ok(cfg, v, &human);
                    Ok(ExitCode::Ok)
                }
                "show" => {
                    let v = ic::thread_get(&sock, &nth(0), None)?;
                    let human = serde_json::to_string_pretty(&v).unwrap_or_default();
                    intent_ok(cfg, v, &human);
                    Ok(ExitCode::Ok)
                }
                "send" => {
                    // nexus intent thread send <project-id> [--thread ID] [--mode auto|review|edit] [--fresh] [--model provider/model[/logical]] [--route ROUTE] --input FILE|-
                    let project = nth(0);
                    let content = read_input(&flag_value(args, "--input").ok_or_else(|| nexus_client::ClientError::usage("--input FILE|- is required"))?)?;
                    let thread = flag_value(args, "--thread");
                    let mut model = flag_value(args, "--model");
                    let mut route = flag_value(args, "--route");
                    let mut mode_flag = flag_value(args, "--engineering-mode");
                    // Phase 2: a NEW conversation with no explicit selection uses the operator's engine
                    // choice (default Nexus Adaptive); an existing conversation keeps its own engine
                    if thread.is_none() && model.is_none() && route.is_none() && mode_flag.is_none() {
                        if let Some(sel) = engine_selection(args, &sock).map_err(nexus_client::ClientError::usage)? {
                            // provider/remote only: a logical id may contain "/"; the exact route id disambiguates
                            model = Some(format!("{}/{}", sel.provider_id, sel.remote_model_id));
                            route = sel.route_id;
                            mode_flag = sel.mode_id;
                        }
                    }
                    let key = ic::fresh_key("thr");
                    let v = ic::thread_send(
                        &sock,
                        &ic::ThreadSend {
                            thread_id: thread.as_deref(),
                            project_id: &project,
                            content: &content,
                            mode: &flag_value(args, "--mode").unwrap_or_else(|| "auto".into()),
                            workspace: if args.iter().any(|a| a == "--fresh") { "fresh" } else { "continue" },
                            idempotency_key: &key,
                            model: model.as_deref(),
                            route: route.as_deref(),
                            mode_id: mode_flag.as_deref(),
                        },
                    )?;
                    let human = format!("thread {} run {}", v["threadId"].as_str().unwrap_or("?"), v["run"]["runId"].as_str().unwrap_or("?"));
                    intent_ok(cfg, v, &human);
                    Ok(ExitCode::Ok)
                }
                _ => Err(nexus_client::ClientError::usage("usage: nexus intent thread <list [--project ID] [--all]|show <threadId>|send <projectId> [--thread ID] [--mode auto|review|edit] [--fresh] [--model provider/model[/logical]] [--route ROUTE] --input FILE|->")),
            }
        }
        "resume" => {
            // continue an interrupted coding task in a new run that starts from its work
            let v = ic::resume(&sock, &pos())?;
            let run: ic::IntentRun = serde_json::from_value(v["run"].clone())
                .map_err(|e| nexus_client::ClientError::internal(e.to_string()))?;
            intent_ok(cfg, v.clone(), &run_line(&run));
            Ok(ExitCode::Ok)
        }
        "engine" => {
            // Phase 2: what the run's engine durably recorded (authenticated record, never the model's words)
            let v = ic::engine_summary(&sock, &pos())?;
            let human = match v.get("record").filter(|r| !r.is_null()) {
                Some(r) => format!(
                    "engine {} mode {} default {}  efforts {}  events {}",
                    r["engineId"].as_str().unwrap_or("?"),
                    r["modeId"].as_str().unwrap_or("?"),
                    r["defaultEffort"].as_str().unwrap_or("?"),
                    r["attempts"].as_array().map(|a| a.iter().map(|x| format!("#{}:{}", x["ordinal"], x["effort"].as_str().unwrap_or("?"))).collect::<Vec<_>>().join(" ")).unwrap_or_default(),
                    r["events"].as_array().map(|a| a.iter().map(|x| format!("{}@{}→{}", x["kind"].as_str().unwrap_or("?"), x["attempt"], x["effort"].as_str().unwrap_or("-"))).collect::<Vec<_>>().join("; ")).unwrap_or_default(),
                ),
                None => format!("engine {} (no engine record yet)", v["bound"]["engineId"].as_str().unwrap_or("none")),
            };
            intent_ok(cfg, v, &human);
            Ok(ExitCode::Ok)
        }
        "cancel" => {
            let c = ic::cancel(&sock, &pos())?;
            intent_ok(cfg, serde_json::json!({ "run": c.run, "outcome": c.outcome }), &format!("{} ({})", run_line(&c.run), c.outcome));
            Ok(ExitCode::Ok)
        }
        "list" => {
            let limit = flag_value(args, "--limit").and_then(|v| v.parse().ok()).unwrap_or(50);
            let runs = ic::list(&sock, limit)?;
            let human = runs.iter().map(run_line).collect::<Vec<_>>().join("\n");
            intent_ok(cfg, serde_json::json!({ "runs": runs }), &human);
            Ok(ExitCode::Ok)
        }
        _ => Err(nexus_client::ClientError::usage("usage: nexus intent <submit|status|result|follow|cancel|list|models|workspaces|thread> (see `nexus intent --help`)")),
    }
    })();
    match r {
        Ok(c) => c,
        Err(e) => intent_error(cfg, &e),
    }
}

fn cmd_interactive(cfg: &ClientConfig) -> ExitCode {
    println!("nexus interactive (mock only; live blocked). Commands: /quit /help /model /status");
    println!(
        "model: e2e-mock-model [mock-e2e, loopback] | reasoning: low | type text, /quit to exit"
    );
    use std::io::{self, BufRead};
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let text = match line {
            Ok(t) => t,
            Err(_) => break,
        };
        let t = text.trim();
        if t.is_empty() {
            continue;
        }
        if t == "/quit" || t == "/exit" {
            println!("bye.");
            break;
        }
        if t == "/help" {
            println!("type a task prompt (mock run) | /model (show model) | /status (daemon probe) | /quit");
            continue;
        }
        if t == "/model" {
            println!("model: e2e-mock-model [mock-e2e, loopback] | reasoning: low | live: BLOCKED");
            continue;
        }
        if t == "/status" {
            let (up, d) = nexus_client::api::probe_daemon(cfg);
            println!("{d} | reachable={up}");
            continue;
        }
        if t.starts_with('/') {
            println!("unknown command {t} (try /help)");
            continue;
        }
        print!("[mock:running] ");
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
        match nexus_client::run_mock(t) {
            Ok(r) => {
                for (i, e) in r.events.iter().enumerate() {
                    println!("[stream {i}] {e}");
                }
                println!(
                    "[mock:done] {} (attempt {}, digest {})",
                    r.text, r.attempt_id, r.request_digest
                );
                println!(
                    "[verify] mock terminal bound to {} | finish={} usage={}/{}",
                    r.attempt_id, r.finish_reason, r.usage_in, r.usage_out
                );
            }
            Err(e) => eprintln!("mock failed [{}]: {}", e.code, e.message),
        }
    }
    ExitCode::Ok
}

fn cmd_tools(args: &[String], cfg: &ClientConfig) -> ExitCode {
    let usage = |m: &str| emit_err(cfg.json, &nexus_client::ClientError::usage(m));
    match args.first().map(|s| s.as_str()) {
        Some("list") => {
            let d = nexus_tools::descriptors();
            let v = serde_json::json!({
                "tools": d, "aiInitiatedExecution": "disabled",
                "writeTools": "require an independently approved write scope (never available to this CLI)",
            });
            let mut human =
                String::from("native tools (AI-initiated execution disabled; write tools need an independently approved scope):\n");
            for t in &d {
                human.push_str(&format!("  {} v{}  {}\n", t.id, t.version, t.summary));
            }
            emit(cfg, &v, human.trim_end());
            ExitCode::Ok
        }
        Some("inspect") => {
            let Some(id) = args.get(1) else {
                return usage("usage: nexus tools inspect <tool-id>");
            };
            let Some(tool) = nexus_tools::ToolId::parse(id) else {
                return usage(&format!("unknown tool '{id}' (try: nexus tools list)"));
            };
            let d = nexus_tools::descriptor_for(tool);
            let v = serde_json::to_value(&d).unwrap_or(serde_json::Value::Null);
            let mut human = format!(
                "{} v{} (read-only)\n  {}\narguments:\n",
                d.id, d.version, d.summary
            );
            for a in &d.arguments {
                human.push_str(&format!(
                    "  {:<16} {:<7} {}  {}\n",
                    a.name,
                    a.kind,
                    if a.required { "required" } else { "optional" },
                    a.description
                ));
            }
            human.push_str("policy:\n");
            for n in &d.notes {
                human.push_str(&format!("  - {n}\n"));
            }
            emit(cfg, &v, human.trim_end());
            ExitCode::Ok
        }
        Some("events") => {
            let mut task = None;
            let mut attempt = None;
            let mut after = 0i64;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--task" => {
                        i += 1;
                        task = args.get(i).cloned();
                    }
                    "--attempt" => {
                        i += 1;
                        attempt = args.get(i).cloned();
                    }
                    "--after" => {
                        i += 1;
                        after = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(-1);
                    }
                    "--json" => {}
                    other => return usage(&format!("unknown argument '{other}'")),
                }
                i += 1;
            }
            let Some(task) = task else {
                return usage("usage: nexus tools events --task <instance-id> [--attempt <attempt-id> [--after <seq>]]");
            };
            // Without --attempt the attempt list comes from the Controller
            // attempt journal (never guessed); each attempt is read under
            // its own scope and never merged with another.
            let Some(attempt) = attempt else {
                return match nexus_client::tool_events_for_task(cfg, &task) {
                    Ok(t) => {
                        let human = if !t.available {
                            format!(
                                "tool activity unavailable: {}",
                                t.reason.clone().unwrap_or_default()
                            )
                        } else {
                            t.attempts
                                .iter()
                                .map(|a| {
                                    format!(
                                        "attempt {} ({}): {} execution(s){}",
                                        a.sequence,
                                        a.attempt_id,
                                        a.events.len(),
                                        a.error
                                            .as_ref()
                                            .map(|e| format!(" [no kernel record: {e}]"))
                                            .unwrap_or_default()
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        };
                        emit(
                            cfg,
                            &serde_json::to_value(&t).unwrap_or(serde_json::Value::Null),
                            &human,
                        );
                        ExitCode::Ok
                    }
                    Err(e) => emit_err(cfg.json, &e),
                };
            };
            if after < 0 {
                return usage("--after must be a non-negative integer");
            }
            match nexus_client::tool_events_folded(cfg, &task, &attempt, after) {
                Ok((events, cursor, complete)) => {
                    let v = serde_json::json!({
                        "ok": true,
                        "events": events,
                        "nextCursor": cursor,
                        "complete": complete,
                        "aiInitiatedExecution": "disabled",
                    });
                    let mut human = format!(
                        "{} tool execution(s) for {task} / {attempt}\n",
                        events.len()
                    );
                    for e in &events {
                        human.push_str(&format!(
                            "  #{:<4} {:<11} {:<9} {}{}{}\n",
                            e.first_seq,
                            format!("{:?}", e.status).to_lowercase(),
                            e.tool_id,
                            e.args.get("path").and_then(|p| p.as_str()).unwrap_or("."),
                            if e.truncated { "  [truncated]" } else { "" },
                            if e.redacted { "  [redacted]" } else { "" },
                        ));
                    }
                    human.push_str(&format!(
                        "cursor: {cursor}{}",
                        if complete { "" } else { " (more available)" }
                    ));
                    emit(cfg, &v, human.trim_end());
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        Some("processes") => {
            let mut task = None;
            let mut attempt: Option<String> = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--task" => {
                        i += 1;
                        task = args.get(i).cloned();
                    }
                    "--attempt" => {
                        i += 1;
                        attempt = args.get(i).cloned();
                    }
                    "--json" => {}
                    other => return usage(&format!("unknown argument '{other}'")),
                }
                i += 1;
            }
            let Some(task) = task else {
                return usage(
                    "usage: nexus tools processes --task <instance-id> [--attempt <attempt-id>]",
                );
            };
            let groups: Result<
                Vec<(String, Vec<nexus_client::ToolEventV1>)>,
                nexus_client::ClientError,
            > = match attempt {
                Some(a) => nexus_client::tool_events_folded(cfg, &task, &a, 0)
                    .map(|(ev, _, _)| vec![(a, ev)]),
                None => nexus_client::tool_events_for_task(cfg, &task).map(|t| {
                    t.attempts
                        .into_iter()
                        .map(|a| (a.attempt_id, a.events))
                        .collect()
                }),
            };
            match groups {
                Ok(g) => {
                    let mut human = String::new();
                    let mut all = Vec::new();
                    for (att, evs) in g {
                        for e in evs.into_iter().filter(|e| e.tool_id == "proc.run") {
                            let p = e.process.clone().unwrap_or_default();
                            human.push_str(&format!(
                                "{att} {:?} {} exit={} {}ms verification={} network=none\n",
                                e.status,
                                p.get("command").and_then(|v| v.as_str()).unwrap_or("?"),
                                p.get("exitCode")
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "-".into()),
                                p.get("wallMs").and_then(|v| v.as_u64()).unwrap_or(0),
                                p.get("verification")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("-"),
                            ));
                            all.push(serde_json::to_value(&e).unwrap_or_default());
                        }
                    }
                    if human.is_empty() {
                        human.push_str("no sandboxed process executions recorded");
                    }
                    emit(
                        cfg,
                        &serde_json::json!({"ok": true, "processes": all, "aiInitiatedExecution": "disabled"}),
                        human.trim_end(),
                    );
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        Some("depcache") => depcache_command(cfg, &args[1..]),
        Some("run-offline-process") => {
            let mut workspace: Option<String> = None;
            let mut offline = false;
            let mut allow = false;
            let mut pos: Vec<String> = Vec::new();
            let mut dep_cache: Option<String> = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--dep-cache" => {
                        i += 1;
                        dep_cache = args.get(i).cloned();
                    }
                    "--offline-test" => offline = true,
                    "--allow-process-test" => allow = true,
                    "--json" => {}
                    "--workspace" => {
                        i += 1;
                        workspace = args.get(i).cloned();
                    }
                    _ => {
                        // Everything from the program name on belongs to
                        // the command, not to this parser.
                        pos.extend(args[i..].iter().cloned());
                        break;
                    }
                }
                i += 1;
            }
            if !offline || !allow {
                return usage(
                    "run-offline-process requires --offline-test and --allow-process-test",
                );
            }
            let (Some(ws), Some(program)) = (workspace, pos.first().cloned()) else {
                return usage("usage: nexus tools run-offline-process --offline-test --allow-process-test --workspace <dir> <cargo|npm|tsc> [args...]");
            };
            let rest: Vec<String> = pos.into_iter().skip(1).collect();
            let abs = match std::fs::canonicalize(&ws) {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(_) => return usage("workspace does not exist"),
            };
            match nexus_tools::offline::run_offline_process(
                &abs,
                &program,
                &rest,
                300_000,
                dep_cache.as_deref().map(std::path::Path::new),
            ) {
                Ok(v) => {
                    let out = v["result"]["output"].clone();
                    let human = format!(
                        "[offline-test sandbox] {program} -> {}\nauthority: {}\nnot Controller-authorized; not AI-initiated\nverification={} exit={} reason={}\njournal: {}",
                        v["result"]["status"],
                        v["authority"].as_str().unwrap_or(""),
                        out["verification"],
                        out["exitCode"],
                        out["reason"],
                        v["journalPhases"],
                    );
                    emit(cfg, &v, &human);
                    ExitCode::Ok
                }
                Err(m) => {
                    let code = if m.contains("gated") {
                        "offline-gate"
                    } else {
                        "sandbox-refused"
                    };
                    emit_err(
                        cfg.json,
                        &nexus_client::ClientError::new(code, ExitCode::Unauthorized, m),
                    )
                }
            }
        }
        Some("run-offline") => {
            let mut workspace: Option<String> = None;
            let mut offline = false;
            let mut allow_write = false;
            let mut pos: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--offline-test" => offline = true,
                    "--allow-write-test" => allow_write = true,
                    "--json" => {}
                    "--workspace" => {
                        i += 1;
                        workspace = args.get(i).cloned();
                    }
                    other => pos.push(other.to_owned()),
                }
                i += 1;
            }
            if !offline {
                return usage("run-offline requires the explicit --offline-test flag");
            }
            let (Some(ws), Some(tool)) = (workspace, pos.first()) else {
                return usage("usage: nexus tools run-offline --offline-test --workspace <dir> <tool-id> '<args-json>'");
            };
            let raw = pos.get(1).map(|s| s.as_str()).unwrap_or("{}");
            let parsed: serde_json::Value = match serde_json::from_str(raw) {
                Ok(v) => v,
                Err(e) => return usage(&format!("args must be JSON: {e}")),
            };
            let abs = match std::fs::canonicalize(&ws) {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(_) => return usage("workspace does not exist"),
            };
            match nexus_tools::offline::run_offline_opts(
                &abs,
                tool,
                parsed,
                nexus_tools::ToolBudgets::default(),
                allow_write,
            ) {
                Ok(rep) => {
                    let v = serde_json::to_value(&rep).unwrap_or(serde_json::Value::Null);
                    let human = format!(
                        "[offline-test] {} -> {:?}\nauthority: {}\nnot Controller-authorized; not AI-initiated\njournal: {} (verified {})\n{}",
                        tool,
                        rep.result.status,
                        rep.authority,
                        rep.journal_phases.join(" > "),
                        rep.journal_verified_entries,
                        rep.result
                            .output
                            .as_ref()
                            .map(|o| serde_json::to_string_pretty(o).unwrap_or_default())
                            .or_else(|| rep.result.error.as_ref().map(|e| e.to_string()))
                            .unwrap_or_default()
                    );
                    emit(cfg, &v, &human);
                    if rep.result.error.is_some() {
                        ExitCode::Internal
                    } else {
                        ExitCode::Ok
                    }
                }
                Err(m) => {
                    let code = if m.contains("gated") {
                        "offline-gate"
                    } else {
                        "tool-refused"
                    };
                    emit_err(
                        cfg.json,
                        &nexus_client::ClientError::new(code, ExitCode::Unauthorized, m),
                    )
                }
            }
        }
        _ => usage("usage: nexus tools <list|inspect <id>|events ...|run-offline ...>"),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.iter().any(|a| a == "--version" || a == "-V") {
        println!("nexus {VERSION}");
        std::process::exit(0);
    }
    if raw.is_empty() || raw.iter().any(|a| a == "--help" || a == "-h") && raw.len() == 1 {
        print!("{}", help_text());
        std::process::exit(0);
    }
    let (global, rest) = match parse_global(&raw) {
        Ok(v) => v,
        Err(m) => {
            eprintln!("nexus: error [bad-usage]: {m}");
            eprintln!("{}", help_text());
            std::process::exit(2);
        }
    };
    if rest.is_empty() {
        eprint!("{}", help_text());
        std::process::exit(2);
    }
    if rest.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", help_text());
        std::process::exit(0);
    }
    let cfg = match ClientConfig::resolve(
        global.socket,
        global.ledger,
        global.json || rest.iter().any(|a| a == "--json"),
    ) {
        Ok(c) => c,
        Err(e) => {
            emit_err(global.json, &e);
            std::process::exit(e.exit as i32);
        }
    };
    let (cmd, args) = rest
        .split_first()
        .map(|(h, t)| (h.as_str(), t.to_vec()))
        .unwrap();
    let code: ExitCode = match cmd {
        "status" => cmd_status(&cfg),
        "doctor" => cmd_doctor(&cfg),
        "tasks" => cmd_tasks(&cfg),
        "task" => match args.first().map(|s| s.as_str()) {
            Some("show") => {
                let id = args.get(1).map(|s| s.as_str()).unwrap_or("");
                cmd_task_show(&cfg, id)
            }
            _ => emit_err(
                cfg.json,
                &nexus_client::ClientError::usage("usage: nexus task show <task-id>"),
            ),
        },
        "models" => cmd_models(&cfg),
        "config" => match args.first().map(|s| s.as_str()) {
            Some("show") => cmd_config(&cfg),
            _ => emit_err(
                cfg.json,
                &nexus_client::ClientError::usage("usage: nexus config show"),
            ),
        },
        "run" => cmd_run(&args, &cfg),
        "interactive" => cmd_interactive(&cfg),
        "model" => cmd_model(&args, &cfg),
        "intent" => cmd_intent(&args, &cfg),
        "tools" => cmd_tools(&args, &cfg),
        "project" => cmd_project(&args, &cfg),
        "exec" => cmd_exec(&args, &cfg),
        "runtime" => cmd_runtime(&args, &cfg),
        "engine" => cmd_engine(&args, &cfg),
        "provider" => cmd_provider(&args, &cfg),
        "code" => cmd_code(&args, &cfg),
        "approvals" => cmd_approvals(&args, &cfg),
        "integrity" => match nexus_client::integrity(&cfg) {
            Ok(v) => {
                let mut h = format!("journal integrity: {}\nscope: {}\n", v.state, v.scope);
                for j in &v.journals {
                    h.push_str(&format!(
                        "  {:<16} local={} witness={} {} — {}\n",
                        j.journal,
                        j.local_count,
                        j.witness_count
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "-".into()),
                        j.status,
                        j.detail
                    ));
                }
                if !v.detail.is_empty() {
                    h.push_str(&format!("detail: {}\n", v.detail));
                }
                emit(
                    &cfg,
                    &serde_json::to_value(&v).unwrap_or(serde_json::Value::Null),
                    h.trim_end(),
                );
                ExitCode::Ok
            }
            Err(e) => emit_err(cfg.json, &e),
        },
        other => emit_err(
            cfg.json,
            &nexus_client::ClientError::usage(format!("unknown command '{other}' (try --help)")),
        ),
    };
    std::process::exit(code as i32);
}

/// `nexus project ...` (A6.1.3) — the OPERATOR project registry.
///
/// Changing it requires owning the registry directory (default `~/.nexus/projects`,
/// created 0700), which is the whole authority model: the Desktop and the broker
/// only read it. Remove needs `--yes`; re-pinning needs the explicit new commit.
fn cmd_project(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_tools::registry as reg;
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1.min(args.len())..];
    let dir = flag_value(args, "--registry")
        .or_else(|| {
            std::env::var("NEXUS_PROJECT_REGISTRY")
                .ok()
                .filter(|v| !v.is_empty())
        })
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".nexus").join("projects"))
        });
    let Some(dir) = dir else {
        return fail(
            cfg,
            "no registry directory: pass --registry DIR or set NEXUS_PROJECT_REGISTRY",
        );
    };
    let mut uids = Vec::new();
    if let Some(u) = flag_value(args, "--owner-uid") {
        for p in u.split(',').filter(|p| !p.is_empty()) {
            match p.parse::<u32>() {
                Ok(n) => uids.push(n),
                Err(_) => return fail(cfg, "--owner-uid must be uid numbers"),
            }
        }
    }
    let trust = reg::Trust { owner_uids: uids };
    let positional: Vec<&String> = {
        let mut v = Vec::new();
        let mut i = 0;
        while i < rest.len() {
            if matches!(
                rest[i].as_str(),
                "--registry"
                    | "--owner-uid"
                    | "--commit"
                    | "--write-allow"
                    | "--to"
                    | "--allow-uid"
            ) {
                i += 2;
            } else if rest[i].starts_with("--") {
                i += 1;
            } else {
                v.push(&rest[i]);
                i += 1;
            }
        }
        v
    };
    let scope = || -> Vec<String> {
        flag_value(args, "--write-allow")
            .map(|l| {
                l.split(',')
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let uid_list = || -> Result<Vec<u32>, &'static str> {
        let mut v = Vec::new();
        if let Some(l) = flag_value(args, "--allow-uid") {
            for p in l.split(',').filter(|p| !p.is_empty()) {
                v.push(
                    p.parse::<u32>()
                        .map_err(|_| "--allow-uid must be uid numbers")?,
                );
            }
        }
        Ok(v)
    };
    let show = |p: &reg::ProjectRecord| -> (serde_json::Value, String) {
        let v = serde_json::json!({
            "id": p.id, "sourcePath": p.source_path, "pinnedCommit": p.pinned_commit,
            "writeAllow": p.write_allow, "allowedUids": p.allowed_uids, "createdAtMs": p.created_at_ms, "updatedAtMs": p.updated_at_ms,
            "executionRestrictions": reg::EXECUTION_RESTRICTIONS, "disclosureScope": reg::DISCLOSURE_SCOPE,
        });
        let h = format!(
            "{}\n  source:  {}\n  pinned:  {}\n  writes:  {}\n  restrictions:\n{}\n  disclosure: {}",
            p.id,
            p.source_path,
            p.pinned_commit,
            if p.write_allow.is_empty() { "whole project".to_owned() } else { p.write_allow.join(", ") },
            reg::EXECUTION_RESTRICTIONS.iter().map(|r| format!("    - {r}")).collect::<Vec<_>>().join("\n"),
            reg::DISCLOSURE_SCOPE
        );
        (v, h)
    };
    let fail_reg = |e: reg::RegError| {
        emit_err(
            cfg.json,
            &nexus_client::ClientError::usage(format!("project {}: {}", e.code, e.message)),
        )
    };
    match sub {
        "add" => {
            let (Some(id), Some(path)) = (positional.first(), positional.get(1)) else {
                return fail(cfg, "usage: nexus project add <id> <abs-git-path> [--commit <sha40>] [--write-allow dir/,file] [--allow-uid U,U] [--defer-verify] [--registry DIR]");
            };
            let uids = match uid_list() {
                Ok(u) => u,
                Err(m) => return fail(cfg, m),
            };
            match reg::add_with(
                &dir,
                &trust,
                id,
                std::path::Path::new(path.as_str()),
                flag_value(args, "--commit").as_deref(),
                scope(),
                uids,
                args.iter().any(|a| a == "--defer-verify"),
            ) {
                Ok(p) => {
                    let (v, h) = show(&p);
                    emit(cfg, &v, &format!("registered {h}"));
                    ExitCode::Ok
                }
                Err(e) => fail_reg(e),
            }
        }
        "list" => match reg::load(&dir, &trust) {
            Ok(f) => {
                let h = if f.projects.is_empty() {
                    "no projects registered".to_owned()
                } else {
                    f.projects
                        .iter()
                        .map(|p| {
                            format!(
                                "{:<24} {}  {}  writes: {}",
                                p.id,
                                &p.pinned_commit[..12],
                                p.source_path,
                                if p.write_allow.is_empty() {
                                    "whole project".into()
                                } else {
                                    p.write_allow.join(",")
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                emit(
                    cfg,
                    &serde_json::json!({"generation": f.generation, "projects": f.projects}),
                    &h,
                );
                ExitCode::Ok
            }
            Err(e) => fail_reg(e),
        },
        "show" => {
            let Some(id) = positional.first() else {
                return fail(cfg, "usage: nexus project show <id>");
            };
            match reg::load(&dir, &trust) {
                Ok(f) => match f.get(id) {
                    Some(p) => {
                        let (v, h) = show(p);
                        emit(cfg, &v, &h);
                        ExitCode::Ok
                    }
                    None => fail(cfg, &format!("project not-found: no project {id}")),
                },
                Err(e) => fail_reg(e),
            }
        }
        "remove" => {
            let Some(id) = positional.first() else {
                return fail(cfg, "usage: nexus project remove <id> --yes");
            };
            if !args.iter().any(|a| a == "--yes") {
                return fail(cfg, "remove is an explicit operator action: repeat with --yes (running tasks and retained copies are not affected)");
            }
            match reg::remove(&dir, &trust, id) {
                Ok(()) => {
                    emit(cfg, &serde_json::json!({"removed": id}), &format!("removed {id} (new tasks only; running tasks and retained copies are unaffected)"));
                    ExitCode::Ok
                }
                Err(e) => fail_reg(e),
            }
        }
        "repin" => {
            let (Some(id), Some(to)) = (positional.first(), flag_value(args, "--to")) else {
                return fail(cfg, "usage: nexus project repin <id> --to <sha40>   (the source must already be checked out, clean, at that commit)");
            };
            match reg::repin_with(
                &dir,
                &trust,
                id,
                &to,
                args.iter().any(|a| a == "--defer-verify"),
            ) {
                Ok((o, n)) => {
                    emit(
                        cfg,
                        &serde_json::json!({"id": id, "from": o, "to": n}),
                        &format!("{id}: pin {o} -> {n} (new tasks only)"),
                    );
                    ExitCode::Ok
                }
                Err(e) => fail_reg(e),
            }
        }
        "open" | "forget" | "refresh" | "ls" | "policy" | "workspace" => {
            // A6.1.4: through the BROKER (the same verbs the Desktop's native backend uses).
            use nexus_client::intent_client as ic;
            let sock = flag_value(args, "--broker-socket")
                .map(PathBuf::from)
                .unwrap_or_else(ic::default_broker_socket);
            let arg = positional.first().map(|s| s.as_str()).unwrap_or("");
            let r = match sub {
                "open" => {
                    // Direct Workspace: a NEWLY authorized project defaults to editing its real folder in
                    // place (an existing project keeps its durable choice). Said out loud before any task.
                    let ws = flag_value(args, "--workspace").unwrap_or_else(|| "direct".to_owned());
                    if !matches!(ws.as_str(), "direct" | "isolated") {
                        return fail(cfg, "usage: nexus project open <folder> [--workspace direct|isolated]");
                    }
                    ic::project_open_with(&sock, arg, Some(&ws))
                }
                "workspace" => {
                    let mode = positional.get(1).map(|s| s.as_str()).unwrap_or("");
                    if !matches!(mode, "direct" | "isolated") || arg.is_empty() {
                        return fail(cfg, "usage: nexus project workspace <id> direct|isolated");
                    }
                    ic::project_set_workspace(&sock, arg, mode)
                }
                "forget" => ic::project_forget(&sock, arg),
                "refresh" => ic::project_refresh(&sock, arg),
                "policy" => {
                    let flag = |n: &str| {
                        flag_value(args, n).map(|v| matches!(v.as_str(), "on" | "true" | "yes"))
                    };
                    ic::project_policy(&sock, arg, flag("--installs"), flag("--trusted"))
                }
                _ => ic::project_list(&sock, args.iter().any(|a| a == "--changes")),
            };
            match r {
                Ok(v) => {
                    emit(
                        cfg,
                        &v,
                        &serde_json::to_string_pretty(&v).unwrap_or_default(),
                    );
                    if !cfg.json && matches!(sub, "open" | "workspace") {
                        let mode = v
                            .pointer("/project/workspaceMode")
                            .and_then(|m| m.as_str())
                            .unwrap_or("isolated");
                        eprintln!(
                            "{}",
                            if mode == "direct" {
                                "Workspace: DIRECT. Nexus edits the files in this folder in place; each approved change is on disk immediately and there is no patch to apply. Change it with `nexus project workspace <id> isolated`."
                            } else {
                                "Workspace: ISOLATED. Nexus works in a throw-away copy; review and apply its patch. Change it with `nexus project workspace <id> direct`."
                            }
                        );
                    }
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        "grant" => project_grant_cmd(args, &positional, cfg),
        "set-clients" => {
            let Some(id) = positional.first() else {
                return fail(
                    cfg,
                    "usage: nexus project set-clients <id> (--allow-uid U,U | --all)",
                );
            };
            let list = if args.iter().any(|a| a == "--all") {
                Vec::new()
            } else if flag_value(args, "--allow-uid").is_some() {
                match uid_list() {
                    Ok(u) => u,
                    Err(m) => return fail(cfg, m),
                }
            } else {
                return fail(
                    cfg,
                    "give --allow-uid U,U or --all (every uid the broker allows)",
                );
            };
            match reg::set_allowed_uids(&dir, &trust, id, list.clone()) {
                Ok(()) => {
                    emit(
                        cfg,
                        &serde_json::json!({"id": id, "allowedUids": list}),
                        &format!("{id}: client uids updated (new tasks only)"),
                    );
                    ExitCode::Ok
                }
                Err(e) => fail_reg(e),
            }
        }
        "set-scope" => {
            let Some(id) = positional.first() else {
                return fail(
                    cfg,
                    "usage: nexus project set-scope <id> (--write-allow dir/,file | --all)",
                );
            };
            let list = if args.iter().any(|a| a == "--all") {
                Vec::new()
            } else if flag_value(args, "--write-allow").is_some() {
                scope()
            } else {
                return fail(cfg, "give --write-allow dir/,file or --all (whole project)");
            };
            match reg::set_write_allow(&dir, &trust, id, list.clone()) {
                Ok(()) => {
                    emit(
                        cfg,
                        &serde_json::json!({"id": id, "writeAllow": list}),
                        &format!("{id}: write scope updated (new tasks only)"),
                    );
                    ExitCode::Ok
                }
                Err(e) => fail_reg(e),
            }
        }
        _ => fail(
            cfg,
            "usage: nexus project <add|list|show|remove|repin|set-scope|set-clients|open|workspace|ls|policy|refresh|forget|grant> ...",
        ),
    }
}

/// Phase 2: the model selection for a NEW task from `--engine` / the operator preference.
fn engine_selection(
    args: &[String],
    sock: &std::path::Path,
) -> Result<Option<nexus_client::intent_contract::ModelSelection>, String> {
    use nexus_runtime::engine_choice as ec;
    let requested = match flag_value(args, "--engine") {
        Some(v) => Some(ec::Engine::parse(&v).ok_or("--engine must be adaptive or stable")?),
        None => None,
    };
    let home = nexus_runtime::Home::resolve()?;
    // Stable asks nothing of the Registry: no target list is needed (and none is fetched)
    if requested.unwrap_or_else(|| ec::preferred(&home)) == ec::Engine::Stable {
        return Ok(None);
    }
    let targets = nexus_client::intent_client::registry_targets(sock)
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    ec::selection_for(&home, requested, &targets)
        .map_err(|e| e.message)
        .map(|s| {
            s.map(|s| nexus_client::intent_contract::ModelSelection {
                provider_id: s.provider_id,
                remote_model_id: s.remote_model_id,
                logical_model_id: Some(s.logical_model_id),
                route_id: Some(s.route_id),
                mode_id: Some(s.mode_id),
            })
        })
}

/// `nexus engine <status|prefer|setup>` (Phase 2).
fn cmd_engine(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_runtime::engine_choice as ec;
    let home = match nexus_runtime::Home::resolve() {
        Ok(h) => h,
        Err(e) => return fail(cfg, &e),
    };
    let sock = home.broker_socket();
    match args.first().map(String::as_str).unwrap_or("status") {
        "status" => {
            let targets = nexus_client::intent_client::registry_targets(&sock).unwrap_or_default();
            let v = ec::view(&home, &targets);
            let human = format!(
                "preferred: {}   adaptive usable: {}{}   new tasks use: {}",
                v.preferred.as_str(),
                v.adaptive_available,
                v.adaptive_reason
                    .as_deref()
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default(),
                v.effective
                    .map(|e| e.as_str())
                    .unwrap_or("NOTHING until adaptive is set up or Stable is chosen"),
            );
            emit(cfg, &serde_json::to_value(&v).unwrap_or_default(), &human);
            ExitCode::Ok
        }
        "prefer" => {
            let Some(e) = args.get(1).and_then(|a| ec::Engine::parse(a)) else {
                return fail(cfg, "usage: nexus engine prefer adaptive|stable");
            };
            match ec::set_preferred(&home, e) {
                Ok(()) => {
                    emit(
                        cfg,
                        &serde_json::json!({"preferred": e.as_str()}),
                        &format!("new tasks will use: {}", e.as_str()),
                    );
                    ExitCode::Ok
                }
                Err(e) => fail(cfg, &e.message),
            }
        }
        "setup" => {
            if !args.iter().any(|a| a == "--acknowledge-billable") {
                return fail(cfg, "this verifies the adaptive route against the provider: 8 small billable requests (1 models call, a text probe at each of low/medium/high/xhigh, streaming, a tool call and its continuation) and then saves the adaptive configuration. Re-run with --acknowledge-billable to proceed");
            }
            match nexus_runtime::Tools::discover()
                .and_then(|t| nexus_runtime::enable_adaptive(&home, &t))
            {
                Ok(r) => {
                    emit(
                        cfg,
                        &serde_json::to_value(&r).unwrap_or_default(),
                        &r.checks.join("\n"),
                    );
                    if r.verified {
                        ExitCode::Ok
                    } else {
                        ExitCode::Internal
                    }
                }
                Err(e) => fail(cfg, &e),
            }
        }
        _ => fail(
            cfg,
            "usage: nexus engine <status|prefer adaptive|stable|setup --acknowledge-billable>",
        ),
    }
}

/// `nexus runtime <status|start|stop>` (A6.1.4).
fn cmd_runtime(args: &[String], cfg: &ClientConfig) -> ExitCode {
    let home = match nexus_runtime::Home::resolve() {
        Ok(h) => h,
        Err(e) => return fail(cfg, &e),
    };
    match args.first().map(String::as_str).unwrap_or("status") {
        "status" => {
            let st = nexus_runtime::status(&home);
            emit(
                cfg,
                &serde_json::to_value(&st).unwrap_or_default(),
                &format!(
                    "{:?} home={} providerConnected={}",
                    st.phase, st.home, st.provider_connected
                ),
            );
            ExitCode::Ok
        }
        "start" => {
            let sock = home.broker_socket();
            // a running runtime is only replaced when no task is running (a restart would end it)
            let idle = || -> Result<(), String> {
                match nexus_client::intent_client::list(&sock, 200) {
                    Ok(r) if r.iter().any(|x| !x.terminal) => {
                        Err("a task is still running; not restarting".to_owned())
                    }
                    Err(e) if e.code == "busy" => {
                        Err("the runtime is busy serving work; not restarting".to_owned())
                    }
                    _ => Ok(()),
                }
            };
            match nexus_runtime::Tools::discover()
                .and_then(|t| nexus_runtime::start_if(&home, &t, idle))
            {
                Ok(st) => {
                    emit(
                        cfg,
                        &serde_json::to_value(&st).unwrap_or_default(),
                        &format!("{:?} (broker {})", st.phase, st.broker_socket),
                    );
                    ExitCode::Ok
                }
                Err(e) => fail(cfg, &format!("runtime: {e}")),
            }
        }
        "stop" => match nexus_runtime::stop(&home) {
            Ok(()) => {
                emit(cfg, &serde_json::json!({"stopped": true}), "stopped");
                ExitCode::Ok
            }
            Err(e) => fail(cfg, &format!("runtime: {e}")),
        },
        _ => fail(cfg, "usage: nexus runtime <status|start|stop>"),
    }
}

/// `nexus provider <connect|consent|revoke|status>` (A6.1.4).
fn cmd_provider(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_client::intent_client as ic;
    let home = match nexus_runtime::Home::resolve() {
        Ok(h) => h,
        Err(e) => return fail(cfg, &e),
    };
    let sock = home.broker_socket();
    match args.first().map(String::as_str).unwrap_or("status") {
        "connect" => {
            let key = flag_value(args, "--key-env")
                .and_then(|n| std::env::var(n).ok())
                .or_else(|| std::env::var("OPENCODE_API_KEY").ok())
                .or_else(|| {
                    flag_value(args, "--key-file")
                        .and_then(|f| std::fs::read_to_string(f).ok())
                        .map(|s| s.trim().to_owned())
                });
            let Some(key) = key else {
                return fail(cfg, "give the key via OPENCODE_API_KEY, --key-env NAME or --key-file FILE (it is never taken as an argument)");
            };
            match nexus_runtime::Tools::discover()
                .and_then(|t| nexus_runtime::connect_provider(&home, &t, &key))
            {
                Ok(r) => {
                    emit(
                        cfg,
                        &serde_json::to_value(&r).unwrap_or_default(),
                        &r.checks.join("\n"),
                    );
                    if r.verified {
                        ExitCode::Ok
                    } else {
                        ExitCode::Internal
                    }
                }
                Err(e) => fail(cfg, &format!("provider: {e}")),
            }
        }
        "status" | "consent" => match ic::consent_status(&sock) {
            Ok(v) => {
                if args.first().map(String::as_str) == Some("consent")
                    && args.iter().any(|a| a == "--yes")
                {
                    let (p, m, d) = (
                        v["providerId"].as_str().unwrap_or(""),
                        v["remoteModelId"].as_str().unwrap_or(""),
                        v["textSha256"].as_str().unwrap_or(""),
                    );
                    return match ic::consent_grant(&sock, p, m, d) {
                        Ok(g) => {
                            emit(cfg, &g, &format!("consent recorded for {p} ({m})"));
                            ExitCode::Ok
                        }
                        Err(e) => emit_err(cfg.json, &e),
                    };
                }
                let human = format!(
                    "{}\n\nconsent: {}",
                    v["text"].as_str().unwrap_or(""),
                    if v["consent"].is_null() {
                        "not given (run: nexus provider consent --yes)"
                    } else {
                        "given"
                    }
                );
                emit(cfg, &v, &human);
                ExitCode::Ok
            }
            Err(e) => emit_err(cfg.json, &e),
        },
        "revoke" => match ic::consent_revoke(&sock) {
            Ok(v) => {
                emit(cfg, &v, "consent revoked");
                ExitCode::Ok
            }
            Err(e) => emit_err(cfg.json, &e),
        },
        _ => fail(
            cfg,
            "usage: nexus provider <connect|consent [--yes]|revoke|status>",
        ),
    }
}

/// `nexus code run <project> --input FILE|- [--wait]` (A6.1.4): the Desktop's coding path.
fn cmd_code(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_client::intent_client as ic;
    if args.first().map(String::as_str) != Some("run") {
        return fail(
            cfg,
            "usage: nexus code run <project-id> --input FILE|- [--wait]",
        );
    }
    let Some(project) = args.get(1).filter(|a| !a.starts_with("--")) else {
        return fail(
            cfg,
            "usage: nexus code run <project-id> --input FILE|- [--wait]",
        );
    };
    let sock = flag_value(args, "--broker-socket")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            nexus_runtime::Home::resolve()
                .map(|h| h.broker_socket())
                .unwrap_or_else(|_| ic::default_broker_socket())
        });
    let content = match flag_value(args, "--input").map(|p| read_input(&p)) {
        Some(Ok(c)) => c,
        Some(Err(e)) => return emit_err(cfg.json, &e),
        None => return fail(cfg, "--input FILE|- is required"),
    };
    let conf = match ic::code_config(&sock) {
        Ok(c) => c,
        Err(e) => return emit_err(cfg.json, &e),
    };
    // Phase 2: the same engine choice as the Desktop (preference, default Nexus Adaptive; `--engine`
    // overrides explicitly). Adaptive that cannot be used is an ERROR, never a silent Stable.
    let model = match engine_selection(args, &sock) {
        Ok(m) => m,
        Err(e) => return fail(cfg, &e),
    };
    let intent = nexus_client::intent_contract::NexusIntentV1 {
        schema_version: 1,
        request_id: ic::fresh_key("code"),
        idempotency_key: ic::fresh_key("idem"),
        intent_type: "repo-code".to_owned(),
        content,
        model,
        workspace_id: Some(project.clone()),
        limits: conf.limits.to_intent_limits(),
        response_mode: nexus_client::intent_contract::ResponseMode::Stream,
        client_label: Some("nexus-cli-code".to_owned()),
    };
    let run = match ic::submit(&sock, &intent) {
        Ok(r) => r.run,
        Err(e) => return emit_err(cfg.json, &e),
    };
    if !args.iter().any(|a| a == "--wait") {
        emit(
            cfg,
            &serde_json::json!({"run": run}),
            &format!("submitted {}", run.run_id),
        );
        return ExitCode::Ok;
    }
    let end = std::time::Instant::now()
        + std::time::Duration::from_secs(
            flag_value(args, "--timeout-secs")
                .and_then(|v| v.parse().ok())
                .unwrap_or(3600),
        );
    let mut last = String::new();
    loop {
        match ic::status(&sock, &run.run_id) {
            Ok(r) => {
                let line = run_line(&r);
                if line != last && !cfg.json {
                    eprintln!("{line}");
                    last = line;
                }
                if r.terminal {
                    emit(cfg, &serde_json::json!({"run": r}), &run_line(&r));
                    return if r.state == "completed" {
                        ExitCode::Ok
                    } else {
                        ExitCode::Internal
                    };
                }
            }
            // a busy or briefly unreachable broker is not the end of the run: keep waiting
            Err(e) if matches!(e.code, "busy" | "disconnected") => {}
            Err(e) => return emit_err(cfg.json, &e),
        }
        if std::time::Instant::now() > end {
            return fail(cfg, "timed out waiting for the run (it keeps running)");
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// `nexus tools depcache <admit|verify|list|stats|gc> --cache <dir> ...`
/// Operator-only, offline. Never reachable from the daemon or a model.
/// `3600`, `90s`, `30m`, `12h`, `7d` -> seconds.
fn parse_duration_secs(v: &str) -> Option<u64> {
    let (num, mul) = match v.chars().last()? {
        's' => (&v[..v.len() - 1], 1u64),
        'm' => (&v[..v.len() - 1], 60),
        'h' => (&v[..v.len() - 1], 3600),
        'd' => (&v[..v.len() - 1], 86_400),
        c if c.is_ascii_digit() => (v, 1),
        _ => return None,
    };
    num.parse::<u64>().ok().filter(|n| *n > 0)?.checked_mul(mul)
}

/// The user's explicit confirmation of a permission change: `--yes`, or an interactive terminal where
/// the person types `yes`. Anything else (a pipe, a script without `--yes`) refuses.
fn confirm_in_terminal(args: &[String], what: &str) -> bool {
    if args.iter().any(|a| a == "--yes") {
        return true;
    }
    use std::io::{BufRead, IsTerminal, Write};
    if !std::io::stdin().is_terminal() {
        eprintln!("confirmation required: run this in a terminal, or pass --yes to confirm {what} explicitly");
        return false;
    }
    eprint!("Type 'yes' to confirm {what}: ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line.trim() == "yes"
}

/// A confirmation that cannot be given by a script: the exact phrase typed on a real terminal.
fn confirm_phrase(phrase: &str) -> bool {
    use std::io::{BufRead, IsTerminal, Write};
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        eprintln!("this choice needs a person at a terminal (a script or --yes cannot confirm it)");
        return false;
    }
    eprint!("Type '{phrase}' to confirm: ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line.trim() == phrase
}

/// `nexus exec effects <executionId>` and `nexus exec restore <executionId> [--apply [--yes]]`:
/// what an in-place command changed, and the guarded restore of it. Preview first (changes nothing);
/// applying needs the digest of the preview and a typed confirmation. The model has no path to this.
fn cmd_exec(args: &[String], cfg: &ClientConfig) -> ExitCode {
    use nexus_client::intent_client as ic;
    const USAGE: &str =
        "usage: nexus exec effects <executionId> | restore <executionId> [--apply] [--yes]";
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let sock = flag_value(args, "--broker-socket")
        .map(PathBuf::from)
        .unwrap_or_else(ic::default_broker_socket);
    let (Some(action), Some(id)) = (positional.first(), positional.get(1)) else {
        return fail(cfg, USAGE);
    };
    match action.as_str() {
        "effects" => match ic::exec_effects(&sock, id) {
            Ok(v) => {
                emit(
                    cfg,
                    &v,
                    &serde_json::to_string_pretty(&v).unwrap_or_default(),
                );
                ExitCode::Ok
            }
            Err(e) => emit_err(cfg.json, &e),
        },
        "restore" => {
            let pv = match ic::exec_restore_preview(&sock, id) {
                Ok(v) => v,
                Err(e) => return emit_err(cfg.json, &e),
            };
            let r = &pv["restore"];
            let count = |k: &str| r[k].as_array().map(|a| a.len()).unwrap_or(0);
            if !args.iter().any(|a| a == "--apply") {
                emit(
                    cfg,
                    &pv,
                    &serde_json::to_string_pretty(&pv).unwrap_or_default(),
                );
                eprintln!(
                    "preview only: {} would be restored, {} skipped, {} in conflict (kept as they are), {} unrecoverable. Nothing was changed. Apply with: nexus exec restore {id} --apply",
                    count("restored"), count("skipped"), count("conflicted"), count("unrecoverable")
                );
                return ExitCode::Ok;
            }
            if r["refused"].is_string() {
                emit(
                    cfg,
                    &pv,
                    &serde_json::to_string_pretty(&pv).unwrap_or_default(),
                );
                return fail(cfg, "the restore is refused; nothing was changed");
            }
            eprintln!("{}", serde_json::to_string_pretty(r).unwrap_or_default());
            if !confirm_in_terminal(args, "this restore (files in conflict are left untouched)") {
                return fail(cfg, "not confirmed; nothing was changed");
            }
            let digest = pv["confirmDigest"].as_str().unwrap_or("");
            match ic::exec_restore_apply(&sock, id, digest, "cli") {
                Ok(v) => {
                    emit(
                        cfg,
                        &v,
                        &serde_json::to_string_pretty(&v).unwrap_or_default(),
                    );
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        _ => fail(cfg, USAGE),
    }
}

/// `nexus project grant <id> show | set --fs F --net N --approval A [--expires 7d] | revoke | clear`
/// Standing grants (permissions). Through the broker, like the Desktop's native backend; the model has no
/// path to either.
fn project_grant_cmd(args: &[String], positional: &[&String], cfg: &ClientConfig) -> ExitCode {
    use nexus_client::intent_client as ic;
    const USAGE: &str = "usage: nexus project grant <id> show | set --fs scratch|workspace --net offline|install|controlled --approval auto|ask [--expires 7d] [--checkpoint off|best-effort|required] [--hard-links protect|allow] [--git-write] [--dev-port N]... [--allow-host H[:ports]]... [--allow-local-port N]... [--net-preset npm|cargo|pip|github|gitlab|go|pnpm|yarn]... [--yes] | revoke [--yes] | clear [--yes]";
    let sock = flag_value(args, "--broker-socket")
        .map(PathBuf::from)
        .unwrap_or_else(ic::default_broker_socket);
    let (Some(id), Some(action)) = (positional.first(), positional.get(1)) else {
        return fail(cfg, USAGE);
    };
    match action.as_str() {
        "show" => match ic::project_list(&sock, false) {
            Ok(v) => {
                let p = v["projects"]
                    .as_array()
                    .and_then(|a| a.iter().find(|p| p["projectId"] == id.as_str()));
                match p {
                    Some(p) => {
                        let g = p.get("grant").cloned().unwrap_or(serde_json::Value::Null);
                        let human = if g.is_null() {
                            format!("{id}: no standing grant (defaults: scratch, offline, automatic approval)")
                        } else {
                            format!(
                                "{id}: {} v{} fs={} net={} approval={} checkpoint={} hard-links={} git-write={} destinations={} expires={}",
                                g["status"].as_str().unwrap_or("?"),
                                g["version"],
                                g["fs"].as_str().unwrap_or("?"),
                                g["net"].as_str().unwrap_or("?"),
                                g["approval"].as_str().unwrap_or("?"),
                                g["checkpoint"].as_str().unwrap_or("best-effort"),
                                g["hardLinks"].as_str().unwrap_or("protect"),
                                g["gitWrite"].as_bool().unwrap_or(false),
                                {
                                    let n = &g["netPolicy"];
                                    let empty = |k: &str| n[k].as_array().is_none_or(|a| a.is_empty());
                                    if n.is_null() || (empty("hosts") && empty("localPorts")) {
                                        "none".to_owned()
                                    } else {
                                        serde_json::to_string(n).unwrap_or_default()
                                    }
                                },
                                g["expiresAtMs"]
                            )
                        };
                        emit(cfg, &g, &human);
                        ExitCode::Ok
                    }
                    None => fail(cfg, "no such project"),
                }
            }
            Err(e) => emit_err(cfg.json, &e),
        },
        "set" => {
            let fs = flag_value(args, "--fs").unwrap_or_else(|| "scratch".into());
            let net = flag_value(args, "--net").unwrap_or_else(|| "offline".into());
            let approval = flag_value(args, "--approval").unwrap_or_else(|| "auto".into());
            let expires = match flag_value(args, "--expires") {
                None => None,
                Some(v) => match parse_duration_secs(&v) {
                    Some(n) => Some(n),
                    None => return fail(cfg, "--expires must look like 3600, 30m, 12h or 7d"),
                },
            };
            let checkpoint =
                flag_value(args, "--checkpoint").unwrap_or_else(|| "best-effort".into());
            let hard_links = flag_value(args, "--hard-links").unwrap_or_else(|| "protect".into());
            let exec = Some((checkpoint.as_str(), hard_links.as_str()));
            // Controlled Internet destinations (repeatable flags); `--git-write` is the owner's
            // explicit Git-write choice (M6B; sealed into the grant, hooks/config stay read-only)
            let mut dest = ic::NetChoice {
                git_write: args.iter().any(|a| a == "--git-write"),
                ..Default::default()
            };
            let mut it = args.iter();
            while let Some(a) = it.next() {
                let next = it.clone().next().cloned();
                match (a.as_str(), next) {
                    ("--allow-host", Some(v)) => dest.hosts.push(v),
                    ("--net-preset", Some(v)) => dest.presets.push(v),
                    ("--allow-local-port", Some(v)) => match v.parse::<u16>() {
                        Ok(p) => dest.local_ports.push(p),
                        Err(_) => return fail(cfg, "--allow-local-port needs a port number"),
                    },
                    ("--dev-port", Some(v)) => match v.parse::<u16>() {
                        Ok(p) if p > 0 => dest.dev_ports.push(p),
                        _ => return fail(cfg, "--dev-port needs a port number (1..=65535)"),
                    },
                    _ => {}
                }
            }
            let pv = match ic::project_grant_preview_net(
                &sock, id, &fs, &net, &approval, expires, exec, &dest,
            ) {
                Ok(v) => v,
                Err(e) => return emit_err(cfg.json, &e),
            };
            eprintln!(
                "{}
",
                pv["text"].as_str().unwrap_or("")
            );
            if !confirm_in_terminal(args, "these permissions") {
                return fail(cfg, "not confirmed; nothing was changed");
            }
            // Allowing writes to hard-linked files can change files OUTSIDE the project: only a person at a
            // terminal can say so; `--yes` and pipes are not accepted for this one choice.
            if hard_links == "allow" && !confirm_phrase("allow hard-link writes") {
                return fail(
                    cfg,
                    "hard-link writes were not confirmed at a terminal; nothing was changed",
                );
            }
            let digest = pv["textSha256"].as_str().unwrap_or("");
            match ic::project_grant_set_net(
                &sock, id, &fs, &net, &approval, expires, digest, "cli", exec, &dest,
            ) {
                Ok(v) => {
                    emit(
                        cfg,
                        &v,
                        &serde_json::to_string_pretty(&v).unwrap_or_default(),
                    );
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        "revoke" | "clear" => {
            let what = if action.as_str() == "revoke" {
                "revoking this project's permissions (running tasks stop being allowed to act)"
            } else {
                "removing this project's permissions (it returns to the defaults)"
            };
            if !confirm_in_terminal(args, what) {
                return fail(cfg, "not confirmed; nothing was changed");
            }
            let r = if action.as_str() == "revoke" {
                ic::project_grant_revoke(&sock, id, "cli")
            } else {
                ic::project_grant_clear(&sock, id, "cli")
            };
            match r {
                Ok(v) => {
                    emit(
                        cfg,
                        &v,
                        &serde_json::to_string_pretty(&v).unwrap_or_default(),
                    );
                    ExitCode::Ok
                }
                Err(e) => emit_err(cfg.json, &e),
            }
        }
        _ => fail(cfg, USAGE),
    }
}

fn fail(cfg: &ClientConfig, m: &str) -> ExitCode {
    emit_err(cfg.json, &nexus_client::ClientError::usage(m))
}

fn usage_err(cfg: &ClientConfig, m: &str) -> ExitCode {
    fail(cfg, m)
}

fn depcache_command(cfg: &ClientConfig, args: &[String]) -> ExitCode {
    use nexus_tools::depcache::{parse_cargo_lock, CacheQuota, DepCache};
    let sub = args.first().map(String::as_str).unwrap_or("");
    let (mut cache, mut lock, mut from, mut index_cache): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = (None, None, None, None);
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--cache" => {
                i += 1;
                cache = args.get(i).cloned();
            }
            "--lockfile" => {
                i += 1;
                lock = args.get(i).cloned();
            }
            "--from-dir" => {
                i += 1;
                from = args.get(i).cloned();
            }
            "--index-cache" => {
                i += 1;
                index_cache = args.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }
    let Some(cache) = cache else {
        return usage_err(cfg, "usage: nexus tools depcache <admit|verify|list|stats|gc> --cache <absolute dir> [--lockfile <Cargo.lock> --from-dir <dir with .crate files>]");
    };
    let create = sub == "admit";
    let dc = match DepCache::open(std::path::Path::new(&cache), create, CacheQuota::default()) {
        Ok(d) => d,
        Err(e) => return fail(cfg, &e.to_string()),
    };
    match sub {
        "admit" => {
            let (Some(lock), Some(from)) = (lock, from) else {
                return usage_err(cfg, "admit requires --lockfile and --from-dir");
            };
            let text = match std::fs::read_to_string(&lock) {
                Ok(t) => t,
                Err(e) => return fail(cfg, &format!("lockfile: {e}")),
            };
            let lf = match parse_cargo_lock(&text) {
                Ok(l) => l,
                Err(e) => return fail(cfg, &e.to_string()),
            };
            let rep = dc.admit_from_dir(
                std::path::Path::new(&from),
                index_cache.as_deref().map(std::path::Path::new),
                &lf,
                "operator-cli",
            );
            let v = serde_json::json!({
                "created": rep.created.len(), "identical": rep.identical.len(),
                "missing": rep.missing, "indexMissing": rep.index_missing, "rejected": rep.rejected,
                "complete": rep.complete(), "resolvable": rep.resolvable(),
            });
            emit(
                cfg,
                &v,
                &format!(
                    "admitted {} new, {} already present; missing {}, rejected {} -> {}",
                    rep.created.len(),
                    rep.identical.len(),
                    rep.missing.len(),
                    rep.rejected.len(),
                    if rep.complete() {
                        "COMPLETE"
                    } else {
                        "INCOMPLETE"
                    }
                ),
            );
            if rep.resolvable() {
                ExitCode::Ok
            } else {
                fail(cfg, "cache cannot resolve this lockfile")
            }
        }
        "verify" => {
            let (ok, bad) = dc.verify_all();
            let v = serde_json::json!({"ok": ok, "failures": bad});
            emit(
                cfg,
                &v,
                &format!("verified {ok} object(s); {} failure(s)", bad.len()),
            );
            if bad.is_empty() {
                ExitCode::Ok
            } else {
                fail(cfg, "cache verification failed")
            }
        }
        "list" => {
            let l = dc.list();
            let human = l
                .iter()
                .map(|p| format!("{} {} {}", p.name, p.version, p.sha256))
                .collect::<Vec<_>>()
                .join("\n");
            emit(cfg, &serde_json::to_value(&l).unwrap_or_default(), &human);
            ExitCode::Ok
        }
        "stats" => {
            let s = dc.stats();
            emit(
                cfg,
                &serde_json::to_value(&s).unwrap_or_default(),
                &format!(
                    "{} object(s), {} bytes, {} stale staging",
                    s.objects, s.total_bytes, s.stale_staging
                ),
            );
            ExitCode::Ok
        }
        "gc" => {
            let n = dc.gc_staging();
            emit(
                cfg,
                &serde_json::json!({"removedStaging": n}),
                &format!("removed {n} stale staging dir(s)"),
            );
            ExitCode::Ok
        }
        _ => usage_err(cfg, "unknown depcache subcommand"),
    }
}
