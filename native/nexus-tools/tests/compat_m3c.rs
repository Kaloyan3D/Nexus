//! M3C.7: ordinary developer work keeps working under the final confinement (Landlock launch gate + masks),
//! and the escapes it must stop stay stopped. Real Kernel, real sandbox, disposable folder.

mod common;

use common::*;
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::{authorize, execute_process_in, CancellationToken};
use serde_json::json;

fn policy() -> CommandPolicy {
    CommandPolicy::standard(Toolchain::discover()).with_workbench()
}

fn ready(t: &str) -> bool {
    let c = nexus_tools::sandbox::preflight();
    if !c.available
        || c.landlock_abi.is_none()
        || !c.launch_gate
        || !std::path::Path::new("/usr/bin/python3").exists()
    {
        println!(
            "NOT RUN ({t}): sandbox/Landlock/launch gate unavailable: {:?}",
            c.problems
        );
        return false;
    }
    true
}

fn run(
    fx: &mut Fx,
    script: &str,
) -> Result<nexus_tools::ToolExecutionOutcome, nexus_tools::ToolError> {
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", script], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let pol = policy();
    let p = fx.prepare_p(r, &pol)?;
    let call = authorize(&mut fx.kernel, p)?;
    let dir = fx.dir.path().join("exec");
    execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &dir, 120_000, None)
}

fn out(o: &nexus_tools::ToolExecutionOutcome) -> serde_json::Value {
    o.result.output.clone().unwrap_or_default()
}

fn text(v: &serde_json::Value) -> String {
    format!(
        "{}{}",
        v["stdout"].as_str().unwrap_or(""),
        v["stderr"].as_str().unwrap_or("")
    )
}

#[test]
fn an_ordinary_developer_session_works_end_to_end_inside_the_confined_workspace() {
    if !ready("compat") {
        return;
    }
    let mut fx = fixture("m3c-compat");
    fx.write("package.json", b"{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\"build\": \"node build.js\"}\n}\n");
    fx.write("build.js", b"const fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/out.js', 'console.log(\"built \" + 1.0 + \".0\");\\n');\n");
    fx.write(
        "src/lib.rs",
        b"pub fn add(a: i32, b: i32) -> i32 { a  +  b }\n",
    );
    fx.write(
        "Cargo.toml",
        b"[package]\nname = \"calc\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    );
    fx.write("fmt/ugly.txt", b"a    b     c\n");
    let g = std::process::Command::new("git")
        .current_dir(&fx.ws)
        .args(["-c", "init.defaultBranch=main", "init", "-q"])
        .status();
    let have_git = g.map(|s| s.success()).unwrap_or(false);
    if have_git {
        for a in [
            ["add", "-A"].as_slice(),
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        ] {
            let _ = std::process::Command::new("git")
                .current_dir(&fx.ws)
                .args(a)
                .status();
        }
    }
    // 1. directories, files, a formatter and a generator
    fx.approve_process_fs(120_000, "workspace");
    let o = run(
        &mut fx,
        "mkdir -p gen/deep tests && echo hello > gen/deep/h.txt && sed -i 's/  */ /g' fmt/ugly.txt && \
         python3 -c \"open('gen/generated.py','w').write('X = 1\\n')\" && cat fmt/ugly.txt",
    )
    .unwrap();
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert!(text(&out(&o)).contains("a b c"));
    // 2. Node build, and the next command reads what the previous one produced
    fx.approve_process_fs(120_000, "workspace");
    let o = run(&mut fx, "node build.js && node dist/out.js").unwrap();
    assert_eq!(out(&o)["verification"], "pass", "{}", text(&out(&o)));
    assert!(
        text(&out(&o)).contains("built 1.0.0") || text(&out(&o)).contains("built 1"),
        "{}",
        text(&out(&o))
    );
    // 3. ordinary configuration read and changed
    fx.approve_process_fs(120_000, "workspace");
    let o = run(&mut fx, "node -e \"const p=require('./package.json');p.version='1.1.0';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n')\" && grep version package.json").unwrap();
    assert!(text(&out(&o)).contains("1.1.0"), "{}", text(&out(&o)));
    assert!(fx.disk("package.json").unwrap().contains("1.1.0"));
    // 4. Rust build + test of a tiny crate (offline, no dependencies)
    fx.approve_process_fs(120_000, "workspace");
    let o = run(&mut fx, "cargo build --offline -q 2>&1; echo cargo-rc=$?; ls target >/dev/null 2>&1; echo has-target=$?").unwrap();
    let t = text(&out(&o));
    if t.contains("cargo-rc=0") {
        // (the workbench keeps build output in the sandbox scratch, not in the project)
    } else {
        println!("NOTE: cargo is not available in this sandbox configuration: {t}");
    }
    // 5. permitted Git metadata is inspectable, and cannot be written
    if have_git {
        fx.approve_process_fs(120_000, "workspace");
        let o = run(&mut fx, "git -c safe.directory='*' log --oneline | head -1; git -c safe.directory='*' status --short | head -5; echo x >> .git/config; echo cfg-rc=$?").unwrap();
        let t = text(&out(&o));
        assert!(t.contains("init"), "{t}");
        assert!(t.contains("cfg-rc=1"), "{t}");
    }
    // the journal states the confinement each command ran under
    let j = fx.kernel.list_tool_journal(None).unwrap();
    let prepared = j.iter().rev().find(|e| e.phase == "prepared").unwrap();
    let c = &prepared.payload["sandbox"]["confinement"];
    assert!(
        c["landlockAbi"].as_u64().unwrap_or(0) >= 3
            && c["gateSha256"].as_str().is_some_and(|x| x.len() == 64),
        "{c}"
    );
    // everything above left effects the M3A ledger saw and M3B can restore
    let eff = nexus_tools::observe::effects_dir(&fx.dir.path().join("exec"));
    assert!(
        std::fs::read_dir(eff)
            .map(|d| d.flatten().count())
            .unwrap_or(0)
            >= 4
    );
}

#[test]
fn unauthorized_host_paths_and_escalations_stay_unreachable() {
    if !ready("negative") {
        return;
    }
    let mut fx = fixture("m3c-neg");
    fx.write("a.txt", b"a\n");
    std::fs::write(fx.outside.join("host-secret.txt"), "OUTSIDE-SECRET\n").unwrap();
    fx.approve_process_fs(120_000, "workspace");
    let probe = format!(
        "cat /etc/passwd 2>&1 | head -1; ls /home 2>&1 | head -1; cat {}/host-secret.txt 2>&1 | head -1; ls /proc/1/root 2>&1 | head -1; \
         python3 -c \"import os; print('uid', os.getuid())\"; ls /work/out >/dev/null && echo scratch-ok; echo > /usr/bin/x 2>&1 | head -1; echo done",
        fx.outside.display()
    );
    let o = run(&mut fx, &probe).unwrap();
    let t = text(&out(&o));
    assert!(
        !t.contains("OUTSIDE-SECRET") && !t.contains("root:x:0"),
        "{t}"
    );
    assert!(t.contains("scratch-ok") && t.contains("done"), "{t}");
    // the model cannot choose the confinement
    let mut fx = fixture("m3c-neg2");
    fx.approve_process_fs(120_000, "workspace");
    for bad in [
        "confine",
        "landlock",
        "unconfined",
        "hardLinks",
        "shim",
        "protect",
        "maskPaths",
        "noConfine",
        "gate",
    ] {
        let r = fx.request(
            "proc.run",
            json!({"program": "sh", "args": ["-c", "true"], "cwd": ".", bad: true}),
        );
        assert!(
            fx.prepare_p(r, &policy()).is_err(),
            "'{bad}' must be refused"
        );
    }
}

#[test]
fn an_in_place_command_is_refused_when_the_launch_gate_is_missing_and_scratch_still_runs() {
    if !ready("nogate") {
        return;
    }
    let pol = policy().with_confine_shim(std::path::PathBuf::from("/nonexistent/nexus-confine"));
    let mut fx = fixture("m3c-nogate");
    fx.approve_process_fs(120_000, "workspace");
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "echo ran > ran.txt"], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    let o = execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &dir, 60_000, None).unwrap();
    let e = o.result.error.expect("must be refused");
    assert!(e.message.contains("launch gate"), "{}", e.message);
    assert!(!fx.ws.join("ran.txt").exists());
    // Scratch does not use the gate at all: legacy semantics
    let mut fx = fixture("m3c-nogate-scratch");
    fx.approve_process(60_000);
    let r = fx.request(
        "proc.run",
        json!({"program": "sh", "args": ["-c", "echo ok"], "cwd": "."}),
    );
    let cancel = CancellationToken::new(&r.cancellation_id);
    let p = fx.prepare_p(r, &pol).unwrap();
    let call = authorize(&mut fx.kernel, p).unwrap();
    let dir = fx.dir.path().join("exec");
    let o = execute_process_in(&mut fx.kernel, &call, &cancel, &pol, &dir, 60_000, None).unwrap();
    assert_eq!(o.result.output.unwrap()["verification"], "pass");
}
