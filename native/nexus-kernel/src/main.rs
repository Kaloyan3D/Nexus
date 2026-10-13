//! A1.1 kernel binary: store init and read-only status only.
//! There is deliberately NO dispatch, exec, or network capability:
//! acceptance reserves intent durably and dispatch stays disabled.
use std::path::{Path, PathBuf};

fn usage() -> i32 {
    println!("nexus-kernel 0.1.0 (A1.1)");
    println!("usage:");
    println!("  nexus-kernel init --db PATH [--witness PATH]");
    println!("  nexus-kernel status --db PATH");
    println!("A1.1 performs no external effects; dispatch is disabled.");
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    let db = flag(&args, "--db");
    let witness = flag(&args, "--witness");
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
