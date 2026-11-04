//! Command-execution matrix (M4.x investigation). The same eight commands, through the real
//! `prepare -> authorize -> execute` path and the real sandbox, under two runtimes:
//!
//! * `with-rust`: a toolchain is discoverable (`~/.cargo`), as on a developer Linux machine;
//! * `no-rust`: no toolchain, as in the embedded engine image (Fedora minimal + node/python/chromium).
//!
//! For every command the table records where it stopped (resolver / authorization / sandbox / process), the
//! error code, the resolved executable, and the exit status. It prints the table (`--nocapture`) and asserts
//! the classification invariants: a missing executable is never reported as a policy decision, a refusal never
//! pretends to be a process failure, and an executed command's result carries its own exit status.

mod common;

use common::*;
use nexus_tools::contract::ProcessArgs;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process, CancellationToken};
use serde_json::{json, Value};

fn policy(with_rust: bool) -> CommandPolicy {
    let tc = if with_rust {
        Toolchain::discover()
    } else {
        Toolchain {
            cargo_home_bin: None,
            rustup_home: None,
            private_node: None,
        }
    };
    CommandPolicy::standard(tc).with_workbench()
}

fn ready() -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/sh").exists() {
        println!("NOT RUN: sandbox unavailable: {:?}", c.problems);
        assert!(
            std::env::var_os("NEXUS_REQUIRE_SANDBOX").is_none(),
            "NEXUS_REQUIRE_SANDBOX is set but the sandbox is unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

#[derive(Debug, Clone)]
pub struct Row {
    pub cmd: String,
    /// resolver / authorization / sandbox / process
    pub stopped_at: &'static str,
    pub code: Option<String>,
    pub message: Option<String>,
    pub resolved: Option<String>,
    pub exit: Option<i64>,
    pub verdict: Option<String>,
    pub stdout: String,
    pub stderr: String,
}

fn run_one(fx: &mut Fx, pol: &CommandPolicy, program: &str, args: &[&str]) -> Row {
    let cmd = format!("{program} {}", args.join(" "));
    let pa = ProcessArgs {
        program: program.to_owned(),
        args: args.iter().map(|s| (*s).to_owned()).collect(),
        cwd: ".".into(),
    };
    let resolved = pol.resolve(&pa);
    let (resolved_path, resolve_err) = match &resolved {
        Ok(rc) => (Some(rc.program.clone()), None),
        Err(e) => (None, Some((e.code.as_str().to_owned(), e.message.clone()))),
    };
    let r = fx.request(
        "proc.run",
        json!({"program": program, "args": args, "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let prepared = fx.prepare_p(r, pol);
    let p = match prepared {
        Ok(p) => p,
        Err(e) => {
            return Row {
                cmd,
                stopped_at: "resolver/prepare",
                code: Some(e.code.as_str().to_owned()),
                message: Some(e.message),
                resolved: resolved_path,
                exit: None,
                verdict: None,
                stdout: String::new(),
                stderr: String::new(),
            }
        }
    };
    let call = match authorize(&mut fx.kernel, p) {
        Ok(c) => c,
        Err(e) => {
            return Row {
                cmd,
                stopped_at: "authorization",
                code: Some(e.code.as_str().to_owned()),
                message: Some(e.message),
                resolved: resolved_path,
                exit: None,
                verdict: None,
                stdout: String::new(),
                stderr: String::new(),
            }
        }
    };
    let run = fx.dir.path().join(format!(
        "exec-{}",
        fx.dir.path().read_dir().map(|d| d.count()).unwrap_or(0)
    ));
    match execute_process(&mut fx.kernel, &call, &cancel, pol, &run, 600_000) {
        Ok(o) => {
            let out: Value = o.result.output.clone().unwrap_or(Value::Null);
            let _ = resolve_err;
            Row {
                cmd,
                stopped_at: "process",
                code: o.result.error.as_ref().map(|e| e.code.as_str().to_owned()),
                message: o.result.error.as_ref().map(|e| e.message.clone()),
                resolved: resolved_path,
                exit: out["exitCode"].as_i64(),
                verdict: out["verification"].as_str().map(str::to_owned),
                stdout: out["stdout"].as_str().unwrap_or("").trim().to_owned(),
                stderr: out["stderr"].as_str().unwrap_or("").trim().to_owned(),
            }
        }
        Err(e) => Row {
            cmd,
            stopped_at: "sandbox/execute",
            code: Some(e.code.as_str().to_owned()),
            message: Some(e.message),
            resolved: resolved_path,
            exit: None,
            verdict: None,
            stdout: String::new(),
            stderr: String::new(),
        },
    }
}

pub const MATRIX: &[(&str, &[&str])] = &[
    ("pwd", &[]),
    ("ls", &[]),
    ("echo", &["hello"]),
    ("cargo", &["--version"]),
    ("rustc", &["--version"]),
    ("sh", &["-c", "echo hello"]),
    ("python3", &["--version"]),
    ("which", &["cargo"]),
];

fn matrix(with_rust: bool, tag: &str) -> Vec<Row> {
    let mut fx = fixture(tag);
    fx.approve_process(120_000);
    let pol = policy(with_rust);
    MATRIX
        .iter()
        .map(|(p, a)| run_one(&mut fx, &pol, p, a))
        .collect()
}

fn show(label: &str, rows: &[Row]) {
    println!("== MATRIX {label}");
    for r in rows {
        println!(
            "MATRIX {label} | {:<22} | stopped={:<16} | code={:<22} | resolved={:<34} | exit={:<5} | verdict={:<10} | out={:?} err={:?} msg={:?}",
            r.cmd,
            r.stopped_at,
            r.code.as_deref().unwrap_or("-"),
            r.resolved.as_deref().unwrap_or("-"),
            r.exit.map(|e| e.to_string()).unwrap_or("-".into()),
            r.verdict.as_deref().unwrap_or("-"),
            r.stdout.chars().take(40).collect::<String>(),
            r.stderr.chars().take(60).collect::<String>(),
            r.message.as_deref().map(|m| m.chars().take(70).collect::<String>()),
        );
    }
}

fn row<'a>(rows: &'a [Row], cmd: &str) -> &'a Row {
    rows.iter().find(|r| r.cmd.trim() == cmd).expect(cmd)
}

#[test]
fn the_matrix_with_and_without_a_rust_toolchain() {
    if !ready() {
        return;
    }
    let with = matrix(true, "mx-with");
    let without = matrix(false, "mx-without");
    show("with-rust", &with);
    show("no-rust", &without);
    // programs that exist run, in both runtimes, and report their own exit status
    for rows in [&with, &without] {
        for c in [
            "pwd",
            "ls",
            "echo hello",
            "sh -c echo hello",
            "python3 --version",
        ] {
            let r = row(rows, c);
            assert_eq!(r.stopped_at, "process", "{c}: {r:?}");
            assert_eq!(r.exit, Some(0), "{c}: {r:?}");
        }
        assert_eq!(row(rows, "echo hello").stdout, "hello");
        assert_eq!(row(rows, "sh -c echo hello").stdout, "hello");
    }
    // `which cargo` is a normal process whose exit status says whether it found one: 0 with a toolchain on
    // PATH of the sandbox, 1 without. It is never a refusal.
    assert_eq!(row(&without, "which cargo").stopped_at, "process");
    assert_eq!(row(&without, "which cargo").exit, Some(1));

    // ---- the classification (the fix): a missing program is NOT a policy refusal ----
    for c in ["cargo --version", "rustc --version"] {
        let r = row(&without, c);
        assert_eq!(r.stopped_at, "resolver/prepare", "{c}: {r:?}");
        assert_eq!(
            r.code.as_deref(),
            Some("executable-not-found"),
            "{c}: {r:?}"
        );
        let m = r.message.as_deref().unwrap();
        assert!(
            m.contains("not a permission decision") && m.contains("nothing was run"),
            "{m}"
        );
        assert!(m.contains("Rust toolchain is not installed"), "{m}");
        assert!(m.contains("does not fall back to host execution"), "{m}");
        assert!(
            r.exit.is_none() && r.verdict.is_none(),
            "it never started: {r:?}"
        );
    }
    // with a toolchain the same names resolve to the bound toolchain and run
    for c in ["cargo --version", "rustc --version"] {
        let r = row(&with, c);
        assert_eq!((r.stopped_at, r.exit), ("process", Some(0)), "{c}: {r:?}");
        assert!(
            r.resolved
                .as_deref()
                .unwrap()
                .starts_with("/toolchain/cargo/bin/"),
            "{r:?}"
        );
    }
}

fn refusal_of(
    pol: &CommandPolicy,
    program: &str,
    args: &[&str],
) -> Result<String, (String, String)> {
    pol.resolve(&ProcessArgs {
        program: program.to_owned(),
        args: args.iter().map(|s| (*s).to_owned()).collect(),
        cwd: ".".into(),
    })
    .map(|rc| rc.program)
    .map_err(|e| (e.code.as_str().to_owned(), e.message))
}

#[test]
fn explicit_policy_denials_stay_command_refused_and_say_which_rule() {
    // no sandbox needed: the resolver is pure
    let pol = policy(true);
    let long_script = "x".repeat(9 * 1024);
    let many: Vec<String> = (0..65).map(|i| i.to_string()).collect();
    let many_ref: Vec<&str> = many.iter().map(String::as_str).collect();
    let cases: Vec<(&str, Vec<&str>, &str)> = vec![
        ("/bin/sh", vec!["-c", "id"], "not a valid program name"),
        ("../x", vec![], "not a valid program name"),
        ("scripts/../x", vec![], "not a valid program name"),
        ("sh", vec![], "only `-c <script>` or a project script file"),
        (
            "bash",
            vec!["-i"],
            "only `-c <script>` or a project script file",
        ),
        ("sh", vec!["-c"], "needs a command string"),
        (
            "sh",
            vec!["-c", &long_script],
            "too many or too long arguments",
        ),
        ("python3", many_ref, "too many or too long arguments"),
        (
            "python3",
            vec!["-c", "print(1)\nprint(2)"],
            "too many or too long arguments",
        ),
    ];
    for (prog, args, rule) in cases {
        let (code, msg) = refusal_of(&pol, prog, &args).expect_err(prog);
        assert_eq!(code, "command-refused", "{prog} {args:?}: {msg}");
        assert!(msg.contains(rule), "{prog}: {msg}");
        assert!(
            !msg.contains("not installed"),
            "a policy rule never claims a program is missing: {msg}"
        );
    }
}

#[test]
fn a_missing_program_is_executable_not_found_for_every_family() {
    let pol = policy(false);
    for prog in [
        "cargo",
        "rustc",
        "rustfmt",
        "cargo-clippy",
        "nexus-no-such-tool-m4x",
        "tsc-not-here-m4x",
    ] {
        let (code, msg) = refusal_of(&pol, prog, &["--version"]).expect_err(prog);
        // `tsc` is a name the workbench maps to npx; here npx may exist, so only assert the others strictly
        if prog == "tsc-not-here-m4x"
            || prog.starts_with("nexus-no-such")
            || ["cargo", "rustc", "rustfmt", "cargo-clippy"].contains(&prog)
        {
            assert_eq!(code, "executable-not-found", "{prog}: {msg}");
            assert!(
                msg.contains("not available inside the authorized runtime"),
                "{msg}"
            );
            assert!(msg.contains(&format!("'{prog}'")), "{msg}");
        }
    }
    // Rust-specific advice only for Rust programs
    let (_, rust) = refusal_of(&pol, "rustc", &[]).unwrap_err();
    let (_, other) = refusal_of(&pol, "nexus-no-such-tool-m4x", &[]).unwrap_err();
    assert!(rust.contains("Rust toolchain") && !other.contains("Rust toolchain"));
    // a project-local executable is a path, never a name search
    assert_eq!(
        refusal_of(&pol, "./scripts/build.sh", &[]).unwrap(),
        "/work/src/scripts/build.sh"
    );
    assert_eq!(
        refusal_of(&pol, "scripts/build.sh", &["a"]).unwrap(),
        "/work/src/scripts/build.sh"
    );
}

#[test]
fn the_strict_policy_reports_a_missing_toolchain_as_not_found_and_a_bad_form_as_refused() {
    let none = CommandPolicy::standard(Toolchain {
        cargo_home_bin: None,
        rustup_home: None,
        private_node: None,
    });
    let (code, msg) = refusal_of(&none, "cargo", &["check", "--offline"]).unwrap_err();
    assert_eq!(code, "executable-not-found", "{msg}");
    // the strict allowlist's own rules are policy
    let with = CommandPolicy::standard(Toolchain::discover());
    if Toolchain::discover().cargo_home_bin.is_some() {
        let (code, _) = refusal_of(&with, "cargo", &["--version"]).unwrap_err();
        assert_eq!(
            code, "command-refused",
            "strict profile: only check/test/build/fmt"
        );
        let (code, _) = refusal_of(&with, "cargo", &["check"]).unwrap_err();
        assert_eq!(code, "command-refused", "--offline is required");
    }
}

#[test]
fn path_and_executable_resolution_inside_the_sandbox() {
    if !ready() {
        return;
    }
    let mut fx = fixture("mx-path");
    fx.approve_process(120_000);
    let pol = policy(true);
    let r = run_one(
        &mut fx,
        &pol,
        "sh",
        &["-c", "echo $PATH; command -v python3 sh"],
    );
    assert_eq!(r.exit, Some(0), "{r:?}");
    let lines: Vec<&str> = r.stdout.lines().collect();
    // project-local tools first, the environment next, the toolchain, then the system directories
    assert!(
        lines[0].starts_with("/work/src/node_modules/.bin:/work/env/bin:"),
        "{}",
        lines[0]
    );
    assert!(
        lines[0].contains("/toolchain/cargo/bin")
            || !Toolchain::discover().cargo_home_bin.is_some()
    );
    assert!(lines[0].contains("/usr/bin:/bin"), "{}", lines[0]);
    assert!(
        lines[1..].iter().any(|l| l.ends_with("/python3"))
            && lines.iter().any(|l| l.ends_with("/sh")),
        "{lines:?}"
    );
}

#[test]
fn direct_and_shell_wrapped_forms_agree_and_differ_only_in_where_they_stop() {
    if !ready() {
        return;
    }
    let mut fx = fixture("mx-forms");
    fx.approve_process(120_000);
    // with a toolchain both forms run and print the same version
    let pol = policy(true);
    let direct = run_one(&mut fx, &pol, "cargo", &["--version"]);
    let wrapped = run_one(&mut fx, &pol, "sh", &["-c", "cargo --version"]);
    assert_eq!((direct.exit, wrapped.exit), (Some(0), Some(0)));
    assert_eq!(direct.stdout, wrapped.stdout);
    // without one: the direct form stops at the resolver with `executable-not-found`; the wrapped form
    // reaches the shell, which says exit 127 "not found". Same condition, both visibly "not installed".
    let pol = policy(false);
    let direct = run_one(&mut fx, &pol, "cargo", &["--version"]);
    let wrapped = run_one(&mut fx, &pol, "sh", &["-c", "cargo --version"]);
    assert_eq!(direct.code.as_deref(), Some("executable-not-found"));
    assert_eq!(
        (wrapped.stopped_at, wrapped.exit),
        ("process", Some(127)),
        "{wrapped:?}"
    );
    assert!(wrapped.stderr.contains("not found"), "{wrapped:?}");
}

#[test]
fn sandbox_denials_and_process_failures_are_process_results_never_refusals() {
    if !ready() {
        return;
    }
    let mut fx = fixture("mx-denial");
    fx.approve_process(120_000);
    let pol = policy(true);
    // writing outside the workspace is denied BY THE SANDBOX: the command starts, fails, and says why
    let denied = run_one(
        &mut fx,
        &pol,
        "sh",
        &["-c", "echo x > /etc/nexus-denied-m4x"],
    );
    assert_eq!(denied.stopped_at, "process", "{denied:?}");
    assert!(
        denied.exit.is_some_and(|e| e != 0) && denied.verdict.as_deref() == Some("fail"),
        "{denied:?}"
    );
    assert!(
        denied.code.is_none(),
        "a process failure carries no tool error code: {denied:?}"
    );
    assert!(
        denied.stderr.contains("Read-only file system")
            || denied.stderr.contains("Permission denied")
            || denied.stderr.contains("No such file"),
        "{denied:?}"
    );
    // an ordinary non-zero exit
    let failed = run_one(&mut fx, &pol, "sh", &["-c", "exit 3"]);
    assert_eq!(
        (failed.stopped_at, failed.exit, failed.verdict.as_deref()),
        ("process", Some(3), Some("fail")),
        "{failed:?}"
    );
    // an unknown program INSIDE a script is the shell's exit 127, a process result
    let nf = run_one(&mut fx, &pol, "sh", &["-c", "definitely-not-installed-m4x"]);
    assert_eq!((nf.stopped_at, nf.exit), ("process", Some(127)), "{nf:?}");
}
