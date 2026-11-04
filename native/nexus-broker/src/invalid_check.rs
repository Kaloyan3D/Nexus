//! A verification command that never examined the project.
//!
//! The live case: `node --check <(python3 -c "...")`. Process substitution hands the checker a path such as
//! `/proc/5/fd/pipe:[42337]`; `node --check` reads its input with `readFileSync(path)`, which cannot open a
//! pipe, so it dies with ENOENT before it looks at one byte of the project. The command failed, but the project
//! did not: nothing was checked.
//!
//! Rules this module keeps:
//!
//! * The failure is NEVER erased. It stays in the run's receipts, still counts as an unresolved failed check
//!   (so completion stays `failing-checks` and automatic writeback stays closed) and is only *labelled*
//!   `invalid-invocation`, so that it is not mistaken for a defect of the project.
//! * It is resolved only by a replacement the CONTROLLER wrote: [`recheck_args`] rebuilds the equivalent check
//!   from the original's own producer command (the text inside `<( ... )`) and the same checker, with the
//!   producer's output delivered through a regular temporary file. The model is told to run exactly that
//!   command; only a byte-identical `proc_run` that then passes resolves the original. A different check the
//!   model wrote itself, or a model's statement that the failure does not matter, resolves nothing.
//! * The classification can only change a label and open that one path to resolution; it can never make a
//!   failing check count as passed. Spoofing it (a project test that prints the same words) gains nothing,
//!   because resolution still needs the controller's replacement to pass.

use serde_json::{json, Value};

/// What was recognised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// Canonical checker: `node --check` or `python3 -m py_compile`.
    pub checker: &'static str,
    /// The command inside `<( ... )`, verbatim.
    pub producer: String,
    /// File suffix the checker expects.
    pub suffix: &'static str,
}

/// Checkers that only accept a regular file path, with their canonical form and file suffix.
fn checker_of(tokens: &[&str]) -> Option<(&'static str, &'static str)> {
    match tokens {
        ["node", "--check"] | ["node", "-c"] => Some(("node --check", ".js")),
        ["python3", "-m", "py_compile"] | ["python", "-m", "py_compile"] => {
            Some(("python3 -m py_compile", ".py"))
        }
        _ => None,
    }
}

/// The script of a `sh -c` / `bash -c` proc_run, if it is one.
fn script_of(args: &Value) -> Option<String> {
    let prog = args.get("program")?.as_str()?;
    if !matches!(prog, "sh" | "bash" | "zsh" | "dash") {
        return None;
    }
    let argv: Vec<&str> = args
        .get("args")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let i = argv.iter().position(|a| *a == "-c" || *a == "-lc")?;
    argv.get(i + 1).map(|s| (*s).to_owned())
}

/// The text of the first balanced `( ... )` group that starts right after byte `open` (the byte after `<(`).
fn balanced_group(s: &str, from: usize) -> Option<String> {
    let bytes = s.as_bytes();
    let (mut depth, mut i, mut quote) = (1i32, from, None::<u8>);
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == b'\\' && q == b'"' {
                    i += 1;
                } else if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'\\' => i += 1,
                b'\'' | b'"' => quote = Some(c),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(s[from..i].to_owned());
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// The tokens of the command that precedes position `at` in its own pipeline segment.
fn checker_tokens_before(s: &str, at: usize) -> Vec<&str> {
    let head = &s[..at];
    let start = head.rfind([';', '\n', '|', '&', '(']).map_or(0, |i| i + 1);
    head[start..].split_whitespace().collect()
}

/// Recognise "a file-only checker was given a process substitution and could not open it". `stderr` is the
/// process's own error output from the Kernel receipt; the command is the model's.
pub fn detect(args: &Value, exit_code: Option<i64>, stderr: &str) -> Option<Detected> {
    if exit_code.unwrap_or(0) == 0 {
        return None;
    }
    // the fingerprint of "opened a pipe by path": ENOENT on /proc/<pid>/fd/pipe:[inode] (or /dev/fd/N)
    let pipe_open_failure = (stderr.contains("ENOENT")
        || stderr.contains("No such file or directory"))
        && (stderr.contains("/fd/pipe:[")
            || stderr.contains("/fd/socket:[")
            || stderr.contains("/dev/fd/"));
    if !pipe_open_failure {
        return None;
    }
    let script = script_of(args)?;
    let at = script.find("<(")?;
    if script[at + 2..].contains("<(") {
        // more than one substitution: not reconstructable with certainty
        return None;
    }
    let (checker, suffix) = checker_of(&checker_tokens_before(&script, at))?;
    let producer = balanced_group(&script, at + 2)?;
    if producer.trim().is_empty() || producer.len() > 6_000 {
        return None;
    }
    Some(Detected {
        checker,
        producer,
        suffix,
    })
}

/// The controller-authored equivalent: the producer's output goes to a regular file, then the same checker
/// runs on that file. `cwd` is copied from the original so the producer sees the same directory.
pub fn recheck_args(d: &Detected, original: &Value) -> Value {
    let script = format!(
        "set -e; t=$(mktemp --suffix={suffix}); ( {producer} ) > \"$t\"; {checker} \"$t\" && echo \"syntax check passed: $(wc -c < \"$t\") bytes\"",
        suffix = d.suffix,
        producer = d.producer,
        checker = d.checker,
    );
    let mut v = json!({"program": "sh", "args": ["-c", script]});
    if let Some(cwd) = original.get("cwd").and_then(|c| c.as_str()) {
        if !cwd.is_empty() {
            v["cwd"] = json!(cwd);
        }
    }
    v
}

/// Whether `candidate` is byte-for-byte the command the controller asked for.
pub fn is_exact_recheck(candidate: &Value, expected: &Value) -> bool {
    nexus_contracts::canonical_json(candidate) == nexus_contracts::canonical_json(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STDERR: &str = "node:fs:440\n    return binding.readFileUtf8(path, stringToFlags(options.flag));\n\nError: ENOENT: no such file or directory, open '/proc/5/fd/pipe:[42337]'\n    at Object.readFileSync (node:fs:440:20)\n  path: '/proc/5/fd/pipe:[42337]'\n";

    fn sh(script: &str) -> Value {
        json!({"program": "sh", "args": ["-c", script]})
    }

    #[test]
    fn the_live_failure_is_recognised_with_its_producer_and_checker() {
        let a = sh(
            r#"ls -la; test -f package.json && (npm ci; npm test) || echo "NO package.json"; node --check <(python3 -c "import re,pathlib; print(re.findall(r'<script>(.*?)</script>', pathlib.Path('index.html').read_text())[0])") && echo "JS SYNTAX OK""#,
        );
        let d = detect(&a, Some(1), STDERR).expect("detected");
        assert_eq!(d.checker, "node --check");
        assert_eq!(d.suffix, ".js");
        assert!(
            d.producer.starts_with("python3 -c \"import re,pathlib;"),
            "{}",
            d.producer
        );
        assert!(d.producer.ends_with("[0])\""), "{}", d.producer);
    }

    #[test]
    fn a_real_project_failure_is_never_reclassified() {
        let a = sh("node --check <(echo 'let = ;')");
        // a genuine syntax error: exit 1, a SyntaxError on stderr, no pipe-open failure
        assert!(detect(&a, Some(1), "SyntaxError: Unexpected token '='\n").is_none());
        // the pipe fingerprint without a process substitution in the command
        assert!(detect(&sh("node --check app.js"), Some(1), STDERR).is_none());
        // a success is never a defect
        assert!(detect(&a, Some(0), STDERR).is_none());
        // a program that is not a file-only checker
        assert!(detect(&sh("grep foo <(echo foo)"), Some(1), STDERR).is_none());
        // two substitutions: not reconstructable
        assert!(detect(&sh("node --check <(echo a) <(echo b)"), Some(1), STDERR).is_none());
        // not a shell command at all
        assert!(detect(
            &json!({"program": "node", "args": ["--check", "/dev/fd/3"]}),
            Some(1),
            STDERR
        )
        .is_none());
    }

    #[test]
    fn the_replacement_is_the_same_producer_through_a_regular_file() {
        let a = json!({"program": "sh", "args": ["-c", "node --check <(python3 -c \"print('let x = 1')\")"], "cwd": "site"});
        let d = detect(&a, Some(1), STDERR).unwrap();
        let r = recheck_args(&d, &a);
        let script = r["args"][1].as_str().unwrap();
        assert!(
            script.contains("( python3 -c \"print('let x = 1')\" ) > \"$t\""),
            "{script}"
        );
        assert!(script.contains("mktemp --suffix=.js"));
        assert!(script.contains("node --check \"$t\""));
        assert!(!script.contains("<("));
        assert_eq!(r["cwd"], "site");
        // it is a recognisable verification command (the word `check`)
        assert!(crate::inspect::is_verification_command(&r));
    }

    #[test]
    fn only_the_exact_controller_command_counts_as_the_replacement() {
        let a = sh("node --check <(echo 'let x = 1')");
        let d = detect(&a, Some(1), STDERR).unwrap();
        let want = recheck_args(&d, &a);
        assert!(is_exact_recheck(&want.clone(), &want));
        let mut other = want.clone();
        other["args"][1] = json!("node --check /tmp/check.js");
        assert!(!is_exact_recheck(&other, &want));
        let mut tweaked = want.clone();
        let s = tweaked["args"][1].as_str().unwrap().replace("set -e;", "");
        tweaked["args"][1] = json!(s);
        assert!(!is_exact_recheck(&tweaked, &want));
    }

    #[test]
    fn the_python_checker_is_supported_and_quotes_inside_the_producer_survive() {
        let a = sh("python3 -m py_compile <(printf '%s' \"x = (1, 2)\")");
        let d = detect(
            &a,
            Some(1),
            "FileNotFoundError: [Errno 2] ENOENT open '/dev/fd/63'",
        )
        .unwrap();
        assert_eq!(d.checker, "python3 -m py_compile");
        assert_eq!(d.producer, "printf '%s' \"x = (1, 2)\"");
    }
}
