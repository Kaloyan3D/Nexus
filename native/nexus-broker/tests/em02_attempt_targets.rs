//! EM-02 trusted-interface tests: Registry-authorized per-attempt reasoning.
//!
//! The REAL JS Registry (service, issuer, native-target-v2, native-task-binding via the e2e
//! driver over a fixture data root), the REAL Kernel (in process, durable store + witness) and
//! the REAL request preparation and authorized dispatch of `nexus-model` (mock transport, no
//! network). Two attempts of ONE task are authorized with different efforts while the task's
//! model, provider, route, connection, endpoint and credential stay identical; everything that
//! would change them, cross tasks, replay a binding or tamper with it is refused.

use nexus_contracts::{ControllerIntentV1, RegistryResolutionV1, TaskBindingV1};
use nexus_kernel::{AcceptRequest, Kernel, NativeDispatchRequest, SCOPE_MOCK_E2E};
use nexus_model::testkit::{self, MockScript, MockTransport};
use nexus_model::*;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

const ORIGIN: &str = "http://127.0.0.1:9";
const CRED_REF: &str = "credential://connections/conn-e2e-mock";
const SECRET: &str = "sk-test-em02-marker";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn driver(args: &[&str], stdin: Option<&Value>) -> Value {
    let mut cmd = Command::new("node");
    cmd.arg(repo_root().join("native/nexus-daemon/tests/e2e/driver.cjs"))
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().expect("node");
    if let Some(v) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(v.to_string().as_bytes())
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.lines().last().unwrap_or("{}")).expect("one JSON line")
}

/// A fixture Registry whose main route declares `levels` (fixture capability data) AND whose
/// operator authorized exactly those levels for the main slot (controlled fixture policy).
fn registry(levels: &[&str]) -> tempfile::TempDir {
    let dir = registry_route_only(levels);
    let r = slot_policy(dir.path(), Some(levels));
    assert_eq!(r["ok"], true, "{r}");
    dir
}

/// The route declares `levels`; the operator configured NO slot reasoning policy.
fn registry_route_only(levels: &[&str]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_str().unwrap();
    let root = repo_root();
    let root = root.to_str().unwrap();
    assert_eq!(driver(&["registry", data, root, "9"], None)["ok"], true);
    let levels = serde_json::to_string(levels).unwrap();
    let r = driver(
        &["registry-levels", data, root, "e2e-mock/e2e-1", &levels],
        None,
    );
    assert_eq!(r["ok"], true, "{r}");
    dir
}

/// Save (or with `None` remove) the operator's reasoning policy of the main slot.
fn slot_policy(data: &Path, levels: Option<&[&str]>) -> Value {
    let arg = levels.map_or("none".to_owned(), |l| serde_json::to_string(l).unwrap());
    let root = repo_root();
    driver(
        &[
            "registry-slot-policy",
            data.to_str().unwrap(),
            root.to_str().unwrap(),
            &arg,
        ],
        None,
    )
}

fn issue(data: &Path, task: &str) -> Value {
    let root = repo_root();
    let v = driver(
        &[
            "issue",
            root.to_str().unwrap(),
            data.to_str().unwrap(),
            task,
            &format!("session-{task}"),
        ],
        None,
    );
    assert_eq!(v["ok"], true, "{v}");
    v
}

fn issue_attempt(issued: &Value, effort: &str) -> Value {
    driver(
        &["issue-attempt"],
        Some(&json!({
            "taskBinding": issued["taskBinding"],
            "taskBindingDigest": issued["taskBindingDigest"],
            "resolution": issued["resolution"],
            "extension": issued["extension"],
            "requestedEffort": effort,
        })),
    )
}

fn typed(resolution: &Value) -> RegistryResolutionV1 {
    serde_json::from_value(resolution.clone()).unwrap()
}

struct Task {
    kernel: Kernel,
    dir: tempfile::TempDir,
    task: String,
    epoch: u64,
    incarnation: String,
    snapshot: Value,
}

fn open_kernel(dir: &Path) -> Kernel {
    Kernel::open(&dir.join("k.db"), Some(&dir.join("k.wit.db"))).expect("kernel")
}

/// A task generation with its own issuance, extension and (optionally) binding sealed.
fn task(issued: &Value, bind: bool) -> Task {
    let dir = tempfile::tempdir().unwrap();
    let mut kernel = open_kernel(dir.path());
    let resolution = typed(&issued["resolution"]);
    let task = resolution.task_instance_id.clone();
    kernel.seal_issuance(&resolution).expect("seal issuance");
    let ext_digest = kernel
        .seal_extension(&issued["extension"])
        .expect("seal ext");
    assert_eq!(ext_digest, issued["extensionDigest"].as_str().unwrap());
    if bind {
        let d = kernel
            .seal_task_binding(
                &issued["taskBinding"],
                &resolution.provenance.issuance_id,
                &ext_digest,
            )
            .expect("seal binding");
        assert_eq!(d, issued["taskBindingDigest"].as_str().unwrap());
    }
    let lease = kernel.acquire_generation(&task, "native").expect("lease");
    Task {
        kernel,
        dir,
        task,
        epoch: lease.lease_epoch,
        incarnation: lease.store_incarnation,
        snapshot: issued["snapshot"].clone(),
    }
}

/// One attempt through the Kernel: accept, publish, authorize; then prepare and send the request
/// through the authorized dispatch. Returns the request body that was sent.
fn run_attempt(
    t: &mut Task,
    n: u32,
    resolution: &Value,
    extension: &Value,
) -> Result<Value, String> {
    let issued = typed(resolution);
    let attempt = format!("{}-A{n}", t.task);
    let command = format!("cmd-{}-{n}", t.task);
    let intent = ControllerIntentV1::build(
        &t.task,
        &attempt,
        &command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        issued.target.mode_config_revision.clone(),
        json!({"op": "engineer-turn"}),
    )
    .with_lease(t.epoch, &t.incarnation);
    t.kernel
        .accept_command(&AcceptRequest {
            intent,
            issued: issued.clone(),
            snapshot: t.snapshot.clone(),
        })
        .map_err(|e| format!("accept: {} {}", e.code.as_str(), e.message))?;
    let target = ExecutionTargetV2::from_extension_json(issued.target.clone(), extension)
        .map_err(|e| format!("target: {e}"))?;
    let pin = VerifiedExecutionPin::bind(
        &t.task,
        &command,
        &attempt,
        t.epoch,
        &t.incarnation,
        &issued,
        &t.snapshot,
        &target,
        "em02-command-digest",
    )
    .map_err(|e| format!("pin: {e}"))?;
    let transport = MockTransport::new(
        MockScript::CleanStream {
            body: testkit::load_fixture("basic-text").sse_body,
        },
        SECRET,
    );
    let runtime = OfflineModelRuntime::new(
        transport,
        TransportBinding::new(ORIGIN),
        TransportLimits::default(),
    );
    let prepared = runtime
        .prepare(
            &pin,
            &issued,
            &t.snapshot,
            &target,
            &ModelRequest::text_only("user", "hi"),
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let attested = runtime
        .attest(&pin, &issued, &t.snapshot, &target, prepared)
        .map_err(|e| format!("attest: {e}"))?;
    let ext_digest = t
        .kernel
        .seal_extension(extension)
        .map_err(|e| format!("seal ext: {}", e.message))?;
    let bundle = json!({
        "commandId": command, "taskInstanceId": t.task, "attemptId": attempt,
        "leaseEpoch": t.epoch, "storeIncarnation": t.incarnation, "role": "muse_main",
        "targetDigest": issued.provenance.target_digest,
        "snapshotDigest": issued.provenance.registry_snapshot_digest,
        "issuanceId": issued.provenance.issuance_id, "extensionDigest": ext_digest,
        "requestDigest": attested.prepared().request_digest, "sessionId": "session-em02",
        "scope": SCOPE_MOCK_E2E,
    });
    t.kernel
        .publish_intent(&bundle)
        .map_err(|e| format!("publish: {} {}", e.code.as_str(), e.message))?;
    let grant = t
        .kernel
        .authorize_sealed_dispatch(&NativeDispatchRequest {
            command_id: command.clone(),
            request_digest: attested.prepared().request_digest.clone(),
            scope: SCOPE_MOCK_E2E.to_owned(),
            endpoint_origin: ORIGIN.to_owned(),
            credential_ref: CRED_REF.to_owned(),
        })
        .map_err(|e| format!("authorize: {} {}", e.code.as_str(), e.message))?;
    let sender = MockTransport::new(
        MockScript::CleanStream {
            body: testkit::load_fixture("basic-text").sse_body,
        },
        SECRET,
    );
    let mut tracker = AttemptTracker::new(&attempt);
    let mut store = AttemptStore::new();
    dispatch_authorized(
        &sender,
        &mut t.kernel,
        &grant,
        &attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut tracker,
        &mut store,
    )
    .map_err(|e| format!("dispatch: {e:?}"))?;
    assert_eq!(sender.sends(), 1, "exactly one send per attempt");
    Ok(serde_json::from_slice(&attested.prepared().request_bytes).unwrap())
}

fn binding_of(issued: &Value) -> TaskBindingV1 {
    serde_json::from_value(issued["taskBinding"].clone()).unwrap()
}

/// The positive case and its invariants: two attempts of one task, two supported efforts,
/// one immutable binding.
#[test]
fn two_attempts_of_one_task_execute_different_authorized_efforts_on_the_same_bound_target() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-a");
    let b = binding_of(&issued);
    assert_eq!(
        b.default_reasoning, "low",
        "the configured default is unchanged"
    );
    assert_eq!(b.supported_reasoning, vec!["high", "low"]);
    let high = issue_attempt(&issued, "high");
    assert_eq!(high["ok"], true, "{high}");
    assert_eq!(high["effort"], "high");
    // the default effort is the task's own issuance, unchanged (content-addressed)
    let low = issue_attempt(&issued, "low");
    assert_eq!(low["issuanceId"], issued["issuanceId"]);
    assert_eq!(low["extensionDigest"], issued["extensionDigest"]);
    assert_ne!(high["issuanceId"], issued["issuanceId"]);
    // re-issuing the same effort yields the same target (no second authority, no mutation)
    assert_eq!(
        issue_attempt(&issued, "high")["issuanceId"],
        high["issuanceId"]
    );

    let mut t = task(&issued, true);
    t.kernel.seal_issuance(&typed(&high["resolution"])).unwrap();
    let body1 = run_attempt(&mut t, 1, &issued["resolution"], &issued["extension"]).unwrap();
    let body2 = run_attempt(&mut t, 2, &high["resolution"], &high["extension"]).unwrap();
    assert_eq!(body1["reasoning"]["effort"], "low");
    assert_eq!(body2["reasoning"]["effort"], "high");
    // identical model / everything else in the request
    let mut b2 = body2.clone();
    b2["reasoning"]["effort"] = "low".into();
    assert_eq!(body1, b2, "only the effort differs");
    // identical bound identities
    let (r1, r2) = (typed(&issued["resolution"]), typed(&high["resolution"]));
    for (a, b) in [
        (&r1.target.provider_id, &r2.target.provider_id),
        (&r1.target.remote_model_id, &r2.target.remote_model_id),
        (&r1.target.logical_model_id, &r2.target.logical_model_id),
        (&r1.target.route_id, &r2.target.route_id),
        (&r1.target.connection_id, &r2.target.connection_id),
        (&r1.target.mode_id, &r2.target.mode_id),
        (
            &r1.target.orchestration_engine_id,
            &r2.target.orchestration_engine_id,
        ),
    ] {
        assert_eq!(a, b);
    }
    for k in [
        "endpoint",
        "credentialRef",
        "connectionBinding",
        "session",
        "outputLimitTokens",
    ] {
        assert_eq!(issued["extension"][k], high["extension"][k], "{k}");
    }
    // the binding the Kernel holds is still the original
    let again = t
        .kernel
        .seal_task_binding(
            &issued["taskBinding"],
            &r1.provenance.issuance_id,
            issued["extensionDigest"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(again, issued["taskBindingDigest"].as_str().unwrap());
}

/// Rewrite a target field and re-derive every digest: a self-consistent issuance the Registry
/// never authorized (what a compromised caller could present).
fn forged(resolution: &Value, field: &str, value: &str) -> Value {
    let mut r = typed(resolution);
    let mut t = serde_json::to_value(&r.target).unwrap();
    t[field] = value.into();
    r.target = serde_json::from_value(t.clone()).unwrap();
    r.provenance.target_digest = nexus_contracts::target_digest_of(&t);
    r.provenance.issuance_id = r.issuance_id_of();
    serde_json::to_value(r).unwrap()
}

#[test]
fn unsupported_redirecting_cross_task_and_replayed_targets_are_refused() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-b");
    // Registry: an effort the route does not declare, and non-levels
    for e in ["xhigh", "max", "", "low high"] {
        let r = issue_attempt(&issued, e);
        assert_eq!(r["ok"], false, "{e}: {r}");
    }
    // Registry: a binding that does not match its digest, or another task's issuance
    let mut tampered = issued.clone();
    tampered["taskBinding"]["supportedReasoning"] = json!(["high", "low", "xhigh"]);
    let r = issue_attempt(&tampered, "xhigh");
    assert_eq!(r["code"], "registry-binding-invalid", "{r}");
    let other = issue(reg.path(), "task-em02-other");
    let mut cross = issued.clone();
    cross["resolution"] = other["resolution"].clone();
    cross["extension"] = other["extension"].clone();
    assert_eq!(
        issue_attempt(&cross, "high")["code"],
        "registry-binding-mismatch"
    );

    let mut t = task(&issued, true);
    // Kernel: forged targets that change the route, model, provider or connection
    for (field, value) in [
        ("routeId", "e2e-mock/e2e-2"),
        ("remoteModelId", "e2e-mock-model-2"),
        ("logicalModelId", "e2e/e2e-2"),
        ("providerId", "other-provider"),
        ("connectionId", "conn-e2e-mock-b"),
        ("reasoning", "xhigh"),
    ] {
        let f = forged(&issued["resolution"], field, value);
        if field == "reasoning" {
            // an effort outside the target's own slot policy is refused already at sealing
            let err = t.kernel.seal_issuance(&typed(&f)).unwrap_err();
            assert_eq!(err.code.as_str(), "binding-mismatch", "{}", err.message);
            continue;
        }
        t.kernel.seal_issuance(&typed(&f)).unwrap(); // content-addressed: sealing is not authority
        let ext = issued["extension"].clone();
        let err = run_attempt(&mut t, 10, &f, &ext).unwrap_err();
        assert!(
            err.starts_with("accept: binding-mismatch"),
            "{field}: {err}"
        );
    }
    // Kernel: an extension that changes the endpoint or credential (same core)
    let high = issue_attempt(&issued, "high");
    t.kernel.seal_issuance(&typed(&high["resolution"])).unwrap();
    let mut ext = high["extension"].clone();
    ext["outputLimitTokens"] = json!(64);
    let err = run_attempt(&mut t, 11, &high["resolution"], &ext).unwrap_err();
    assert!(err.starts_with("publish: binding-mismatch"), "{err}");
    // Kernel: another task's attempt target under this task
    let other_high = issue_attempt(&other, "high");
    t.kernel
        .seal_issuance(&typed(&other_high["resolution"]))
        .unwrap();
    let err = run_attempt(
        &mut t,
        12,
        &other_high["resolution"],
        &other_high["extension"],
    )
    .unwrap_err();
    assert!(err.starts_with("accept: generation-mismatch"), "{err}");
    // Kernel: a second, different binding for the same task (stale or forged) is refused
    let mut b = issued["taskBinding"].clone();
    b["supportedReasoning"] = json!(["high", "low", "max"]);
    let err = t
        .kernel
        .seal_task_binding(
            &b,
            &typed(&issued["resolution"]).provenance.issuance_id,
            issued["extensionDigest"].as_str().unwrap(),
        )
        .unwrap_err();
    // refused by derivation from the sealed issuance (a different binding for the same
    // issuance can never be valid); the store's first-writer-wins rule is the second line
    assert_eq!(err.code.as_str(), "binding-mismatch", "{}", err.message);
    // Kernel: a binding that does not describe the sealed task issuance
    let mut wrong = issued["taskBinding"].clone();
    wrong["defaultReasoning"] = "high".into();
    let t2 = tempfile::tempdir().unwrap();
    let mut k2 = open_kernel(t2.path());
    k2.seal_issuance(&typed(&issued["resolution"])).unwrap();
    k2.seal_extension(&issued["extension"]).unwrap();
    assert!(k2
        .seal_task_binding(
            &wrong,
            &typed(&issued["resolution"]).provenance.issuance_id,
            issued["extensionDigest"].as_str().unwrap()
        )
        .is_err());
    // the genuine attempts still run afterwards
    run_attempt(&mut t, 1, &issued["resolution"], &issued["extension"]).unwrap();
    run_attempt(&mut t, 2, &high["resolution"], &high["extension"]).unwrap();
    // a replayed (already executed) attempt is not dispatched again
    let err = run_attempt(&mut t, 2, &high["resolution"], &high["extension"]).unwrap_err();
    assert!(
        !err.starts_with("dispatch"),
        "refused before any send: {err}"
    );
}

/// A Registry configuration change mid-run does not reach a running task (its attempts are
/// authorized from the sealed binding only), and a Kernel restart keeps the binding.
#[test]
fn a_registry_change_mid_run_and_a_kernel_restart_do_not_redirect_the_task() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-c");
    let mut t = task(&issued, true);
    run_attempt(&mut t, 1, &issued["resolution"], &issued["extension"]).unwrap();
    // the operator revokes the slot policy mid-run, then removes "high" from the route
    assert_eq!(slot_policy(reg.path(), None)["ok"], true);
    let root = repo_root();
    let data = reg.path().to_str().unwrap();
    assert_eq!(
        driver(
            &[
                "registry-levels",
                data,
                root.to_str().unwrap(),
                "e2e-mock/e2e-1",
                "[\"low\"]"
            ],
            None
        )["ok"],
        true
    );
    let fresh = issue(reg.path(), "task-em02-c-new");
    assert_eq!(binding_of(&fresh).supported_reasoning, vec!["low"]);
    // the running task's binding is unchanged: its attempts still authorize against it
    let high = issue_attempt(&issued, "high");
    assert_eq!(
        high["ok"], true,
        "the sealed binding is the authority: {high}"
    );
    // ... and nothing can swap the task onto the new issuance's target, even once it is sealed
    t.kernel
        .seal_issuance(&typed(&fresh["resolution"]))
        .unwrap();
    let err = run_attempt(&mut t, 2, &fresh["resolution"], &fresh["extension"]).unwrap_err();
    // refused at accept: another task generation (and, after the policy change, another
    // compiled snapshot, which accept checks first)
    assert!(
        err.starts_with("accept: generation-mismatch")
            || err.starts_with("accept: binding-mismatch"),
        "{err}"
    );
    // Kernel restart: the binding is durable and still enforced
    let Task {
        kernel,
        dir,
        task: name,
        epoch,
        incarnation,
        snapshot,
    } = t;
    drop(kernel);
    let mut t = Task {
        kernel: open_kernel(dir.path()),
        dir,
        task: name,
        epoch,
        incarnation,
        snapshot,
    };
    let f = forged(&issued["resolution"], "routeId", "e2e-mock/e2e-2");
    t.kernel.seal_issuance(&typed(&f)).unwrap();
    let err = run_attempt(&mut t, 3, &f, &issued["extension"]).unwrap_err();
    assert!(err.starts_with("accept: binding-mismatch"), "{err}");
    t.kernel.seal_issuance(&typed(&high["resolution"])).unwrap();
    let body = run_attempt(&mut t, 4, &high["resolution"], &high["extension"]).unwrap();
    assert_eq!(body["reasoning"]["effort"], "high");
}

/// A task without a sealed binding (legacy flows) can never switch issuances; a tampered sealed
/// binding fails closed.
#[test]
fn an_unbound_task_cannot_switch_targets_and_a_tampered_binding_fails_closed() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-d");
    let high = issue_attempt(&issued, "high");
    let mut t = task(&issued, false);
    t.kernel.seal_issuance(&typed(&high["resolution"])).unwrap();
    run_attempt(&mut t, 1, &issued["resolution"], &issued["extension"]).unwrap();
    let err = run_attempt(&mut t, 2, &high["resolution"], &high["extension"]).unwrap_err();
    assert!(err.starts_with("accept: binding-mismatch"), "{err}");
    // the same issuance keeps working (one target per unbound task, as before EM-02)
    run_attempt(&mut t, 3, &issued["resolution"], &issued["extension"]).unwrap();

    // tamper with a sealed binding at rest
    let issued = issue(reg.path(), "task-em02-e");
    let t = task(&issued, true);
    let Task { kernel, dir, .. } = t;
    drop(kernel);
    let db = rusqlite::Connection::open(dir.path().join("k.db")).unwrap();
    let n = db
        .execute(
            "UPDATE task_bindings SET binding_json = replace(binding_json, '\"high\"', '\"max\"')",
            [],
        )
        .unwrap();
    assert_eq!(n, 1);
    drop(db);
    let mut k = open_kernel(dir.path());
    let lease = k.acquire_generation("task-em02-e", "native").unwrap();
    let mut t = Task {
        kernel: k,
        dir,
        task: "task-em02-e".into(),
        epoch: lease.lease_epoch,
        incarnation: lease.store_incarnation,
        snapshot: issued["snapshot"].clone(),
    };
    let err = run_attempt(&mut t, 1, &issued["resolution"], &issued["extension"]).unwrap_err();
    assert!(err.starts_with("accept: store-corrupt"), "{err}");
}

/// Offline cost of authorizing a non-default effort (one Registry bridge call + two Kernel
/// seals); the default effort costs nothing (no call). Measured, not asserted.
#[test]
fn per_attempt_authorization_cost_is_measured() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-perf");
    let mut bridge_ms = Vec::new();
    for _ in 0..15 {
        let s = Instant::now();
        assert_eq!(issue_attempt(&issued, "high")["ok"], true);
        bridge_ms.push(s.elapsed().as_secs_f64() * 1000.0);
    }
    let high = issue_attempt(&issued, "high");
    let dir = tempfile::tempdir().unwrap();
    let mut k = open_kernel(dir.path());
    let mut seal_ms = Vec::new();
    for _ in 0..15 {
        let s = Instant::now();
        k.seal_issuance(&typed(&high["resolution"])).unwrap();
        k.seal_extension(&high["extension"]).unwrap();
        seal_ms.push(s.elapsed().as_secs_f64() * 1000.0);
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    println!(
        "EM02-PERF issue-attempt bridge median {:.1} ms (n=15); kernel seal issuance+extension median {:.2} ms (n=15); pinned default: 0 calls",
        med(&mut bridge_ms),
        med(&mut seal_ms)
    );
}

/// Slot policy: a level the route declares is NOT authorized unless the operator's slot policy
/// authorizes it; without a policy only the configured default runs (non-default disabled).
#[test]
fn a_route_level_outside_the_slot_policy_is_never_authorized() {
    let reg = registry_route_only(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-slot");
    assert!(issued["resolution"]["target"]
        .get("allowedReasoning")
        .is_none());
    assert_eq!(binding_of(&issued).supported_reasoning, vec!["low"]);
    // Registry: refuses "high" although the route declares it
    let r = issue_attempt(&issued, "high");
    assert_eq!(r["code"], "reasoning-level-not-supported", "{r}");
    // Kernel: a forged "high" attempt target is refused for the bound task
    let mut t = task(&issued, true);
    let f = forged(&issued["resolution"], "reasoning", "high");
    t.kernel.seal_issuance(&typed(&f)).unwrap();
    let mut ext = issued["extension"].clone();
    ext["reasoningEffort"] = "high".into();
    let err = run_attempt(&mut t, 1, &f, &ext).unwrap_err();
    assert!(err.starts_with("accept: binding-mismatch"), "{err}");
    // the default still runs, unchanged
    run_attempt(&mut t, 2, &issued["resolution"], &issued["extension"]).unwrap();
    // a policy beyond the route, or without the default, cannot even be configured
    let r = slot_policy(reg.path(), Some(&["high", "low", "max"]));
    assert_eq!(r["code"], "reasoning-level-not-supported", "{r}");
    let r = slot_policy(reg.path(), Some(&["high"]));
    assert_eq!(r["code"], "slot-assignment-invalid", "{r}");
    // a narrower policy authorizes exactly what it names
    let reg = registry_route_only(&["low", "medium", "high"]);
    assert_eq!(
        slot_policy(reg.path(), Some(&["low", "medium"]))["ok"],
        true
    );
    let issued = issue(reg.path(), "task-em02-slot2");
    assert_eq!(
        binding_of(&issued).supported_reasoning,
        vec!["low", "medium"]
    );
    assert_eq!(issue_attempt(&issued, "medium")["ok"], true);
    assert_eq!(
        issue_attempt(&issued, "high")["code"],
        "reasoning-level-not-supported"
    );
}

fn rebind(issued: &mut Value) {
    let b: TaskBindingV1 = serde_json::from_value(issued["taskBinding"].clone()).unwrap();
    issued["taskBindingDigest"] = b.binding_digest().into();
}

/// Capability provenance BEFORE the binding is sealed: whatever a delivery channel does to the
/// levels after the Registry issued them, the Kernel derives the authorized levels from the
/// sealed issuance itself.
#[test]
fn capability_tampering_before_the_binding_is_sealed_is_refused() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-prov");
    let res = typed(&issued["resolution"]);
    let ext_digest = issued["extensionDigest"].as_str().unwrap().to_owned();
    let fresh_kernel = || {
        let dir = tempfile::tempdir().unwrap();
        let mut k = open_kernel(dir.path());
        k.seal_issuance(&res).unwrap();
        k.seal_extension(&issued["extension"]).unwrap();
        (dir, k)
    };
    // (1) the binding widened (and its digest recomputed) before it is sealed
    let mut widened = issued.clone();
    widened["taskBinding"]["supportedReasoning"] = json!(["high", "low", "max"]);
    rebind(&mut widened);
    let (_d, mut k) = fresh_kernel();
    let err = k
        .seal_task_binding(
            &widened["taskBinding"],
            &res.provenance.issuance_id,
            &ext_digest,
        )
        .unwrap_err();
    assert_eq!(err.code.as_str(), "binding-mismatch", "{}", err.message);
    // ... and the Registry refuses to authorize under it either
    assert_eq!(
        issue_attempt(&widened, "max")["code"],
        "registry-binding-mismatch"
    );
    // (2) the binding narrowed to drop the default, or claiming a policy on a no-policy target
    let mut narrowed = issued.clone();
    narrowed["taskBinding"]["supportedReasoning"] = json!(["high"]);
    rebind(&mut narrowed);
    let (_d, mut k) = fresh_kernel();
    assert!(k
        .seal_task_binding(
            &narrowed["taskBinding"],
            &res.provenance.issuance_id,
            &ext_digest
        )
        .is_err());
    // (3) the issued target's policy widened without re-deriving its digests: the issuance no
    //     longer matches its own id and is refused at sealing
    let mut t = issued["resolution"].clone();
    t["target"]["allowedReasoning"] = json!(["high", "low", "max"]);
    let tampered: RegistryResolutionV1 = serde_json::from_value(t).unwrap();
    let (_d, mut k) = fresh_kernel();
    assert_eq!(
        k.seal_issuance(&tampered).unwrap_err().code.as_str(),
        "delivery-invalid"
    );
    // (4) the binding's target projection edited to carry a wider policy: projection mismatch
    let mut proj = issued.clone();
    proj["taskBinding"]["target"]["allowedReasoning"] = json!(["high", "low", "max"]);
    proj["taskBinding"]["supportedReasoning"] = json!(["high", "low", "max"]);
    rebind(&mut proj);
    let (_d, mut k) = fresh_kernel();
    assert!(k
        .seal_task_binding(
            &proj["taskBinding"],
            &res.provenance.issuance_id,
            &ext_digest
        )
        .is_err());
    // the genuine binding seals
    let (_d, mut k) = fresh_kernel();
    k.seal_task_binding(
        &issued["taskBinding"],
        &res.provenance.issuance_id,
        &ext_digest,
    )
    .unwrap();
}

/// Characterization of the trust root (documented, not a defect of EM-02): the Kernel seals
/// any self-consistent issuance the authenticated issuer channel delivers. A forger able to
/// re-derive every digest of a task's FIRST issuance can choose its policy exactly as it could
/// choose its model or route; EM-02 gives the capability the same provenance as the model and
/// no weaker. Once the task is bound, neither can change.
#[test]
fn capability_has_exactly_the_provenance_of_the_model_identity() {
    let reg = registry(&["low", "high"]);
    let issued = issue(reg.path(), "task-em02-root");
    let re_derive = |field: &str, value: Value| {
        let mut r = typed(&issued["resolution"]);
        let mut t = serde_json::to_value(&r.target).unwrap();
        t[field] = value;
        r.target = serde_json::from_value(t.clone()).unwrap();
        r.provenance.target_digest = nexus_contracts::target_digest_of(&t);
        r.provenance.issuance_id = r.issuance_id_of();
        r
    };
    let dir = tempfile::tempdir().unwrap();
    let mut k = open_kernel(dir.path());
    // both are accepted at sealing for an unbound task (issuer channel = trust root) ...
    k.seal_issuance(&re_derive("routeId", json!("e2e-mock/e2e-2")))
        .unwrap();
    k.seal_issuance(&re_derive(
        "allowedReasoning",
        json!(["high", "low", "max"]),
    ))
    .unwrap();
    // ... and both are refused for a task whose binding was sealed from the genuine issuance
    let mut t = task(&issued, true);
    for (field, value) in [
        ("routeId", json!("e2e-mock/e2e-2")),
        ("allowedReasoning", json!(["high", "low", "max"])),
    ] {
        let f = serde_json::to_value(re_derive(field, value)).unwrap();
        t.kernel.seal_issuance(&typed(&f)).unwrap();
        let err = run_attempt(&mut t, 7, &f, &issued["extension"]).unwrap_err();
        assert!(
            err.starts_with("accept: binding-mismatch"),
            "{field}: {err}"
        );
    }
}

/// The bridge's selection path (how the broker issues every run): the operator's slot policy
/// applies to the saved model/route only; selecting another model, even one whose route declares
/// more levels, authorizes its default alone.
#[test]
fn a_slot_policy_does_not_follow_a_selection_of_another_model() {
    let reg = registry(&["low", "high"]);
    let root = repo_root();
    let data = reg.path().to_str().unwrap();
    let r = driver(
        &[
            "registry-levels",
            data,
            root.to_str().unwrap(),
            "e2e-mock/e2e-2",
            "[\"low\",\"high\"]",
        ],
        None,
    );
    assert_eq!(r["ok"], true, "{r}");
    let issue_selected = |task: &str, model: &str, route: &str| -> Value {
        let out = Command::new("node")
            .arg(root.join("config/registry/native-intent-bridge.cjs"))
            .args([
                "issue",
                root.to_str().unwrap(),
                data,
                task,
                &format!("session-{task}"),
            ])
            .arg(json!({"logicalModelId": model, "routeId": route}).to_string())
            .output()
            .unwrap();
        serde_json::from_slice(&out.stdout).expect("bridge json")
    };
    let saved = issue_selected("task-em02-sel-1", "e2e/e2e-1", "e2e-mock/e2e-1");
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(binding_of(&saved).supported_reasoning, vec!["high", "low"]);
    let other = issue_selected("task-em02-sel-2", "e2e/e2e-2", "e2e-mock/e2e-2");
    assert_eq!(other["ok"], true, "{other}");
    assert!(other["resolution"]["target"]
        .get("allowedReasoning")
        .is_none());
    assert_eq!(binding_of(&other).supported_reasoning, vec!["low"]);
    assert_eq!(
        issue_attempt(&other, "high")["code"],
        "reasoning-level-not-supported"
    );
}
