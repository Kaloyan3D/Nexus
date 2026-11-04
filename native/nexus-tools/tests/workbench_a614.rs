//! Autonomy-first: the workbench command set through the REAL Kernel and sandbox:
//! project dependencies installed once (network only for that class), kept in the
//! project environment, and used by later offline commands.
//! Prints `NOT RUN` when the host lacks the sandbox, node/npm, or the package registry.

mod common;

use common::*;
use nexus_tools::process::{CommandPolicy, ProjectEnv, Toolchain};
use nexus_tools::{authorize, execute_process_in, CancellationToken};
use serde_json::json;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready() -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || !std::path::Path::new("/usr/bin/node").exists()
        || !std::path::Path::new("/usr/bin/npm").exists()
    {
        println!("NOT RUN: sandbox or node/npm unavailable: {:?}", c.problems);
        return false;
    }
    true
}

fn run(
    fx: &mut Fx,
    env: Option<&ProjectEnv>,
    program: &str,
    args: &[&str],
) -> Result<serde_json::Value, nexus_tools::ToolError> {
    let r = fx.request(
        "proc.run",
        json!({"program": program, "args": args, "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol)?;
    let call = authorize(&mut fx.kernel, p)?;
    let run = fx.dir.path().join("exec");
    let o = execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &run, 900_000, env)?;
    Ok(o.result.output.unwrap_or_default())
}

fn out(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}

#[test]
fn dependencies_are_installed_once_and_used_offline_by_later_commands() {
    if !ready() {
        return;
    }
    let mut fx = fixture("wb-npm");
    let envdir = fx.dir.path().join("envs").join("proj");
    std::fs::create_dir_all(&envdir).unwrap();
    let env = ProjectEnv {
        dir: envdir.clone(),
        installs: true,
    };
    fx.write(
        "package.json",
        br#"{"name":"wb","version":"1.0.0","dependencies":{"is-odd":"3.0.1"}}"#,
    );
    fx.write(
        "index.js",
        b"const isOdd = require('is-odd');\nconsole.log('odd3=' + isOdd(3));\n",
    );
    // before installing, the dependency is simply missing: an honest, fixable failure
    fx.approve_process(60_000);
    let v = run(&mut fx, Some(&env), "node", &["index.js"]).expect("runs");
    assert_eq!(v["verification"], "fail", "{}", out(&v));
    assert!(out(&v).contains("Cannot find module"), "{}", out(&v));

    // install: the one networked class
    fx.approve_process(60_000);
    let v = match run(
        &mut fx,
        Some(&env),
        "npm",
        &["install", "--no-audit", "--no-fund"],
    ) {
        Ok(v) => v,
        Err(e) => panic!("install refused: {e:?}"),
    };
    if v["verification"] != "pass" {
        let t = out(&v);
        if t.contains("ENOTFOUND") || t.contains("EAI_AGAIN") || t.contains("network") {
            println!("NOT RUN: no package registry reachable: {t}");
            return;
        }
        panic!("npm install failed: {t}");
    }
    assert_eq!(v["network"], "install");
    assert!(
        envdir.join("nm/node_modules/is-odd").exists(),
        "kept for later commands"
    );
    // the workspace itself is untouched by the install
    assert!(!fx.ws.join("node_modules").exists());

    // later commands are offline and see the dependency
    fx.approve_process(60_000);
    let v = run(&mut fx, Some(&env), "node", &["index.js"]).expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert!(out(&v).contains("odd3=true"), "{}", out(&v));
    assert_eq!(v["network"], "none");

    // build output may be written next to the sources, and is discarded
    fx.approve_process(60_000);
    let v = run(
        &mut fx,
        Some(&env),
        "sh",
        &["-c", "echo built > dist.txt && cat dist.txt && ls"],
    )
    .expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert!(out(&v).contains("built"), "{}", out(&v));
    assert!(
        !fx.ws.join("dist.txt").exists(),
        "no write-back into the working copy"
    );

    // a project that does not allow installs gets no network at all
    let mut fx2 = fixture("wb-npm-off");
    let env2 = ProjectEnv {
        dir: fx2.dir.path().join("envs").join("p2"),
        installs: false,
    };
    std::fs::create_dir_all(&env2.dir).unwrap();
    fx2.write("package.json", br#"{"name":"x","version":"1.0.0"}"#);
    fx2.approve_process(60_000);
    let v = run(&mut fx2, Some(&env2), "npm", &["install"]).expect("returns a result");
    let t = format!("{v}");
    assert!(
        v.is_null() || t.contains("not enabled") || v["verification"] != "pass",
        "{t}"
    );
}

fn installed(
    fx: &mut Fx,
    env: &ProjectEnv,
    program: &str,
    args: &[&str],
) -> Option<serde_json::Value> {
    fx.approve_process(60_000);
    let v = run(fx, Some(env), program, args).expect("runs");
    if v["verification"] != "pass" {
        let t = out(&v);
        if t.contains("ENOTFOUND")
            || t.contains("EAI_AGAIN")
            || t.contains("Unable to load the service index")
            || t.contains("Could not find a version")
            || t.contains("Temporary failure")
        {
            println!("NOT RUN: no package registry reachable: {t}");
            return None;
        }
        panic!("{program} {args:?} failed: {t}");
    }
    Some(v)
}

#[test]
fn python_dependencies_install_once_and_import_offline() {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/python3").exists() {
        println!("NOT RUN: sandbox or python3 unavailable");
        return;
    }
    let mut fx = fixture("wb-py");
    let env = ProjectEnv {
        dir: fx.dir.path().join("envs/p"),
        installs: true,
    };
    std::fs::create_dir_all(&env.dir).unwrap();
    fx.write("requirements.txt", b"six==1.16.0\n");
    fx.write("app.py", b"import six\nprint('py3=' + str(six.PY3))\n");
    let Some(_) = installed(
        &mut fx,
        &env,
        "python3",
        &["-m", "pip", "install", "-r", "requirements.txt"],
    ) else {
        return;
    };
    fx.approve_process(60_000);
    let v = run(&mut fx, Some(&env), "python3", &["app.py"]).expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert!(out(&v).contains("py3=True"), "{}", out(&v));
    assert_eq!(v["network"], "none");
}

#[test]
fn a_dotnet_project_restores_once_then_builds_and_runs_offline() {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || !std::path::Path::new("/usr/bin/dotnet").exists() {
        println!("NOT RUN: sandbox or dotnet unavailable");
        return;
    }
    let mut fx = fixture("wb-dotnet");
    let env = ProjectEnv {
        dir: fx.dir.path().join("envs/p"),
        installs: true,
    };
    std::fs::create_dir_all(&env.dir).unwrap();
    fx.write(
        "app.csproj",
        b"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>\n",
    );
    fx.write(
        "Program.cs",
        b"Console.WriteLine(\"hello-from-dotnet \" + (21 * 2));\n",
    );
    // the target framework follows the installed SDK; ask it
    fx.approve_process(60_000);
    let v = run(&mut fx, Some(&env), "dotnet", &["--version"]).expect("runs");
    if v["verification"] != "pass" {
        println!("NOT RUN: dotnet does not start in the sandbox: {}", out(&v));
        return;
    }
    let major = out(&v).trim().split('.').next().unwrap_or("8").to_owned();
    fx.write(
        "app.csproj",
        format!("<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net{major}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>\n").as_bytes(),
    );
    let Some(_) = installed(&mut fx, &env, "dotnet", &["restore"]) else {
        return;
    };
    fx.approve_process(60_000);
    let v = run(&mut fx, Some(&env), "dotnet", &["run", "--no-restore"]).expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert!(out(&v).contains("hello-from-dotnet 42"), "{}", out(&v));
}

/// Found by the A7.1 live acceptance: a test runner (vitest) binds `localhost`; the network-off
/// sandbox had no hosts file, so it failed before running a single test.
#[test]
fn an_offline_command_resolves_localhost_from_the_sandbox_own_hosts_file() {
    if !ready() {
        return;
    }
    let mut fx = fixture("wb-localhost");
    fx.approve_process(60_000);
    let v = run(
        &mut fx,
        None,
        "node",
        &[
            "-e",
            "require('dns').lookup('localhost',(e,a)=>{console.log(e?'ERR '+e.code:'OK '+a); process.exit(e?1:0)})",
        ],
    )
    .expect("node runs");
    assert!(
        out(&v).contains("OK 127.0.0.1") || out(&v).contains("OK ::1"),
        "{}",
        out(&v)
    );
    fx.approve_process(60_000);
    let h = run(
        &mut fx,
        None,
        "node",
        &[
            "-e",
            "console.log(require('fs').readFileSync('/etc/hosts','utf8'))",
        ],
    )
    .expect("hosts");
    assert!(out(&h).contains("127.0.0.1 localhost"), "{}", out(&h));
}

/// M4.5: Rust dependencies (clap, rusqlite) are acquired through the install class (`cargo add`/`cargo fetch`
/// with the install network), kept in the project environment, and then built and tested OFFLINE.
#[test]
fn rust_dependencies_are_fetched_once_with_the_install_network_then_built_and_tested_offline() {
    let c = nexus_tools::sandbox::preflight();
    let has_cargo = std::process::Command::new("cargo")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !c.available || !has_cargo {
        println!("NOT RUN: sandbox or cargo unavailable: {:?}", c.problems);
        return;
    }
    let mut fx = fixture("wb-cargo");
    let envdir = fx.dir.path().join("envs").join("proj");
    std::fs::create_dir_all(&envdir).unwrap();
    let env = ProjectEnv {
        dir: envdir,
        installs: true,
    };
    fx.write(
        "Cargo.toml",
        b"[package]\nname = \"todo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nclap = { version = \"4\", features = [\"derive\"] }\nrusqlite = { version = \"0.31\", features = [\"bundled\"] }\n",
    );
    fx.write(
        "src/main.rs",
        b"use clap::Parser;\n#[derive(Parser)]\nstruct Cli { #[arg(long, default_value = \"hello\")] name: String }\nfn main() {\n    let c = Cli::parse();\n    let db = rusqlite::Connection::open_in_memory().unwrap();\n    db.execute(\"create table t (n text)\", []).unwrap();\n    db.execute(\"insert into t values (?1)\", [&c.name]).unwrap();\n    let n: String = db.query_row(\"select n from t\", [], |r| r.get(0)).unwrap();\n    println!(\"stored={n}\");\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn sqlite_works() {\n        let db = rusqlite::Connection::open_in_memory().unwrap();\n        let v: i64 = db.query_row(\"select 41 + 1\", [], |r| r.get(0)).unwrap();\n        assert_eq!(v, 42);\n    }\n}\n",
    );
    // offline, before acquiring anything: an honest, fixable failure (no network, nothing cached)
    fx.approve_process(900_000);
    let v = run(&mut fx, Some(&env), "cargo", &["build", "--offline"]).expect("runs");
    assert_eq!(v["verification"], "fail", "{}", out(&v));
    assert_eq!(v["network"], "none");

    // acquire: the one networked class
    fx.approve_process(900_000);
    let v = run(&mut fx, Some(&env), "cargo", &["fetch"]).expect("fetch is not refused");
    if v["verification"] != "pass" {
        let t = out(&v);
        if t.contains("resolve host") || t.contains("network") || t.contains("Could not resolve") {
            println!("NOT RUN: no crate registry reachable: {t}");
            return;
        }
        panic!("cargo fetch failed: {t}");
    }
    assert_eq!(v["network"], "install");

    // build and test offline from the cache (bundled sqlite is compiled with the image's gcc)
    fx.approve_process(900_000);
    let v = run(&mut fx, Some(&env), "cargo", &["build", "--offline"]).expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert_eq!(v["network"], "none");
    fx.approve_process(900_000);
    let v = run(&mut fx, Some(&env), "cargo", &["test", "--offline"]).expect("runs");
    assert_eq!(v["verification"], "pass", "{}", out(&v));
    assert!(out(&v).contains("test result: ok. 1 passed"), "{}", out(&v));
}
