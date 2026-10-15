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
    s.push_str("    tools list            native read-only tools (fs.list, fs.read, fs.search)\n");
    s.push_str("    tools inspect <id>    tool contract, arguments, budgets and policy\n");
    s.push_str("    tools events --task <instance-id> [--attempt <attempt-id> [--after <seq>]]\n");
    s.push_str(
        "                          real tool execution records from the daemon (read-only)\n",
    );
    s.push_str("    tools processes --task <instance-id> [--attempt <attempt-id>]\n");
    s.push_str("                          read-only sandboxed-process execution history\n");
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
        Some("run-offline-process") => {
            let mut workspace: Option<String> = None;
            let mut offline = false;
            let mut allow = false;
            let mut pos: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--offline-test" => offline = true,
                    "--allow-process-test" => allow = true,
                    "--json" => {}
                    "--workspace" => {
                        i += 1;
                        workspace = args.get(i).cloned();
                    }
                    other => pos.push(other.to_owned()),
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
            match nexus_tools::offline::run_offline_process(&abs, &program, &rest, 300_000) {
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
        "tools" => cmd_tools(&args, &cfg),
        other => emit_err(
            cfg.json,
            &nexus_client::ClientError::usage(format!("unknown command '{other}' (try --help)")),
        ),
    };
    std::process::exit(code as i32);
}
