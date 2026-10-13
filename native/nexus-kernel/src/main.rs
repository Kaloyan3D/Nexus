//! A1.2 kernel binary: store init, read-only status, and the versioned
//! shadow bridge surface (acquire | seal | accept | receipt | journal |
//! digest). There is deliberately NO dispatch, exec, or network capability:
//! acceptance reserves intent durably and dispatch stays disabled.
use std::path::{Path, PathBuf};

use nexus_kernel::bridge;

fn usage() -> i32 {
    println!("nexus-kernel 0.1.0 (A1.2 shadow bridge, protocol 1)");
    println!("usage:");
    println!("  nexus-kernel init --db PATH [--witness PATH]");
    println!("  nexus-kernel status --db PATH");
    println!("  nexus-kernel acquire --db PATH [--witness PATH] --input REQUEST.json");
    println!("  nexus-kernel seal --db PATH [--witness PATH] --input REQUEST.json");
    println!("  nexus-kernel accept --db PATH [--witness PATH] --input REQUEST.json");
    println!("  nexus-kernel receipt --db PATH --input REQUEST.json");
    println!("  nexus-kernel journal --db PATH --input REQUEST.json");
    println!("  nexus-kernel digest --input REQUEST.json");
    println!("Bridge requests are bounded JSON (protocol: 1). Responses are");
    println!("JSON on stdout; process-level failures use stderr with exit 2.");
    println!("A1.2 performs no external effects; dispatch is disabled.");
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    let db = flag(&args, "--db");
    let witness = flag(&args, "--witness");
    let input = flag(&args, "--input");
    let code = match cmd {
        "init" => match db {
            Some(p) => init(&p, witness),
            None => {
                eprintln!("--db is required");
                2
            }
        },
        "status" => match db {
            Some(p) => status(&p),
            None => {
                eprintln!("--db is required");
                2
            }
        },
        "acquire" | "seal" | "accept" | "receipt" | "journal" => match (db, input) {
            (Some(p), Some(i)) => bridge_command(cmd, &p, witness, &i),
            _ => {
                eprintln!("--db and --input are required for {cmd}");
                2
            }
        },
        "digest" => match input {
            Some(i) => digest_command(&i),
            None => {
                eprintln!("--input is required for digest");
                2
            }
        },
        _ => usage(),
    };
    std::process::exit(code);
}

fn flag(args: &[String], name: &str) -> Option<PathBuf> {
    let mut it = args.iter().peekable();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(PathBuf::from);
        }
    }
    None
}

fn init(db: &Path, witness: Option<PathBuf>) -> i32 {
    match nexus_kernel::Kernel::open(db, witness.as_deref()) {
        Ok(k) => {
            println!(
                "store ready incarnation={} dispatch_enabled={}",
                k.incarnation(),
                nexus_kernel::Kernel::dispatch_enabled()
            );
            0
        }
        Err(e) => {
            eprintln!("init failed: {}: {}", e.code, e.message);
            1
        }
    }
}

fn status(db: &Path) -> i32 {
    match nexus_kernel::Kernel::open(db, None) {
        Ok(k) => match (k.count_commands(), k.count_receipts(), k.list_all_events()) {
            (Ok(c), Ok(r), Ok(e)) => {
                println!(
                    "commands={} receipts={} events={} dispatch_enabled={}",
                    c,
                    r,
                    e.len(),
                    nexus_kernel::Kernel::dispatch_enabled()
                );
                0
            }
            _ => {
                eprintln!("status read failed");
                1
            }
        },
        Err(e) => {
            eprintln!("open failed: {}: {}", e.code, e.message);
            1
        }
    }
}

fn bridge_command(cmd: &str, db: &Path, witness: Option<PathBuf>, input: &Path) -> i32 {
    let req = match bridge::read_request(input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("bridge request rejected: {e}");
            return 2;
        }
    };
    // The witness is opened only when the caller names it. A generation
    // that is already witness-protected fails closed when the witness is
    // omitted (witness-required) rather than proceeding unprotected.
    let mut kernel = match nexus_kernel::Kernel::open(db, witness.as_deref()) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("open failed: {}: {}", e.code, e.message);
            return 2;
        }
    };
    let response = bridge::execute(&mut kernel, cmd, &req);
    match serde_json::to_string(&response) {
        Ok(text) => {
            println!("{text}");
            0
        }
        Err(e) => {
            eprintln!("response encoding failed: {e}");
            2
        }
    }
}

fn digest_command(input: &Path) -> i32 {
    let req = match bridge::read_request(input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("bridge request rejected: {e}");
            return 2;
        }
    };
    if req.get("protocol") != Some(&serde_json::json!(bridge::BRIDGE_PROTOCOL_VERSION)) {
        eprintln!("bridge request rejected: bad-request: 'protocol' must be 1");
        return 2;
    }
    let value = match req.get("value") {
        Some(v) => v.clone(),
        None => {
            eprintln!("bridge request rejected: bad-request: 'value' is required");
            return 2;
        }
    };
    match serde_json::to_string(&bridge::digest_value(&value)) {
        Ok(text) => {
            println!("{text}");
            0
        }
        Err(e) => {
            eprintln!("response encoding failed: {e}");
            2
        }
    }
}
