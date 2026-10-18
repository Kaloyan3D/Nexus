//! The WORKBENCH command policy (autonomy-first refactor).
//!
//! The strict policy in `process.rs` names a handful of exact argv shapes. That is the
//! right shape for an independently approved environment and the wrong one for ordinary
//! development: real projects need their own scripts, test runners, type checkers,
//! package managers and interpreters. The workbench policy therefore allows the usual
//! development programs with ordinary arguments, and relies on what actually bounds a
//! command instead of on guessing which argument strings are harmless:
//!
//! * the sandbox: no host filesystem, no secrets, no network (except the one install
//!   class below), no write-back, resource and wall-clock limits, cgroup supervision;
//! * a project-scoped environment directory (`/work/env`) for dependencies and caches;
//! * one explicit capability, dependency INSTALLATION, which is the only thing that
//!   gets the network, only for the package-manager forms that install, and only for
//!   projects that allow it.
//!
//! There is no host shell. `sh -c` exists only inside the sandbox, over the same
//! throw-away snapshot, so pipelines and `&&` chains work without widening anything.

use crate::contract::ProcessArgs;
use crate::process::{CommandPolicy, ResolvedCommand};
use crate::result::{ToolError, ToolErrorCode};
use std::collections::BTreeMap;
use std::path::Path;

/// Programs the model may name. The enum in the tool catalog is derived from this list.
pub const PROGRAMS: [&str; 13] = [
    "cargo", "npm", "npx", "pnpm", "yarn", "node", "tsc", "python3", "pip", "go", "dotnet", "sh",
    "make",
];

const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 1024;
const MAX_SCRIPT_BYTES: usize = 8 * 1024;
const INSTALL_WALL_MS: u64 = 15 * 60 * 1000;
const BUILD_WALL_MS: u64 = 15 * 60 * 1000;

fn refuse(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::CommandRefused, msg)
}

fn find(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| (*s).to_owned())
}

fn script_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || ":_.-/@".contains(c))
}

fn first_positional(args: &[String]) -> Option<(usize, &str)> {
    args.iter()
        .enumerate()
        .find(|(_, a)| !a.starts_with('-'))
        .map(|(i, a)| (i, a.as_str()))
}

pub(crate) fn resolve(pol: &CommandPolicy, a: &ProcessArgs) -> Result<ResolvedCommand, ToolError> {
    let cwd_rel = crate::workspace::RelPath::parse(&a.cwd)
        .map_err(|e| refuse(format!("cwd refused: {}", e.message)))?;
    let cwd = if cwd_rel.is_root() {
        "/work/src".to_owned()
    } else {
        format!("/work/src/{}", cwd_rel.components().join("/"))
    };
    let name = a.program.as_str();
    let limit = if name == "sh" {
        MAX_SCRIPT_BYTES
    } else {
        MAX_ARG_BYTES
    };
    if a.args.len() > MAX_ARGS
        || a.args
            .iter()
            .any(|x| x.len() > limit || x.contains('\0') || (name != "sh" && x.contains('\n')))
    {
        return Err(refuse("too many or too long arguments"));
    }
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    let mut path = String::from("/work/src/node_modules/.bin:/work/env/bin:");
    if pol.toolchain_has_cargo() {
        path.push_str("/toolchain/cargo/bin:");
    }
    path.push_str("/usr/bin:/bin");
    for (k, v) in [
        ("PATH", path.as_str()),
        ("HOME", "/work/out/home"),
        ("TMPDIR", "/tmp"),
        ("LANG", "C.UTF-8"),
        ("NO_COLOR", "1"),
        ("CI", "1"),
        ("npm_config_cache", "/work/env/npm-cache"),
        ("npm_config_update_notifier", "false"),
        ("npm_config_audit", "false"),
        ("npm_config_fund", "false"),
        ("CARGO_HOME", "/work/env/cargo-home"),
        ("CARGO_TARGET_DIR", "/work/env/target"),
        ("RUSTUP_HOME", "/work/out/rustup"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONUNBUFFERED", "1"),
        ("PYTHONPATH", "/work/env/pylib"),
        ("PIP_CACHE_DIR", "/work/env/pip-cache"),
        ("PIP_DISABLE_PIP_VERSION_CHECK", "1"),
        ("GOPATH", "/work/env/go"),
        ("GOMODCACHE", "/work/env/go/pkg/mod"),
        ("GOCACHE", "/work/env/go-cache"),
        ("GOTOOLCHAIN", "local"),
        ("GOFLAGS", "-mod=mod"),
        ("DOTNET_CLI_HOME", "/work/env/dotnet-home"),
        ("NUGET_PACKAGES", "/work/env/nuget"),
        ("DOTNET_NOLOGO", "1"),
        ("DOTNET_CLI_TELEMETRY_OPTOUT", "1"),
        ("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1"),
        ("DOTNET_GCHeapHardLimit", "0x80000000"),
        ("DOTNET_TieredPGO", "0"),
        ("DOTNET_EnableDiagnostics", "0"),
        // no compiler/build servers or node reuse: nothing may outlive the command
        ("UseSharedCompilation", "false"),
        ("MSBUILDDISABLENODEREUSE", "1"),
        ("DOTNET_CLI_USE_MSBUILD_SERVER", "0"),
        ("NUGET_XMLDOC_MODE", "skip"),
    ] {
        env.insert(k.to_owned(), v.to_owned());
    }
    let mut install = false;
    let args = &a.args;
    let sub = first_positional(args).map(|(_, s)| s).unwrap_or("");
    let program: String;
    let mut argv = args.clone();
    match name {
        "cargo" => {
            program = "/toolchain/cargo/bin/cargo".to_owned();
            if !pol.toolchain_has_cargo() {
                return Err(refuse("cargo toolchain is not available on this host"));
            }
            if !matches!(
                sub,
                "check"
                    | "test"
                    | "build"
                    | "fmt"
                    | "clippy"
                    | "doc"
                    | "run"
                    | "bench"
                    | "tree"
                    | "metadata"
                    | "fetch"
                    | "nextest"
                    | "clean"
                    | "version"
            ) {
                return Err(refuse(format!(
                    "cargo: '{sub}' is not available (check, test, build, fmt, clippy, doc, run, bench, tree, metadata, fetch)"
                )));
            }
            install = sub == "fetch";
            if !install {
                env.insert("CARGO_NET_OFFLINE".into(), "true".into());
            }
        }
        "npm" | "pnpm" | "yarn" => {
            program = find(&[
                &format!("/usr/bin/{name}"),
                &format!("/usr/local/bin/{name}"),
            ])
            .ok_or_else(|| refuse(format!("{name} is not available on this host")))?;
            let is_install = match (name, sub) {
                ("npm", "ci" | "install" | "i" | "add" | "update" | "up") => true,
                ("pnpm", "install" | "i" | "add" | "update" | "up") => true,
                ("yarn", "install" | "add" | "up" | "upgrade") => true,
                ("yarn", "") => true, // bare `yarn` installs
                _ => false,
            };
            let ok_sub = is_install
                || matches!(
                    sub,
                    "test"
                        | "t"
                        | "run"
                        | "run-script"
                        | "start"
                        | "exec"
                        | "x"
                        | "ls"
                        | "list"
                        | "outdated"
                        | "why"
                        | "rebuild"
                        | "build"
                        | "lint"
                        | "dlx_never"
                );
            if !ok_sub {
                return Err(refuse(format!(
                    "{name}: '{sub}' is not available (install forms, test, run <script>, exec, ls, build, lint)"
                )));
            }
            if matches!(sub, "run" | "run-script") {
                match args.iter().skip_while(|x| x.as_str() != sub).nth(1) {
                    Some(s) if script_name_ok(s) => {}
                    _ => return Err(refuse(format!("{name} run: a script name is required"))),
                }
            }
            install = is_install;
            if !install {
                env.insert("npm_config_offline".into(), "true".into());
            } else {
                // Packages ship build steps (esbuild's binary, native addons). npm 11+
                // blocks them unless allowed; inside this network-confined install sandbox,
                // for a project the user opened and allowed to install, they must run.
                env.insert(
                    "npm_config_dangerously_allow_all_scripts".into(),
                    "true".into(),
                );
            }
        }
        "npx" => {
            program = find(&["/usr/bin/npx", "/usr/local/bin/npx"])
                .ok_or_else(|| refuse("npx is not available on this host"))?;
            // local binaries only: never download and run a package
            if !args.iter().any(|x| x == "--no-install") {
                argv.insert(0, "--no-install".to_owned());
            }
            env.insert("npm_config_offline".into(), "true".into());
        }
        "node" => {
            program = find(&["/usr/bin/node", "/usr/local/bin/node"])
                .ok_or_else(|| refuse("node is not available on this host"))?;
            if args.iter().any(|x| x.starts_with("--inspect")) {
                return Err(refuse("node: the inspector is not available"));
            }
        }
        "tsc" => {
            // the project's own compiler (installed into its environment)
            program = find(&["/usr/bin/npx", "/usr/local/bin/npx"])
                .ok_or_else(|| refuse("npx is not available on this host"))?;
            argv.insert(0, "tsc".to_owned());
            argv.insert(0, "--no-install".to_owned());
            env.insert("npm_config_offline".into(), "true".into());
        }
        "python3" | "pip" => {
            program = find(&["/usr/bin/python3", "/usr/local/bin/python3"])
                .ok_or_else(|| refuse("python3 is not available on this host"))?;
            if name == "pip" {
                argv.insert(0, "pip".to_owned());
                argv.insert(0, "-m".to_owned());
            }
            let pos: Vec<&str> = argv.iter().map(String::as_str).collect();
            if let Some(i) = pos.iter().position(|x| *x == "-m") {
                if pos.get(i + 1) == Some(&"pip") {
                    let verb = pos.get(i + 2).copied().unwrap_or("");
                    match verb {
                        "install" | "download" => {
                            install = true;
                            env.insert("PIP_TARGET".into(), "/work/env/pylib".into());
                        }
                        "list" | "freeze" | "show" | "check" | "--version" | "" => {}
                        _ => return Err(refuse(format!("pip: '{verb}' is not available"))),
                    }
                }
            }
        }
        "go" => {
            program = find(&["/usr/bin/go", "/usr/local/go/bin/go", "/usr/lib/go/bin/go"])
                .ok_or_else(|| refuse("go is not available on this host"))?;
            if !matches!(
                sub,
                "build"
                    | "test"
                    | "vet"
                    | "fmt"
                    | "run"
                    | "mod"
                    | "list"
                    | "env"
                    | "version"
                    | "get"
                    | "install"
                    | "generate"
                    | "tool"
            ) {
                return Err(refuse(format!("go: '{sub}' is not available")));
            }
            let mod_sub = args
                .iter()
                .skip_while(|x| x.as_str() != "mod")
                .nth(1)
                .map(String::as_str);
            install = sub == "get"
                || (sub == "mod" && matches!(mod_sub, Some("download" | "tidy" | "vendor")));
            if !install {
                env.insert("GOPROXY".into(), "off".into());
            }
        }
        "dotnet" => {
            program = find(&["/usr/bin/dotnet", "/usr/local/bin/dotnet"])
                .ok_or_else(|| refuse("dotnet is not available on this host"))?;
            // `dotnet --version` has no positional: the first argument is the verb
            let sub = if sub.is_empty() {
                args.first().map(String::as_str).unwrap_or("")
            } else {
                sub
            };
            if !matches!(
                sub,
                "build"
                    | "test"
                    | "run"
                    | "restore"
                    | "format"
                    | "clean"
                    | "publish"
                    | "pack"
                    | "--info"
                    | "--version"
                    | "--list-sdks"
                    | "--list-runtimes"
                    | "add"
                    | "list"
                    | "msbuild"
                    | "new"
            ) {
                return Err(refuse(format!("dotnet: '{sub}' is not available")));
            }
            install = sub == "restore" || (sub == "add" && args.iter().any(|x| x == "package"));
        }
        "make" => {
            program = find(&["/usr/bin/make"]).ok_or_else(|| refuse("make is not available"))?;
        }
        "sh" => {
            program =
                find(&["/usr/bin/sh", "/bin/sh"]).ok_or_else(|| refuse("sh is not available"))?;
            if !(a.args.len() == 2 && matches!(a.args[0].as_str(), "-c" | "-ec" | "-eu" | "-lc")) {
                return Err(refuse(
                    "sh: only `-c <script>` exists (no interactive shell)",
                ));
            }
        }
        other => {
            return Err(refuse(format!(
                "program '{}' is not available; use one of {}",
                other.chars().take(40).collect::<String>(),
                PROGRAMS.join(", ")
            )))
        }
    }
    finish(name, program, argv, cwd, env, install, pol)
}

fn finish(
    name: &str,
    program: String,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    install: bool,
    pol: &CommandPolicy,
) -> Result<ResolvedCommand, ToolError> {
    Ok(ResolvedCommand {
        name: name.to_owned(),
        program,
        argv,
        cwd,
        env,
        ro_binds: pol.toolchain_binds_pub(),
        install,
        wall_ms: Some(if install {
            INSTALL_WALL_MS
        } else {
            BUILD_WALL_MS
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Toolchain;

    fn pol() -> CommandPolicy {
        CommandPolicy::standard(Toolchain::discover()).with_workbench()
    }
    fn args(program: &str, a: &[&str]) -> ProcessArgs {
        ProcessArgs {
            program: program.to_owned(),
            args: a.iter().map(|s| s.to_string()).collect(),
            cwd: ".".to_owned(),
        }
    }
    fn host(p: &str) -> bool {
        Path::new(p).exists()
    }

    #[test]
    fn only_the_install_forms_get_the_network() {
        let p = pol();
        if host("/usr/bin/npm") {
            for a in [
                &["ci"][..],
                &["install"],
                &["i", "left-pad"],
                &["install", "--legacy-peer-deps"],
            ] {
                let r = p.resolve(&args("npm", a)).expect("npm install form");
                assert!(r.install, "npm {a:?}");
                assert_eq!(r.env["npm_config_dangerously_allow_all_scripts"], "true");
            }
            for a in [
                &["test"][..],
                &["run", "build"],
                &["exec", "vitest"],
                &["ls"],
            ] {
                let r = p.resolve(&args("npm", a)).expect("npm form");
                assert!(!r.install, "npm {a:?} must stay offline");
                assert_eq!(r.env["npm_config_offline"], "true");
            }
        }
        if host("/usr/bin/python3") {
            let r = p
                .resolve(&args(
                    "python3",
                    &["-m", "pip", "install", "-r", "requirements.txt"],
                ))
                .unwrap();
            assert!(r.install);
            assert_eq!(r.env["PIP_TARGET"], "/work/env/pylib");
            assert!(
                !p.resolve(&args("python3", &["-m", "pytest", "-q"]))
                    .unwrap()
                    .install
            );
            assert!(!p.resolve(&args("python3", &["script.py"])).unwrap().install);
        }
        // a shell never gets the network, whatever it says
        if host("/usr/bin/sh") || host("/bin/sh") {
            let r = p
                .resolve(&args("sh", &["-c", "npm install && npm test"]))
                .unwrap();
            assert!(!r.install);
        }
    }

    #[test]
    fn the_workbench_refuses_what_is_not_development() {
        let p = pol();
        for (prog, a) in [
            ("git", &["push"][..]),
            ("curl", &["http://example.com"]),
            ("rm", &["-rf", "/"]),
            ("sudo", &["id"]),
            ("sh", &["-i"]),
            ("sh", &["script.sh"]),
            ("npm", &["publish"]),
            ("npm", &["config", "set", "x", "y"]),
            ("cargo", &["publish"]),
            ("cargo", &["install", "x"]),
            ("dotnet", &["nuget", "push"]),
            ("node", &["--inspect=0.0.0.0:9229", "x.js"]),
        ] {
            assert!(
                p.resolve(&args(prog, a)).is_err(),
                "{prog} {a:?} must be refused"
            );
        }
        // bounded argument vectors
        let many: Vec<String> = (0..100).map(|i| i.to_string()).collect();
        let r = p.resolve(&ProcessArgs {
            program: "node".into(),
            args: many,
            cwd: ".".into(),
        });
        assert!(r.is_err());
        // a bad working directory
        let r = p.resolve(&ProcessArgs {
            program: "node".into(),
            args: vec![],
            cwd: "../x".into(),
        });
        assert!(r.is_err());
    }

    #[test]
    fn the_strict_policy_is_unchanged_by_the_workbench() {
        let strict = CommandPolicy::standard(Toolchain::discover());
        assert!(!strict.is_workbench());
        assert!(strict.resolve(&args("sh", &["-c", "id"])).is_err());
        assert!(strict.resolve(&args("npm", &["install"])).is_err());
        assert!(strict
            .resolve(&args("python3", &["-c", "print(1)"]))
            .is_err());
    }
}
