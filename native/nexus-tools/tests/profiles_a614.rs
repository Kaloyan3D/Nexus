//! A6.1.4 P6: execution profiles for Python and Node through the REAL Kernel and sandbox.
//! Prints `NOT RUN` and returns when the host lacks the sandbox or the toolchain.

mod common;

use common::*;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process, CancellationToken};
use serde_json::json;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover())
}

fn have(p: &str) -> bool {
    std::path::Path::new(p).exists()
}

fn ready(t: &str, bins: &[&str]) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available || bins.iter().any(|b| !have(b)) {
        println!(
            "NOT RUN ({t}): sandbox or toolchain unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

fn run(
    fx: &mut Fx,
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
    let o = execute_process(&mut fx.kernel, &call, &cancel, &pol, &run, 600_000)?;
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
fn python_unittest_runs_in_the_sandbox_and_reports_real_pass_and_fail() {
    if !ready("py", &["/usr/bin/python3"]) {
        return;
    }
    let mut fx = fixture("py-prof");
    fx.approve_process(60_000);
    fx.write("calc.py", b"def add(a, b):\n    return a + b\n");
    fx.write("test_calc.py", b"import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n");
    let v = run(&mut fx, "python3", &["-m", "unittest", "discover"]).expect("runs");
    assert_eq!(
        (v["verification"].as_str(), v["exitCode"].as_i64()),
        (Some("pass"), Some(0)),
        "{}",
        out(&v)
    );
    assert!(out(&v).contains("OK"), "{}", out(&v));
    assert_eq!(v["network"], "none");
    // a failing test is a real, honest failure with the assertion in the output
    fx.write("calc.py", b"def add(a, b):\n    return a - b\n");
    let mut fx2 = fixture("py-prof2");
    fx2.approve_process(60_000);
    fx2.write("calc.py", b"def add(a, b):\n    return a - b\n");
    fx2.write("test_calc.py", b"import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n");
    let v = run(&mut fx2, "python3", &["-m", "unittest", "discover"]).expect("runs");
    assert_eq!(v["verification"], "fail", "{}", out(&v));
    assert!(
        out(&v).contains("AssertionError") && out(&v).contains("-1 != 5"),
        "{}",
        out(&v)
    );
    // the project stays untouched: no bytecode or caches were written into the workspace
    assert!(!fx2.ws.join("__pycache__").exists());
    // no network from inside
    let mut fx3 = fixture("py-prof3");
    fx3.approve_process(60_000);
    fx3.write("test_net.py", b"import unittest, socket\n\nclass T(unittest.TestCase):\n    def test_net(self):\n        with self.assertRaises(OSError):\n            socket.create_connection((\"93.184.216.34\", 80), timeout=2)\n");
    let v = run(&mut fx3, "python3", &["-m", "unittest", "discover"]).expect("runs");
    assert_eq!(
        v["verification"],
        "pass",
        "the sandbox has no network: {}",
        out(&v)
    );
}

#[test]
fn node_builtin_test_runner_runs_in_the_sandbox() {
    if !ready("node", &["/usr/bin/node"]) {
        return;
    }
    let mut fx = fixture("node-prof");
    fx.approve_process(60_000);
    fx.write("sum.js", b"exports.sum = (a, b) => a + b;\n");
    fx.write("sum.test.js", b"const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sum', () => { assert.strictEqual(sum(2, 3), 5); });\n");
    let v = run(&mut fx, "node", &["--test"]).expect("runs");
    assert_eq!(
        (v["verification"].as_str(), v["exitCode"].as_i64()),
        (Some("pass"), Some(0)),
        "{}",
        out(&v)
    );
    let mut fx2 = fixture("node-prof2");
    fx2.approve_process(60_000);
    fx2.write("sum.js", b"exports.sum = (a, b) => a - b;\n");
    fx2.write("sum.test.js", b"const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sum', () => { assert.strictEqual(sum(2, 3), 5); });\n");
    let v = run(&mut fx2, "node", &["--test"]).expect("runs");
    assert_eq!(v["verification"], "fail", "{}", out(&v));
}

#[test]
fn the_new_profiles_accept_only_test_forms_never_scripts_eval_or_other_modules() {
    let pol = policy();
    let bad = |program: &str, args: &[&str]| {
        let a = nexus_tools::ProcessArgs {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".into(),
        };
        pol.resolve(&a).is_err()
    };
    for args in [
        &["-c", "print(1)"][..],
        &["script.py"],
        &["-m", "http.server"],
        &["-m", "pip", "install", "x"],
        &["-m", "venv", "v"],
        &["-m", "unittest", "-c"],
        &["-m", "unittest", "discover", "-s", "/etc"],
        &["-m", "unittest", "discover", "-s", "../x"],
        &["-m", "pytest", "--rootdir=/"],
        &["-m", "pytest", "-p", "evil"],
        &["-m", "compileall", "/"],
        &["-X", "dev", "-m", "unittest"],
        &["-i"],
        &[],
    ] {
        assert!(bad("python3", args), "python3 {args:?} must be refused");
    }
    for args in [
        &["-e", "1"][..],
        &["--eval", "1"],
        &["script.js"],
        &["--test", "--require", "x"],
        &["--test", "/etc/passwd"],
        &["--test", "../x"],
        &["--inspect"],
        &[],
    ] {
        assert!(bad("node", args), "node {args:?} must be refused");
    }
    // and the allowed forms resolve
    let ok = |program: &str, args: &[&str]| {
        pol.resolve(&nexus_tools::ProcessArgs {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: ".".into(),
        })
        .is_ok()
    };
    for args in [
        &["-m", "unittest"][..],
        &["-m", "unittest", "discover"],
        &["-m", "unittest", "discover", "-s", "tests", "-v"],
        &["-m", "unittest", "tests.test_calc"],
        &["-m", "pytest", "-q", "tests"],
        &["-m", "compileall", "-q", "."],
    ] {
        if have("/usr/bin/python3") {
            assert!(ok("python3", args), "python3 {args:?}");
        }
    }
    if have("/usr/bin/node") {
        assert!(ok("node", &["--test"]) && ok("node", &["--test", "test"]));
    }
}
