//! The WORKBENCH command policy (autonomy-first refactor).
//!
//! The strict policy in `process.rs` names a handful of exact argv shapes. That is the
//! right shape for an independently approved environment and the wrong one for ordinary
//! development: real projects need their own scripts, test runners, type checkers,
//! package managers and interpreters.
//!
//! M6A — universal execution: there is NO executable-name allowlist here. Any program
//! installed inside the authorized runtime may be named — interpreters (`bash`, `python`,
//! `node`, …), Rust tools (`cargo`, `rustc`, `rustfmt`, `cargo-clippy`, …), package managers
//! (`npm`, `npx`, `pnpm`, `yarn`, `git`, …), formatters, linters, test runners, build systems —
//! and project-local executables may be named by workspace-relative path
//! (`./node_modules/.bin/vitest`, `scripts/build.sh`). What bounds a command is not its name:
//!
//! * command AUTHORIZATION (a Kernel-sealed grant for this project and task) is decided before
//!   this resolver runs and cannot be influenced by the program name or arguments;
//! * the sandbox: no host filesystem, no secrets, no network (except the classes below),
//!   resource and wall-clock limits, cgroup supervision;
//! * a project-scoped environment directory (`/work/env`) for dependencies and caches;
//! * one explicit legacy capability, dependency INSTALLATION, which is the only thing that
//!   gets the host network, only for the package-manager forms that install, and only for
//!   projects that allow it. Under Controlled Internet (M5) every command instead reaches
//!   only the grant's destinations through the gatekeeper, whatever its name.
//!
//! A program that does not exist inside the runtime fails here with an actionable message;
//! there is no fallback to host execution. The model cannot set environment variables,
//! a grant, a backend or a network destination through its arguments: `ProcessArgs` carries
//! only `program`, `args` and `cwd`, and the environment is built here, from the policy.
//!
//! There is no host shell. `sh -c` / `bash -c` exist only inside the sandbox, so pipelines
//! and `&&` chains work without widening anything.

use crate::contract::ProcessArgs;
use crate::process::{CommandPolicy, ResolvedCommand};
use crate::result::{ToolError, ToolErrorCode};
use std::collections::BTreeMap;
use std::path::Path;

/// Is `s` a syntactically valid program name for the workbench (a bare installed-program
/// name, or a workspace-relative path to a project-local executable)? Shared with the
/// broker, which pre-validates model proposals with exactly this rule.
pub fn program_syntax_ok(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 || s.contains('\0') || s.contains('\\') {
        return false;
    }
    if s.contains('/') {
        // project-local: relative, inside the workspace, no parent traversal
        !s.starts_with('/')
            && !s.split('/').any(|c| c == ".." || c.is_empty())
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._/@:=+-".contains(c))
    } else {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
    }
}

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

fn first_positional(args: &[String]) -> Option<(usize, &str)> {
    args.iter()
        .enumerate()
        .find(|(_, a)| !a.starts_with('-'))
        .map(|(i, a)| (i, a.as_str()))
}

/// A shell flag cluster that runs a command string (`-c`, `-ec`, `-euc`, `-lc`, …).
fn is_dash_c(f: &str) -> bool {
    f.len() >= 2
        && f.starts_with('-')
        && !f.starts_with("--")
        && f[1..].contains('c')
        && f[1..].chars().all(|c| c.is_ascii_alphabetic())
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
    let is_shell_name = matches!(name, "sh" | "bash");
    let limit = if is_shell_name {
        MAX_SCRIPT_BYTES
    } else {
        MAX_ARG_BYTES
    };
    if a.args.len() > MAX_ARGS
        || a.args
            .iter()
            .any(|x| x.len() > limit || x.contains('\0') || (!is_shell_name && x.contains('\n')))
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
    // Git must never block on a credential prompt: there are no credentials in the sandbox.
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    let mut install = false;
    let args = &a.args;
    let sub = first_positional(args).map(|(_, s)| s).unwrap_or("");
    let program: String;
    let mut argv = args.clone();
    let is_shell = matches!(name, "sh" | "bash");
    if !program_syntax_ok(name) {
        return Err(refuse(format!(
            "program '{name}' is not a valid program name: use the name of a program installed \
             in the runtime (cargo, git, node, ...) or a workspace-relative path to a project-local \
             executable (./node_modules/.bin/<tool>, scripts/<script>); absolute host paths and \
             '..' are refused"
        )));
    }
    if name.contains('/') {
        // Project-local executable: bound inside the workspace at /work/src (or the staged copy).
        let rel = name.strip_prefix("./").unwrap_or(name);
        program = format!("/work/src/{rel}");
    } else if is_shell {
        program = find(&[&format!("/usr/bin/{name}"), &format!("/bin/{name}")])
            .ok_or_else(|| refuse(format!("{name} is not available inside the authorized runtime (no {name} in /usr/bin or /bin); Nexus does not fall back to host execution")))?;
        match args.first().map(String::as_str) {
            Some(f) if is_dash_c(f) => {
                if args.len() < 2 {
                    return Err(refuse(format!("{name}: `-c` needs a command string")));
                }
            }
            // a project script file, run with the shell as interpreter
            Some(f) if !f.starts_with('-') => {}
            _ => {
                return Err(refuse(format!(
                "{name}: only `-c <script>` or a project script file exists (no interactive shell)"
            )))
            }
        }
    } else {
        match name {
            "cargo" | "rustc" | "rustfmt" | "cargo-clippy" | "clippy-driver" | "cargo-fmt"
            | "cargo-nextest"
                if pol.toolchain_has_cargo() =>
            {
                program = format!("/toolchain/cargo/bin/{name}");
            }
            "tsc" => {
                // the project's own compiler (installed into its environment)
                program = find(&["/usr/bin/npx", "/usr/local/bin/npx"]).ok_or_else(|| {
                    refuse("tsc needs npx, which is not available inside the authorized runtime")
                })?;
                argv.insert(0, "tsc".to_owned());
                argv.insert(0, "--no-install".to_owned());
                env.insert("npm_config_offline".into(), "true".into());
            }
            "pip" | "pip3" => {
                program = find(&["/usr/bin/python3", "/usr/local/bin/python3"]).ok_or_else(|| {
                    refuse("pip needs python3, which is not available inside the authorized runtime")
                })?;
                argv.insert(0, "pip".to_owned());
                argv.insert(0, "-m".to_owned());
            }
            "python" => {
                program = find(&[
                    "/usr/bin/python3",
                    "/usr/local/bin/python3",
                    "/usr/bin/python",
                ])
                .ok_or_else(|| refuse("python is not available inside the authorized runtime"))?;
            }
            _ => {
                program = find(&[
                    &format!("/usr/local/bin/{name}"),
                    &format!("/usr/bin/{name}"),
                    &format!("/bin/{name}"),
                ])
                .ok_or_else(|| refuse(format!(
                    "program '{name}' is not available inside the authorized runtime: no '{name}' in \
                     /usr/local/bin, /usr/bin, /bin or the Rust toolchain. Install it on this machine, \
                     install it into the project and name it by path (./node_modules/.bin/{name}), or \
                     use an available program. Nexus does not fall back to host execution"
                )))?;
            }
        }
        // Legacy dependency-installation classification: ONLY the install forms of known package
        // managers get the host-network install class. Every other command - known or not - is
        // offline unless the task's grant says Controlled Internet (handled outside this resolver).
        install = match name {
            "cargo" => sub == "fetch",
            "npm" => matches!(sub, "ci" | "install" | "i" | "add" | "update" | "up"),
            "pnpm" => matches!(sub, "install" | "i" | "add" | "update" | "up"),
            "yarn" => matches!(sub, "install" | "add" | "up" | "upgrade") || sub.is_empty(),
            "pip" | "pip3" | "python3" | "python" => {
                // the verb after `-m pip` (or after the inserted `-m pip` for pip itself)
                let pos: Vec<&str> = argv.iter().map(String::as_str).collect();
                let verb = pos
                    .windows(2)
                    .position(|w| w == ["-m", "pip"])
                    .and_then(|i| pos.get(i + 2).copied())
                    .unwrap_or("");
                matches!(verb, "install" | "download")
            }
            "go" => {
                let mod_sub = args
                    .iter()
                    .skip_while(|x| x.as_str() != "mod")
                    .nth(1)
                    .map(String::as_str);
                sub == "get"
                    || (sub == "mod" && matches!(mod_sub, Some("download" | "tidy" | "vendor")))
            }
            "dotnet" => sub == "restore" || (sub == "add" && args.iter().any(|x| x == "package")),
            _ => false,
        };
        if name == "npx" && !args.iter().any(|x| x == "--no-install") {
            // local binaries only on the offline path: never silently download a package
            argv.insert(0, "--no-install".to_owned());
        }
        if install {
            if matches!(name, "pip" | "pip3" | "python3" | "python") {
                env.insert("PIP_TARGET".into(), "/work/env/pylib".into());
            }
            if matches!(name, "npm" | "pnpm" | "yarn") {
                env.insert(
                    "npm_config_dangerously_allow_all_scripts".into(),
                    "true".into(),
                );
            }
        } else {
            match name {
                "cargo" => {
                    env.insert("CARGO_NET_OFFLINE".into(), "true".into());
                }
                "npm" | "pnpm" | "yarn" | "npx" => {
                    env.insert("npm_config_offline".into(), "true".into());
                }
                "go" => {
                    env.insert("GOPROXY".into(), "off".into());
                }
                _ => {}
            }
        }
    }
    let pipeline = is_shell_name
        && argv
            .get(1)
            .is_some_and(|s| crate::process::script_has_pipeline(s));
    let mut rc = finish(name, program, argv, cwd, env, install, pol)?;
    rc.shell_pipeline = pipeline;
    Ok(rc)
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
        shell_pipeline: false,
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
    fn m6a_any_installed_program_resolves_and_missing_ones_fail_actionably() {
        let p = pol();
        // Programs that exist on this host resolve with no name allowlist (M6A). Their
        // confinement comes from the sandbox, not from their name or argv shape.
        for (prog, a) in [
            ("git", &["status"][..]),
            ("git", &["commit", "-m", "x"]),
            ("bash", &["-c", "echo hi"]),
            ("rustc", &["--version"]),
            ("env", &["true"]),
            ("ls", &["-la"]),
        ] {
            if prog == "rustc" && !p.toolchain_has_cargo() {
                continue;
            }
            if (prog == "git" || prog == "bash" || prog == "env" || prog == "ls")
                && !host(&format!("/usr/bin/{prog}"))
                && !host(&format!("/bin/{prog}"))
            {
                continue;
            }
            let r = p
                .resolve(&args(prog, a))
                .unwrap_or_else(|e| panic!("{prog} {a:?} must resolve: {}", e.message));
            assert!(r.program.starts_with('/'), "{prog}: {}", r.program);
            assert!(
                !r.install,
                "{prog} {a:?} must not get the install network class"
            );
        }
        // project-local executables by workspace-relative path
        let r = p
            .resolve(&args("./node_modules/.bin/vitest", &["run"]))
            .expect("project-local tool resolves");
        assert_eq!(r.program, "/work/src/node_modules/.bin/vitest");
        let r = p
            .resolve(&args("scripts/build.sh", &[]))
            .expect("project script resolves");
        assert_eq!(r.program, "/work/src/scripts/build.sh");
        // not installed anywhere: actionable refusal, no host fallback
        let e = p
            .resolve(&args("nexus-no-such-tool-m6a", &[]))
            .expect_err("a missing program must be refused");
        assert!(
            e.message
                .contains("not available inside the authorized runtime"),
            "{}",
            e.message
        );
        assert!(
            e.message.contains("does not fall back to host execution"),
            "{}",
            e.message
        );
    }

    #[test]
    fn m6a_program_names_cannot_escape_the_runtime() {
        let p = pol();
        for prog in [
            "/usr/bin/git",
            "../bin/sh",
            "a/../b",
            "a//b",
            "",
            "git;rm",
            "git rm",
            "a\\b",
        ] {
            assert!(
                p.resolve(&args(prog, &[])).is_err(),
                "program {prog:?} must be refused"
            );
        }
        assert!(program_syntax_ok("cargo"));
        assert!(program_syntax_ok("./scripts/x.sh"));
        assert!(!program_syntax_ok("/etc/passwd"));
    }

    #[test]
    fn the_workbench_still_refuses_malformed_invocations() {
        let p = pol();
        for (prog, a) in [
            ("sh", &["-i"][..]),
            ("sh", &["-x"]),
            ("bash", &["-i"]),
            ("sh", &["-c"]),
        ] {
            assert!(
                p.resolve(&args(prog, a)).is_err(),
                "{prog} {a:?} must be refused"
            );
        }
        // a shell running a project script file is ordinary development work
        if host("/usr/bin/sh") || host("/bin/sh") {
            assert!(p.resolve(&args("sh", &["script.sh"])).is_ok());
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
