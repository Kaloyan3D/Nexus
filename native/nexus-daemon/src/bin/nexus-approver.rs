//! `nexus-approver`: the trusted terminal approval workflow (A4.2).
//!
//! Runs as the approver OS identity. It is the ONLY client that holds the
//! approver capability; the Controller, issuer, GUI renderer and AI
//! execution never do (A4.1 filesystem separation). It refuses to confirm
//! unless stdin/stdout are terminals and the typed answer is read from
//! `/dev/tty`, so piped input cannot answer for a human.
//!
//! What this proves, and what it does not: the decision comes from a
//! process running as the approver UID that fetched and displayed the exact
//! daemon-authored request and received a deliberately typed review code.
//! It does NOT prove a human (versus a script under the same UID) typed it.
//!
//! Usage:
//!   nexus-approver --socket PATH list   [--task ID] [--approval ID]
//!   nexus-approver --socket PATH --cap-file PATH review APPROVAL_ID

use nexus_daemon::IssuerAuth;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("entropy");
    hex::encode(b)
}

fn call(
    socket: &str,
    auth: Option<&IssuerAuth>,
    cmd: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = format!("approver-{}", random_hex(6));
    let mut frame = serde_json::json!({
        "protocol": 1, "id": id, "cmd": cmd, "params": params,
    });
    if let Some(a) = auth {
        let nonce = random_hex(16);
        let ts = now_ms();
        let map = params_map(&frame["params"]);
        let tag = a.tag_for(cmd, &id, &map, &nonce, ts);
        frame["auth"] = serde_json::json!({ "nonce": nonce, "ts": ts, "tag": tag });
    }
    let mut s = UnixStream::connect(socket).map_err(|e| format!("cannot connect: {e}"))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .ok();
    s.write_all(format!("{frame}\n").as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    let mut line = String::new();
    BufReader::new(s)
        .read_line(&mut line)
        .map_err(|e| format!("read failed: {e}"))?;
    serde_json::from_str(line.trim()).map_err(|e| format!("bad response: {e}"))
}

fn params_map(v: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn refused(r: &serde_json::Value) -> Option<String> {
    if r.get("ok") == Some(&serde_json::Value::Bool(true)) {
        None
    } else {
        Some(format!(
            "{}: {}",
            r.get("code").and_then(|v| v.as_str()).unwrap_or("error"),
            r.get("message").and_then(|v| v.as_str()).unwrap_or("")
        ))
    }
}

fn render(a: &serde_json::Value) -> String {
    let g = |p: &str| -> String {
        let mut v = a;
        for k in p.split('.') {
            v = &v[k];
        }
        match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => "-".to_owned(),
            other => other.to_string(),
        }
    };
    let mut o = String::new();
    o.push_str("================ NEXUS APPROVAL REQUEST (daemon-authored) ================\n");
    o.push_str(&format!("approval      {}\n", g("approvalId")));
    o.push_str(&format!("state         {}\n", g("state")));
    o.push_str(&format!("tool          {} ({})\n", g("toolId"), g("scope")));
    o.push_str(&format!(
        "task/attempt  {} / {} (lease {})\n",
        g("taskInstanceId"),
        g("attemptId"),
        g("leaseEpoch")
    ));
    o.push_str(&format!("workspace     {}\n", g("workspaceRootDigest")));
    o.push_str(&format!("request sha   {}\n", g("requestDigest")));
    o.push_str(&format!("args sha      {}\n", g("argsDigest")));
    o.push_str(&format!("expires (ms)  {}\n", g("expiresMs")));
    let op = &a["request"]["operation"];
    o.push_str("---- operation ----\n");
    o.push_str(&serde_json::to_string_pretty(op).unwrap_or_default());
    o.push('\n');
    o.push_str("---- limits ----\n");
    o.push_str(&serde_json::to_string_pretty(&a["request"]["limits"]).unwrap_or_default());
    o.push('\n');
    let pv = &a["request"]["preview"];
    o.push_str(&format!(
        "---- review content ({}, bound by digest {}) ----\n",
        pv["kind"].as_str().unwrap_or("?"),
        pv["digest"].as_str().unwrap_or("none")
    ));
    match pv["text"].as_str() {
        Some(t) => o.push_str(t),
        None => o.push_str(&format!(
            "[UNAVAILABLE: {}] no summary is substituted\n",
            pv["reason"].as_str().unwrap_or("not provided")
        )),
    }
    o.push_str("\n==========================================================================\n");
    o
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(socket) = arg(&args, "--socket") else {
        eprintln!("--socket is required");
        return 2;
    };
    let cmd = args
        .iter()
        .find(|a| *a == "list" || *a == "review")
        .cloned()
        .unwrap_or_default();
    match cmd.as_str() {
        "list" => {
            let mut p = serde_json::Map::new();
            if let Some(t) = arg(&args, "--task") {
                p.insert("taskInstanceId".into(), t.into());
            }
            if let Some(t) = arg(&args, "--approval") {
                p.insert("approvalId".into(), t.into());
            }
            match call(&socket, None, "approval-list", serde_json::Value::Object(p)) {
                Ok(r) => {
                    if let Some(e) = refused(&r) {
                        eprintln!("refused: {e}");
                        return 4;
                    }
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&r["approvals"]).unwrap_or_default()
                    );
                    0
                }
                Err(e) => {
                    eprintln!("{e}");
                    4
                }
            }
        }
        "review" => review(&args, &socket),
        _ => {
            eprintln!("usage: nexus-approver --socket PATH (list [--task ID] [--approval ID] | --cap-file PATH review APPROVAL_ID)");
            2
        }
    }
}

fn review(args: &[String], socket: &str) -> i32 {
    let Some(id) = args.iter().skip_while(|a| *a != "review").nth(1).cloned() else {
        eprintln!("review requires an approval id");
        return 2;
    };
    let Some(cap_file) = arg(args, "--cap-file") else {
        eprintln!("--cap-file is required");
        return 2;
    };
    // Trusted-terminal precondition: a real terminal on both ends, and the
    // answer is read from the controlling terminal device, never a pipe.
    let (in_tty, out_tty) = unsafe { (libc::isatty(0) == 1, libc::isatty(1) == 1) };
    if !in_tty || !out_tty {
        eprintln!("refusing: approval requires an interactive terminal (stdin and stdout)");
        return 3;
    }
    let mut tty = match std::fs::File::open("/dev/tty") {
        Ok(f) => BufReader::new(f),
        Err(_) => {
            eprintln!("refusing: no controlling terminal");
            return 3;
        }
    };
    let key = match std::fs::read_to_string(&cap_file) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("cannot read approver capability: {e}");
            return 4;
        }
    };
    let auth = match IssuerAuth::from_key_hex(&key) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 4;
        }
    };
    let got = match call(
        socket,
        Some(&auth),
        "approval-get",
        serde_json::json!({"approvalId": id}),
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return 4;
        }
    };
    if let Some(e) = refused(&got) {
        eprintln!("refused: {e}");
        return 4;
    }
    let a = &got["approval"];
    print!("{}", render(a));
    let code = a["reviewCode"].as_str().unwrap_or("").to_owned();
    print!("Type the review code ({code}) to APPROVE, 'deny' to DENY, anything else to leave pending: ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    if tty.read_line(&mut answer).is_err() {
        eprintln!("no answer");
        return 3;
    }
    let answer = answer.trim();
    let decision = if answer == code {
        "approve"
    } else if answer.eq_ignore_ascii_case("deny") {
        "deny"
    } else {
        println!("left pending");
        return 0;
    };
    let digest = a["requestDigest"].as_str().unwrap_or("").to_owned();
    let r = call(
        socket,
        Some(&auth),
        "approval-decide",
        serde_json::json!({
            "approvalId": id, "requestDigest": digest, "decision": decision,
            "reviewCode": code, "reason": "terminal decision",
            "confirmation": { "tty": true },
        }),
    );
    match r {
        Ok(r) => match refused(&r) {
            None => {
                println!(
                    "recorded: {}",
                    r["approval"]["state"].as_str().unwrap_or("?")
                );
                0
            }
            Some(e) => {
                eprintln!("refused: {e}");
                4
            }
        },
        Err(e) => {
            eprintln!("{e}");
            4
        }
    }
}
