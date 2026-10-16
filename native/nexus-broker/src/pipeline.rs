//! The execution pipeline for one accepted run (worker thread).
//!
//! Every step is an EXISTING authority call; the pipeline only sequences
//! them: Controller bridge (task + Registry issuance + shadow/kernel/
//! dispatch intents), issuer-authenticated daemon calls (acquire, seal,
//! seal-extension, intent-publish, accept, dispatch-authorize) and the
//! HTTPS executor (`run_model_only`). A failure before the executor starts
//! ends the run as `rejected` with nothing sent; after it starts the
//! executor's own durable record decides the terminal state. There is no
//! retry anywhere.

use crate::server::Broker;
use nexus_client::intent_client::IntentRun;
use nexus_client::{issuer, ModelRunOptions, ModelRunRequest, ModelRunUpdate};
use nexus_contracts::intent::NexusIntentV1;
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) struct StepError {
    pub code: String,
    pub message: String,
}

pub(crate) fn se(code: impl Into<String>, message: impl Into<String>) -> StepError {
    StepError {
        code: code.into(),
        message: message.into(),
    }
}

/// Run the fixed-argument Controller bridge. The environment is cleared so
/// ambient secrets in the broker's environment never reach node.
pub(crate) fn bridge(
    b: &Broker,
    sub: &str,
    args: &[&str],
    stdin: Option<&Value>,
) -> Result<Value, StepError> {
    let mut cmd = Command::new(&b.node_abs);
    cmd.arg(b.cfg.bridge_path())
        .arg(sub)
        .args(args)
        .env_clear()
        .env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_owned()),
        )
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| {
        se(
            "bridge-unavailable",
            format!("cannot start the Controller bridge: {e}"),
        )
    })?;
    if let Some(v) = stdin {
        use std::io::Write;
        if let Some(mut s) = child.stdin.take() {
            let _ = s.write_all(v.to_string().as_bytes());
        }
    }
    let mut out = String::new();
    let mut so = child.stdout.take();
    let reader = std::thread::spawn(move || {
        if let Some(s) = so.as_mut() {
            let _ = s.take(4 * 1024 * 1024).read_to_string(&mut out);
        }
        out
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(se(
                    "bridge-timeout",
                    "the Controller bridge did not finish in time",
                ));
            }
        }
    }
    let out = reader.join().unwrap_or_default();
    let v: Value = serde_json::from_str(out.trim().lines().last().unwrap_or(""))
        .map_err(|_| se("bridge-error", "the Controller bridge returned no JSON"))?;
    if v.get("ok") == Some(&Value::Bool(true)) {
        Ok(v)
    } else {
        Err(se(
            v.get("code")
                .and_then(|c| c.as_str())
                .unwrap_or("bridge-error")
                .to_owned(),
            v.get("message")
                .and_then(|c| c.as_str())
                .unwrap_or("bridge refused")
                .to_owned(),
        ))
    }
}

pub(crate) fn daemon(b: &Broker, cmd: &str, params: Value) -> Result<Value, StepError> {
    let resp = issuer::issuer_call(&b.cfg.daemon_socket, &b.cap_hex, cmd, params)
        .map_err(|e| se("daemon-unreachable", e.message))?;
    if resp.get("ok") == Some(&Value::Bool(true)) {
        Ok(resp)
    } else {
        Err(se(
            format!(
                "daemon-{}",
                resp.get("code").and_then(|c| c.as_str()).unwrap_or("error")
            ),
            resp.get("message")
                .and_then(|c| c.as_str())
                .unwrap_or("daemon refused")
                .to_owned(),
        ))
    }
}

pub(crate) fn str_of(v: &Value, k: &str) -> Result<String, StepError> {
    v.get(k)
        .and_then(|x| x.as_str())
        .map(str::to_owned)
        .ok_or_else(|| se("bridge-error", format!("missing {k} in a Controller reply")))
}

/// Mark a pre-execution failure. Nothing was sent.
pub(crate) fn reject(b: &Broker, run_id: &str, code: &str, message: &str) {
    b.update(run_id, |r| {
        r.state = "rejected".into();
        r.terminal = true;
        r.error_code = Some(code.to_owned());
        r.error_message = Some(message.to_owned());
    });
}

pub(crate) fn cancelled_before_submission(b: &Broker, run_id: &str) {
    b.update(run_id, |r| {
        r.state = "cancelled".into();
        r.terminal = true;
        r.error_code = Some("cancelled-before-submission".into());
        r.error_message = Some("cancelled before any provider submission; nothing was sent".into());
    });
}

/// Client-visible text for a pre-execution failure. Infrastructure detail
/// (paths, interpreter messages) stays in the operator log only.
pub(crate) fn client_message(code: &str, message: &str) -> String {
    match code {
        "bridge-error" | "bridge-timeout" | "bridge-unavailable" | "ledger-unreadable"
        | "daemon-unreachable" | "daemon-shape" | "internal-panic" => {
            format!("the request could not be prepared ({code}); see the operator log")
        }
        _ => message.chars().take(300).collect(),
    }
}

pub fn execute(b: Arc<Broker>, run_id: String, intent: NexusIntentV1, flag: Arc<AtomicBool>) {
    // A panic in any step must end the run (nothing sent), never strand it
    // in a non-terminal state or take the worker's cleanup with it.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if intent.intent_type == nexus_contracts::intent::INTENT_REPO_INSPECT {
            crate::inspect::run(&b, &run_id, &intent, &flag)
        } else {
            run_steps(&b, &run_id, &intent, &flag)
        }
    }))
    .unwrap_or_else(|_| Err(se("internal-panic", "the pipeline panicked")));
    if let Err(e) = result {
        eprintln!(
            "[broker] run {run_id} failed before submission: {}: {}",
            e.code, e.message
        );
        reject(&b, &run_id, &e.code, &client_message(&e.code, &e.message));
    }
    if let Ok(mut g) = b.cancel_flags.lock() {
        g.remove(&run_id);
    }
}

fn run_steps(
    b: &Arc<Broker>,
    run_id: &str,
    intent: &NexusIntentV1,
    flag: &Arc<AtomicBool>,
) -> Result<(), StepError> {
    let stop = |b: &Broker| -> bool {
        if flag.load(Ordering::SeqCst) || b.shutdown.load(Ordering::SeqCst) {
            cancelled_before_submission(b, run_id);
            true
        } else {
            false
        }
    };
    b.update(run_id, |r| r.state = "preparing".into());
    if stop(b) {
        return Ok(());
    }

    // 1. Controller task + attempt (serialized: the ledger has one writer).
    let ws = b.cfg.ledger_workspace.to_string_lossy().into_owned();
    let task = {
        let _g = b.bridge_lock.lock().unwrap_or_else(|p| p.into_inner());
        bridge(b, "task-create", &[&ws], None)?
    };
    let (task_id, task_instance, attempt_id, session_id) = (
        str_of(&task, "taskId")?,
        str_of(&task, "taskInstanceId")?,
        str_of(&task, "attemptId")?,
        str_of(&task, "sessionId")?,
    );
    b.update(run_id, |r| {
        r.task_id = Some(task_id.clone());
        r.task_instance_id = Some(task_instance.clone());
        r.attempt_id = Some(attempt_id.clone());
    });
    if stop(b) {
        return Ok(());
    }

    // 2. Registry issuance (V1 resolution + V2 extension).
    let repo = b.cfg.repo_root.to_string_lossy().into_owned();
    let data = b.cfg.registry_data_root.to_string_lossy().into_owned();
    let issued = bridge(
        b,
        "issue",
        &[&repo, &data, &task_instance, &session_id],
        None,
    )?;
    let shadow = bridge(
        b,
        "shadow",
        &[&ws, &task_id, &attempt_id, &task_instance],
        None,
    )?;
    let shadow_intent = shadow.get("intent").cloned().unwrap_or_default();
    let command_id = str_of(&shadow_intent, "commandId")?;
    b.update(run_id, |r| r.command_id = Some(command_id.clone()));

    // 3. Kernel lease + seals.
    let acquired = daemon(
        b,
        "acquire",
        serde_json::json!({ "taskInstanceId": task_instance, "backend": "native" }),
    )?;
    let lease_epoch = acquired
        .pointer("/lease/leaseEpoch")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| se("daemon-shape", "acquire returned no lease epoch"))?;
    let incarnation = acquired
        .pointer("/lease/storeIncarnation")
        .and_then(|v| v.as_str())
        .ok_or_else(|| se("daemon-shape", "acquire returned no store incarnation"))?
        .to_owned();
    let resolution = issued.get("resolution").cloned().unwrap_or_default();
    let extension = issued.get("extension").cloned().unwrap_or_default();
    daemon(b, "seal", serde_json::json!({ "resolution": resolution }))?;
    let sealed = daemon(
        b,
        "seal-extension",
        serde_json::json!({ "extension": extension }),
    )?;
    let extension_digest = str_of(&sealed, "extensionDigest")?;

    // 4. Kernel intent (digest binding) and request preparation.
    let kernel_intent = bridge(
        b,
        "kernel-intent",
        &[],
        Some(&serde_json::json!({
            "shadowIntent": shadow_intent,
            "issuance": {
                "modeId": issued.get("modeId"), "role": issued.get("role"),
                "modeConfigRevision": issued.get("modeConfigRevision"),
                "modeConfigDigest": issued.get("modeConfigDigest"),
            },
        })),
    )?;
    let kintent = kernel_intent.get("intent").cloned().unwrap_or_default();
    let req = ModelRunRequest {
        user_initiated: true,
        prompt: intent.content.clone(),
        task_instance_id: task_instance.clone(),
        command_id: command_id.clone(),
        attempt_id: attempt_id.clone(),
        lease_epoch,
        store_incarnation: incarnation.clone(),
        intent_digest: str_of(&kintent, "intentDigest")?,
        resolution: resolution.clone(),
        snapshot: issued.get("snapshot").cloned().unwrap_or_default(),
        core: issued.get("core").cloned().unwrap_or_default(),
        extension: extension.clone(),
        expected: intent.model.as_ref().map(|m| nexus_client::ExpectedTarget {
            provider_id: m.provider_id.clone(),
            remote_model_id: m.remote_model_id.clone(),
        }),
        max_output_tokens: intent.limits.max_output_tokens,
    };
    let prepared = nexus_client::prepare_model_run(&req).map_err(|e| {
        let code = if e.code == "wrong-model" {
            "model-not-available"
        } else {
            "prepare-refused"
        };
        se(code, e.message)
    })?;
    // A5.4: a real (https, production-transport) provider call needs an
    // operator authorization, consumed before any grant exists.
    if b.cfg.transport.is_none() && prepared.endpoint_origin.starts_with("https://") {
        // A broker whose binary was replaced since it started must not spend
        // a live authorization (checked BEFORE consuming it, so the record
        // survives and the operator can restart and retry).
        if crate::identity::self_stale() {
            return Err(se(
                "broker-stale",
                "this broker process predates the installed nexus-broker binary; restart it (nothing sent, authorization kept)",
            ));
        }
        crate::live_auth::consume(
            &b.cfg.state_dir,
            &crate::live_auth::Attempt {
                provider_id: &prepared.provider_id,
                remote_model_id: &prepared.remote_model_id,
                prompt: &intent.content,
                requested_max_output: intent.limits.max_output_tokens,
            },
        )
        .map_err(|(c, m)| se(c, m))?;
    }
    b.update(run_id, |r| {
        r.provider_id = Some(prepared.provider_id.clone());
        r.remote_model_id = Some(prepared.remote_model_id.clone());
        r.logical_model_id = Some(prepared.logical_model_id.clone());
        r.request_digest = Some(prepared.request_digest.clone());
    });
    if stop(b) {
        return Ok(());
    }

    // 5. Publish the user-initiated model-only intent, accept, authorize.
    let bundle = bridge(
        b,
        "publish",
        &[],
        Some(&serde_json::json!({
            "shadowIntent": shadow_intent,
            "lease": { "epoch": lease_epoch, "storeIncarnation": incarnation },
            "role": issued.get("role"),
            "issuance": { "taskInstanceId": task_instance, "resolution": resolution },
            "extensionDigest": extension_digest,
            "requestDigest": prepared.request_digest,
            "sessionId": session_id,
        })),
    )?;
    daemon(
        b,
        "intent-publish",
        serde_json::json!({ "intent": bundle.get("bundle").cloned().unwrap_or_default() }),
    )?;
    daemon(
        b,
        "accept",
        serde_json::json!({
            "intent": kintent, "resolution": resolution,
            "snapshot": issued.get("snapshot").cloned().unwrap_or_default(),
            "lease": { "epoch": lease_epoch, "storeIncarnation": incarnation },
        }),
    )?;
    if stop(b) {
        return Ok(());
    }
    let auth = daemon(
        b,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": command_id, "requestDigest": prepared.request_digest,
            "scope": "model-only", "endpointOrigin": prepared.endpoint_origin,
            "credentialRef": prepared.credential_ref,
        }),
    )?;
    let grant = auth.get("grant").cloned().unwrap_or_default();
    b.update(run_id, |r| r.state = "authorized".into());
    if stop(b) {
        // Grant minted, never redeemed: it simply expires (300 s TTL).
        return Ok(());
    }

    // 6. Execute (single-use redemption happens inside, before any byte).
    let opts = ModelRunOptions {
        cap_path: b.cfg.cap_path.clone(),
        credentials_path: b.cfg.credentials_path.clone(),
        limits: b.cfg.limits,
        transport: b.cfg.transport.clone(),
    };
    b.update(run_id, |r| r.state = "executing".into());
    let cfg = b.client_config();
    let outcome = nexus_client::run_model_only(&cfg, &opts, &req, &grant, &mut |u| {
        if let ModelRunUpdate::Conversation { id } = u {
            b.update(run_id, |r| r.conversation_id = Some(id.clone()));
            if flag.load(Ordering::SeqCst) {
                let _ = nexus_client::request_model_cancel(&cfg, &id);
            }
        }
    });
    match outcome {
        Ok(o) => {
            let s = o.status;
            b.update(run_id, |r| apply_status(r, &s));
        }
        Err(e) => {
            // The executor could not record anything (credential invalid,
            // store unavailable): nothing was submitted.
            return Err(se(e.code, e.message));
        }
    }
    Ok(())
}

/// Copy the executor's durable status into the run view.
pub(crate) fn apply_status(r: &mut IntentRun, s: &nexus_client::ModelRunStatus) {
    r.state = s.state.clone();
    r.terminal = s.terminal;
    r.conversation_id = Some(s.conversation_id.clone());
    r.provider_id = s.provider_id.clone().or(r.provider_id.take());
    r.remote_model_id = s.remote_model_id.clone().or(r.remote_model_id.take());
    r.logical_model_id = s.logical_model_id.clone().or(r.logical_model_id.take());
    r.endpoint_kind = s.endpoint_kind.clone();
    r.http_status = s.http_status;
    r.usage_input_tokens = s.usage_input_tokens;
    r.usage_output_tokens = s.usage_output_tokens;
    r.finish_reason = s.finish_reason.clone();
    r.latency_ms = s.latency_ms;
    r.first_token_ms = s.first_token_ms;
    r.provider_request_id = s.provider_request_id.clone();
    r.provider_response_id = s.provider_response_id.clone();
    r.error_code = s.error_code.clone();
    if s.terminal && s.state != "completed" && r.error_message.is_none() {
        r.error_message = Some(format!("run ended as {}", s.state));
    }
}
