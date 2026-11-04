//! M4.5 unified permission modes: what each mode does with each class of command.
//!
//! The mode is a per-RUN setting that decides whether the person must say yes before a command runs. It
//! never widens what the command CAN do: the filesystem scope, the network scope and the sandbox are the
//! task's frozen standing grant (see `grant.rs`), exactly as before. A mode only chooses between "run it"
//! and "ask first"; "Full Access" therefore means "do not ask" inside that grant, not "remove the grant".
//!
//! Classification is derived from the SAME resolver the daemon uses to decide a command's network class
//! (`CommandPolicy::resolve`, `install`), so the broker's gate and the daemon's network decision cannot
//! disagree about what an operation is. A command wrapped in `sh -c` never gets the install network (the
//! resolver does not grant it), so wrapping cannot turn a gated install into an ungated one.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::contract::ProcessArgs;
use crate::process::{CommandPolicy, Toolchain};

/// The three selectable modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PermissionMode {
    /// Safe operations run; installs, bulk deletions and other sensitive operations wait for the person.
    #[default]
    Ask,
    /// As `Ask`, but single-file deletions also run; installs and bulk deletions still ask.
    AutoSafe,
    /// Nothing waits for the person inside the task's grant (installs included). Records are still kept.
    Full,
}

impl PermissionMode {
    pub const ASK: &'static str = "ask";
    pub const AUTO_SAFE: &'static str = "auto-safe";
    pub const FULL: &'static str = "full";

    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Ask => Self::ASK,
            PermissionMode::AutoSafe => Self::AUTO_SAFE,
            PermissionMode::Full => Self::FULL,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            Self::ASK => Some(PermissionMode::Ask),
            Self::AUTO_SAFE => Some(PermissionMode::AutoSafe),
            Self::FULL => Some(PermissionMode::Full),
            _ => None,
        }
    }

    /// Autonomy order: a higher rank asks less. Changing to a higher rank is an upgrade.
    pub fn rank(self) -> u8 {
        match self {
            PermissionMode::Ask => 0,
            PermissionMode::AutoSafe => 1,
            PermissionMode::Full => 2,
        }
    }
}

/// What a command is, for permission purposes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpClass {
    /// Builds, tests, reads, local scripts, ordinary file creation: never waits.
    Safe,
    /// Dependency acquisition with the install network (the only network a command can be given).
    Install(InstallPlan),
    /// Removes a single file or empty directory.
    Delete,
    /// Recursive or pattern deletion, `git clean`, `git reset --hard`.
    BulkDelete,
}

impl OpClass {
    pub fn label(&self) -> &'static str {
        match self {
            OpClass::Safe => "safe",
            OpClass::Install(_) => "dependency-install",
            OpClass::Delete => "delete",
            OpClass::BulkDelete => "bulk-delete",
        }
    }
}

/// What the broker does with a class in a mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Run,
    Ask,
}

pub fn gate(mode: PermissionMode, class: &OpClass) -> Gate {
    match (mode, class) {
        (PermissionMode::Full, _) => Gate::Run,
        (_, OpClass::Safe) => Gate::Run,
        (_, OpClass::Install(_)) => Gate::Ask,
        (_, OpClass::BulkDelete) => Gate::Ask,
        (PermissionMode::Ask, OpClass::Delete) => Gate::Ask,
        (PermissionMode::AutoSafe, OpClass::Delete) => Gate::Run,
    }
}

/// One requested dependency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    pub name: String,
    /// The version constraint as written (`4`, `^1.2`, `>=2,<3`), empty when none was given.
    pub constraint: String,
}

/// The package-manager operation behind an install-class command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct InstallPlan {
    /// `cargo` | `npm` | `pnpm` | `yarn` | `pip` | `go` | `dotnet`
    pub manager: String,
    /// `add` | `install` | `ci` | `fetch` | `update` | ...
    pub verb: String,
    pub packages: Vec<Package>,
    /// Options that change what is installed (`--features bundled`, `--save-dev`, `-r requirements.txt`).
    pub options: Vec<String>,
    /// True when the command takes its dependency list from the project's manifest or lockfile rather
    /// than from its own arguments.
    pub from_manifest: bool,
}

fn base(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

fn split_constraint(spec: &str) -> Package {
    // `name@1.2`, `@scope/name@^3` (the first '@' of a scoped name is part of the name), `name>=2,<3`, `name==1`
    let s = spec.trim();
    if let Some(i) = s.rfind('@').filter(|i| *i > 0) {
        return Package {
            name: s[..i].to_owned(),
            constraint: s[i + 1..].to_owned(),
        };
    }
    if let Some(i) = s.find(['<', '>', '=', '!', '~']) {
        return Package {
            name: s[..i].trim().to_owned(),
            constraint: s[i..].trim().to_owned(),
        };
    }
    Package {
        name: s.to_owned(),
        constraint: String::new(),
    }
}

/// Parse an install-class command into what it will fetch. Unknown shapes still produce a plan (manager,
/// verb, raw positional arguments): a prompt must show something even for a form this parser does not know.
pub fn install_plan(program: &str, args: &[String]) -> InstallPlan {
    let name = base(program);
    let mut plan = InstallPlan {
        manager: match name {
            "pip3" | "python" | "python3" => "pip".to_owned(),
            n => n.to_owned(),
        },
        ..Default::default()
    };
    // arguments of the form `-m pip <verb> ...` (or `pip <verb> ...`)
    let rest: Vec<&str> = match name {
        "pip" | "pip3" => args.iter().map(String::as_str).collect(),
        "python" | "python3" => {
            let pos = args.iter().position(|a| a == "pip");
            match pos {
                Some(i) => args.iter().skip(i + 1).map(String::as_str).collect(),
                None => Vec::new(),
            }
        }
        _ => args.iter().map(String::as_str).collect(),
    };
    // flags that take a value (their value is not a package)
    let valued: &[&str] = match plan.manager.as_str() {
        "cargo" => &[
            "--features",
            "-F",
            "--rename",
            "--registry",
            "--manifest-path",
            "--git",
            "--path",
            "--branch",
            "--tag",
            "--rev",
            "--target",
            "--package",
            "-p",
            "--color",
        ],
        "pip" => &[
            "-r",
            "--requirement",
            "-c",
            "--constraint",
            "-e",
            "--editable",
            "--target",
            "-t",
            "-i",
            "--index-url",
            "--extra-index-url",
        ],
        "npm" | "pnpm" | "yarn" => &["--registry", "--prefix", "--workspace", "-w", "--filter"],
        _ => &[],
    };
    let mut i = 0;
    let mut verb_seen = false;
    while i < rest.len() {
        let a = rest[i];
        if a.starts_with('+') && !verb_seen && plan.manager == "cargo" {
            i += 1; // rustup toolchain override
            continue;
        }
        if a.starts_with('-') {
            let takes = valued.contains(&a) && !a.contains('=');
            if takes && i + 1 < rest.len() {
                plan.options.push(format!("{a} {}", rest[i + 1]));
                if matches!(a, "-r" | "--requirement" | "-c" | "--constraint") {
                    plan.from_manifest = true;
                }
                i += 2;
                continue;
            }
            plan.options.push(a.to_owned());
        } else if !verb_seen {
            plan.verb = a.to_owned();
            verb_seen = true;
        } else {
            plan.packages.push(split_constraint(a));
        }
        i += 1;
    }
    // go: `go mod download|tidy|vendor`, `go get pkg`
    if plan.manager == "go" && plan.verb == "mod" {
        if let Some(p) = plan.packages.first().cloned() {
            plan.verb = format!("mod {}", p.name);
            plan.packages.remove(0);
        }
    }
    if plan.packages.is_empty() {
        plan.from_manifest = true;
    }
    plan
}

/// Locations whose contents are scratch or regenerable, so removing them is not a decision for the person:
/// the sandbox's own temporary and environment directories, and build output that the next build recreates.
fn is_benign_delete_target(raw: &str) -> bool {
    let t = raw.trim_matches(|c| c == '"' || c == '\'');
    if t.is_empty() || t.contains("..") || t.contains('*') || t.contains('?') || t.contains('$') {
        return false;
    }
    if ["/tmp/", "/var/tmp/", "/work/out/", "/work/env/"]
        .iter()
        .any(|p| t.starts_with(p))
    {
        return true;
    }
    let name = t.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let relative = !t.starts_with('/');
    relative
        && matches!(
            name,
            "target"
                | "build"
                | "dist"
                | "node_modules"
                | "__pycache__"
                | ".pytest_cache"
                | ".cache"
        )
}

/// One command (a program word and what follows it up to the next separator).
fn delete_class_of_segment(toks: &[&str]) -> Option<OpClass> {
    let mut out: Option<OpClass> = None;
    let mut bump = |c: OpClass| {
        out = Some(match (&out, c) {
            (Some(OpClass::BulkDelete), _) | (_, OpClass::BulkDelete) => OpClass::BulkDelete,
            (_, other) => other,
        });
    };
    for (i, t) in toks.iter().enumerate() {
        let t = base(t);
        let after = &toks[i + 1..];
        let recursive = |a: &&str| {
            (a.starts_with('-') && !a.starts_with("--") && a.chars().any(|c| c == 'r' || c == 'R'))
                || *a == "--recursive"
        };
        match t {
            "rm" | "rmdir" | "unlink" | "shred" | "truncate" => {
                let operands: Vec<&&str> = after
                    .iter()
                    .take(8)
                    .filter(|a| !a.starts_with('-'))
                    .collect();
                if !operands.is_empty() && operands.iter().all(|o| is_benign_delete_target(o)) {
                    continue;
                }
                if t == "rm" {
                    if after.iter().take(8).any(recursive)
                        || operands.iter().any(|o| o.contains('*') || o.contains('?'))
                    {
                        bump(OpClass::BulkDelete)
                    } else {
                        bump(OpClass::Delete)
                    }
                } else {
                    bump(OpClass::Delete)
                }
            }
            "find" if after.contains(&"-delete") => {
                let roots: Vec<&&str> = after.iter().take_while(|a| !a.starts_with('-')).collect();
                if roots.is_empty() || !roots.iter().all(|o| is_benign_delete_target(o)) {
                    bump(OpClass::BulkDelete)
                }
            }
            "git" => {
                let verb = after.iter().find(|a| !a.starts_with('-')).copied();
                match verb {
                    Some("clean") => bump(OpClass::BulkDelete),
                    Some("reset") if after.contains(&"--hard") => bump(OpClass::BulkDelete),
                    Some("checkout") | Some("restore") if after.contains(&".") => {
                        bump(OpClass::BulkDelete)
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

fn worst(a: Option<OpClass>, b: Option<OpClass>) -> Option<OpClass> {
    match (a, b) {
        (Some(OpClass::BulkDelete), _) | (_, Some(OpClass::BulkDelete)) => {
            Some(OpClass::BulkDelete)
        }
        (Some(x), _) => Some(x),
        (None, y) => y,
    }
}

/// A shell script split into commands at `;`, `&&`, `||`, `|`, `&` and newlines (words keep their quotes
/// stripped); substitutions and grouping characters are treated as separators too, which only makes the
/// reading more suspicious, never less.
fn delete_class_of_script(script: &str) -> Option<OpClass> {
    let mut out = None;
    for seg in script.split([';', '&', '|', '\n', '(', ')', '`', '{', '}']) {
        let words: Vec<&str> = seg
            .split_whitespace()
            .map(|w| w.trim_matches(|c| c == '"' || c == '\''))
            .filter(|w| !w.is_empty())
            .collect();
        out = worst(out, delete_class_of_segment(&words));
    }
    out
}

fn policy() -> &'static CommandPolicy {
    static P: OnceLock<CommandPolicy> = OnceLock::new();
    P.get_or_init(|| CommandPolicy::standard(Toolchain::discover()).with_workbench())
}

/// Classify one proposed command. `install` comes from the daemon's own resolver.
pub fn classify(args: &ProcessArgs) -> OpClass {
    let name = base(&args.program).to_owned();
    if let Ok(r) = policy().resolve(args) {
        if r.install {
            return OpClass::Install(install_plan(&name, &args.args));
        }
    }
    // deletion: direct programs and shell wrappers (`sh -c '...'`, `bash -lc`, python one-liners are not parsed)
    if matches!(name.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh") {
        if let Some(script) = args
            .args
            .iter()
            .position(|a| a == "-c" || (a.starts_with('-') && a.ends_with('c') && a.len() <= 4))
            .and_then(|i| args.args.get(i + 1))
        {
            return delete_class_of_script(script).unwrap_or(OpClass::Safe);
        }
        return OpClass::Safe;
    }
    let mut toks: Vec<&str> = vec![name.as_str()];
    toks.extend(args.args.iter().map(String::as_str));
    delete_class_of_segment(&toks).unwrap_or(OpClass::Safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(program: &str, args: &[&str]) -> ProcessArgs {
        ProcessArgs {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".into(),
        }
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn modes_parse_and_order_by_autonomy() {
        for m in [
            PermissionMode::Ask,
            PermissionMode::AutoSafe,
            PermissionMode::Full,
        ] {
            assert_eq!(PermissionMode::parse(m.as_str()), Some(m));
        }
        assert_eq!(PermissionMode::parse("yolo"), None);
        assert!(PermissionMode::Ask.rank() < PermissionMode::AutoSafe.rank());
        assert!(PermissionMode::AutoSafe.rank() < PermissionMode::Full.rank());
        assert_eq!(PermissionMode::default(), PermissionMode::Ask);
    }

    #[test]
    fn the_gate_table_is_exactly_the_specified_one() {
        let inst = OpClass::Install(InstallPlan::default());
        for (mode, class, want) in [
            (PermissionMode::Ask, OpClass::Safe, Gate::Run),
            (PermissionMode::Ask, inst.clone(), Gate::Ask),
            (PermissionMode::Ask, OpClass::Delete, Gate::Ask),
            (PermissionMode::Ask, OpClass::BulkDelete, Gate::Ask),
            (PermissionMode::AutoSafe, OpClass::Safe, Gate::Run),
            (PermissionMode::AutoSafe, inst.clone(), Gate::Ask),
            (PermissionMode::AutoSafe, OpClass::Delete, Gate::Run),
            (PermissionMode::AutoSafe, OpClass::BulkDelete, Gate::Ask),
            (PermissionMode::Full, OpClass::Safe, Gate::Run),
            (PermissionMode::Full, inst, Gate::Run),
            (PermissionMode::Full, OpClass::Delete, Gate::Run),
            (PermissionMode::Full, OpClass::BulkDelete, Gate::Run),
        ] {
            assert_eq!(gate(mode, &class), want, "{mode:?} {class:?}");
        }
    }

    #[test]
    fn cargo_add_is_parsed_with_versions_and_features() {
        let p = install_plan(
            "cargo",
            &s(&[
                "add",
                "clap@4",
                "rusqlite@0.31",
                "--features",
                "bundled",
                "serde",
            ]),
        );
        assert_eq!(p.manager, "cargo");
        assert_eq!(p.verb, "add");
        assert_eq!(
            p.packages,
            vec![
                Package {
                    name: "clap".into(),
                    constraint: "4".into()
                },
                Package {
                    name: "rusqlite".into(),
                    constraint: "0.31".into()
                },
                Package {
                    name: "serde".into(),
                    constraint: "".into()
                },
            ]
        );
        assert_eq!(p.options, vec!["--features bundled".to_owned()]);
        assert!(!p.from_manifest);
        // a feature value is never mistaken for a package
        assert!(!p.packages.iter().any(|x| x.name == "bundled"));
    }

    #[test]
    fn manifest_driven_forms_say_so() {
        let f = install_plan("cargo", &s(&["fetch"]));
        assert!(f.from_manifest && f.packages.is_empty() && f.verb == "fetch");
        let c = install_plan("npm", &s(&["ci"]));
        assert!(c.from_manifest && c.verb == "ci");
        let r = install_plan(
            "python3",
            &s(&["-m", "pip", "install", "-r", "requirements.txt"]),
        );
        assert_eq!(r.manager, "pip");
        assert!(r.from_manifest);
        assert_eq!(r.options, vec!["-r requirements.txt".to_owned()]);
    }

    #[test]
    fn npm_pnpm_and_pip_packages_and_constraints() {
        let n = install_plan(
            "npm",
            &s(&["install", "--save-dev", "@types/node@^20", "left-pad"]),
        );
        assert_eq!(n.verb, "install");
        assert_eq!(
            n.packages[0],
            Package {
                name: "@types/node".into(),
                constraint: "^20".into()
            }
        );
        assert_eq!(n.packages[1].name, "left-pad");
        assert_eq!(n.options, vec!["--save-dev".to_owned()]);
        let p = install_plan("pnpm", &s(&["add", "zod@3.23.8"]));
        assert_eq!(
            p.packages[0],
            Package {
                name: "zod".into(),
                constraint: "3.23.8".into()
            }
        );
        let pip = install_plan(
            "python3",
            &s(&["-m", "pip", "install", "requests>=2.31", "flask==3.0.0"]),
        );
        assert_eq!(pip.manager, "pip");
        assert_eq!(pip.verb, "install");
        assert_eq!(
            pip.packages[0],
            Package {
                name: "requests".into(),
                constraint: ">=2.31".into()
            }
        );
        assert_eq!(
            pip.packages[1],
            Package {
                name: "flask".into(),
                constraint: "==3.0.0".into()
            }
        );
    }

    #[test]
    fn deletion_words_are_classified_in_direct_and_wrapped_forms() {
        use OpClass::*;
        assert_eq!(classify(&a("rm", &["notes.txt"])), Delete);
        assert_eq!(classify(&a("rm", &["-rf", "legacy"])), BulkDelete);
        assert_eq!(classify(&a("rm", &["-r", "legacy"])), BulkDelete);
        assert_eq!(
            classify(&a("rm", &["-rf", "build"])),
            Safe,
            "regenerable output"
        );
        assert_eq!(classify(&a("rm", &["*.tmp"])), BulkDelete);
        assert_eq!(
            classify(&a("find", &[".", "-name", "*.o", "-delete"])),
            BulkDelete
        );
        assert_eq!(classify(&a("git", &["clean", "-fdx"])), BulkDelete);
        assert_eq!(classify(&a("git", &["reset", "--hard"])), BulkDelete);
        assert_eq!(classify(&a("git", &["status"])), Safe);
        assert_eq!(
            classify(&a("sh", &["-c", "echo hi && rm -rf src/old"])),
            BulkDelete
        );
        assert_eq!(
            classify(&a("sh", &["-c", "echo hi && rm -rf target"])),
            Safe,
            "regenerable build output"
        );
        assert_eq!(classify(&a("bash", &["-c", "cd src; rm old.txt"])), Delete);
        assert_eq!(
            classify(&a("sh", &["-c", "echo rm is a word; ls"])),
            Delete,
            "a bare `rm` token in a script is treated as one (fail toward asking)"
        );
        assert_eq!(classify(&a("sh", &["-c", "echo hello"])), Safe);
        assert_eq!(classify(&a("ls", &["-la"])), Safe);
        // the sandbox's scratch space and regenerable output are not a decision for the person
        assert_eq!(classify(&a("rm", &["-f", "/tmp/smoke.db"])), Safe);
        assert_eq!(classify(&a("rm", &["-rf", "node_modules"])), Safe);
        assert_eq!(
            classify(&a("rm", &["-rf", "../target"])),
            BulkDelete,
            "no escaping through .."
        );
        assert_eq!(classify(&a("rm", &["-rf", "/work/src"])), BulkDelete);
        assert_eq!(
            classify(&a("rm", &["-f", "/tmp/a.db", "notes.txt"])),
            Delete,
            "one real file among scratch"
        );
        let live = "cargo build && rm -f /tmp/smoke.db && ./target/debug/todo --db /tmp/smoke.db add \"Buy milk\" && ./target/debug/todo list";
        assert_eq!(
            classify(&a("sh", &["-c", live])),
            Safe,
            "the command that prompted 15 times in the live run"
        );
        assert_eq!(
            classify(&a("sh", &["-c", "cd src; rm -f /tmp/x && rm notes.txt"])),
            Delete
        );
        assert_eq!(classify(&a("cat", &["notes.txt"])), Safe);
    }

    #[test]
    fn wrapping_an_install_in_a_shell_is_not_an_install_class_and_gets_no_network() {
        // the resolver gives the install network ONLY to the direct package-manager form
        assert!(matches!(
            classify(&a("sh", &["-c", "npm install left-pad"])),
            OpClass::Safe
        ));
        assert!(matches!(
            classify(&a("bash", &["-c", "cargo add clap"])),
            OpClass::Safe
        ));
    }
}
