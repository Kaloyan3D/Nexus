//! EM-02: the execution target of each model attempt.
//!
//! A run has ONE immutable task binding: the Registry issuance made when the task started, its
//! sealed V2 extension, and the `TaskBindingV1` the Kernel sealed for the task (everything but
//! the reasoning effort, plus the default effort and the levels the bound route declared). Each
//! model attempt then executes an [`AttemptTarget`]:
//!
//! * [`EffortRequest::Pinned`] - the task's own issuance, unchanged (no Registry call). This is
//!   the only request the EngineExtension v1 contract can produce, so `muse-v0` keeps today's
//!   behaviour byte for byte.
//! * [`EffortRequest::Authorized`] - a different effort, issued by the Registry
//!   (`issue-attempt`) strictly under the sealed binding (never from the live Registry
//!   configuration), checked here against the binding, and sealed by the Kernel; the Kernel
//!   re-checks the binding when the attempt's intent is published and accepted, and the executor
//!   only sends a request prepared from exactly the target the grant names.
//!
//! Nothing here reads a model or tool output: the effort of an attempt can only come from the
//! broker's trusted code path (in EM-02: never anything but `Pinned` in production).

use crate::pipeline::{bridge, daemon, se, str_of, StepError};
use crate::server::Broker;
use serde_json::Value;

/// A refused target operation (public so trusted-interface tests can drive this module).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetError {
    pub code: String,
    pub message: String,
}

impl From<StepError> for TargetError {
    fn from(e: StepError) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

impl From<TargetError> for StepError {
    fn from(e: TargetError) -> Self {
        se(e.code, e.message)
    }
}

fn te(code: &str, message: impl Into<String>) -> TargetError {
    TargetError {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// The task's immutable binding and its own (default-effort) target.
#[derive(Debug, Clone)]
pub struct TaskTarget {
    pub resolution: Value,
    pub extension: Value,
    pub extension_digest: String,
    pub binding: nexus_contracts::TaskBindingV1,
    pub binding_digest: String,
}

/// What one attempt asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortRequest<'a> {
    /// The task's own effort (the configured default).
    Pinned,
    /// A specific effort that a trusted caller decided on (never model/tool output).
    Authorized(&'a str),
}

/// The target one attempt executes.
#[derive(Debug, Clone, PartialEq)]
pub struct AttemptTarget {
    pub effort: String,
    pub resolution: Value,
    pub extension: Value,
    pub extension_digest: String,
}

impl AttemptTarget {
    /// The sealed core (`resolution.target`), as the executor expects it.
    pub fn core(&self) -> Value {
        self.resolution.get("target").cloned().unwrap_or_default()
    }
}

impl TaskTarget {
    /// Seal the task binding the Registry issued with the task's issuance (`issued` is the
    /// bridge `issue` output, whose issuance and extension are already sealed). Fails closed if
    /// the binding is missing, malformed, does not describe this issuance, or cannot be sealed.
    pub fn seal(b: &Broker, issued: &Value, extension_digest: &str) -> Result<Self, TargetError> {
        let resolution = issued.get("resolution").cloned().unwrap_or_default();
        let extension = issued.get("extension").cloned().unwrap_or_default();
        let raw = issued.get("taskBinding").cloned().ok_or_else(|| {
            te(
                "task-binding-unavailable",
                "the Registry issued no task binding; nothing was sent",
            )
        })?;
        let binding: nexus_contracts::TaskBindingV1 =
            serde_json::from_value(raw.clone()).map_err(|_| {
                te(
                    "task-binding-invalid",
                    "the Registry's task binding is malformed; nothing was sent",
                )
            })?;
        let typed: nexus_contracts::RegistryResolutionV1 =
            serde_json::from_value(resolution.clone()).map_err(|_| {
                te(
                    "task-binding-invalid",
                    "the task issuance is not a resolution",
                )
            })?;
        binding
            .matches_task_issuance(&typed, &extension)
            .map_err(|e| {
                te(
                    "task-binding-invalid",
                    format!(
                        "the task binding does not describe this issuance: {}",
                        e.message
                    ),
                )
            })?;
        // EM-04C1: the request budget is Registry policy sealed with the target. The binding's
        // projection must carry exactly the issuance's value, in range, or nothing is sent.
        let sealed_budget = binding.target.get("requestBudgetBytes");
        if sealed_budget.is_some_and(|v| v.as_u64().is_none())
            || sealed_budget.and_then(|v| v.as_u64()) != typed.target.request_budget_bytes
        {
            return Err(te(
                "task-binding-invalid",
                "the task binding's request budget is not the issuance's; nothing was sent",
            ));
        }
        let claimed = issued
            .get("taskBindingDigest")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if claimed != binding.binding_digest() {
            return Err(te(
                "task-binding-invalid",
                "the task binding does not match its digest; nothing was sent",
            ));
        }
        let sealed = daemon(
            b,
            "seal-task-binding",
            serde_json::json!({
                "binding": raw,
                "issuanceId": typed.provenance.issuance_id,
                "extensionDigest": extension_digest,
            }),
        )?;
        let digest = str_of(&sealed, "taskBindingDigest")?;
        if digest != binding.binding_digest() {
            return Err(te(
                "task-binding-invalid",
                "the Kernel sealed another binding than the Registry issued",
            ));
        }
        Ok(Self {
            resolution,
            extension,
            extension_digest: extension_digest.to_owned(),
            binding,
            binding_digest: digest,
        })
    }

    /// The task-start primitive on its own: Registry issuance of the configured default target
    /// for `task_instance_id`, Kernel seals of its issuance and extension, then the binding.
    /// (The coding loop performs the same steps inline, interleaved with its own checks.)
    pub fn issue(
        b: &Broker,
        task_instance_id: &str,
        session_id: &str,
    ) -> Result<Self, TargetError> {
        let repo = b.cfg.repo_root.to_string_lossy().into_owned();
        let data = b.cfg.registry_data_root.to_string_lossy().into_owned();
        let issued = bridge(
            b,
            "issue",
            &[&repo, &data, task_instance_id, session_id],
            None,
        )?;
        let resolution = issued.get("resolution").cloned().unwrap_or_default();
        daemon(b, "seal", serde_json::json!({ "resolution": resolution }))?;
        let sealed = daemon(
            b,
            "seal-extension",
            serde_json::json!({ "extension": issued.get("extension").cloned().unwrap_or_default() }),
        )?;
        let extension_digest = str_of(&sealed, "extensionDigest")?;
        Self::seal(b, &issued, &extension_digest)
    }

    pub fn default_effort(&self) -> &str {
        &self.binding.default_reasoning
    }

    /// EM-04C1: the Registry-sealed serialized-request budget of this task's mode, if its mode
    /// declares one. Read from the sealed binding only, so it is fixed for the task, identical in
    /// every attempt's issuance (the binding admits only targets equal to it outside the effort)
    /// and unaffected by any later configuration, flag, model or tool output.
    pub fn request_budget_bytes(&self) -> Option<usize> {
        self.binding
            .target
            .get("requestBudgetBytes")
            .and_then(|v| v.as_u64())
            .filter(|b| {
                (nexus_contracts::MIN_REQUEST_BUDGET_BYTES
                    ..=nexus_contracts::MAX_REQUEST_BUDGET_BYTES)
                    .contains(b)
            })
            .map(|b| b as usize)
    }

    /// Identity a continuation must keep (model, route, provider, connection, endpoint,
    /// credential reference, mode, engine and default effort): stable across task generations.
    pub fn identity_digest(&self) -> String {
        identity_digest(&self.binding)
    }

    /// The task's own target (the pinned default).
    pub fn pinned(&self) -> AttemptTarget {
        AttemptTarget {
            effort: self.binding.default_reasoning.clone(),
            resolution: self.resolution.clone(),
            extension: self.extension.clone(),
            extension_digest: self.extension_digest.clone(),
        }
    }

    /// The target of one attempt. `Pinned` (and an authorized effort equal to the default)
    /// returns the task's own target without any call; another effort is issued by the Registry
    /// under the sealed binding, verified here, and sealed by the Kernel.
    pub fn for_attempt(
        &self,
        b: &Broker,
        request: EffortRequest<'_>,
    ) -> Result<AttemptTarget, TargetError> {
        let effort = match request {
            EffortRequest::Pinned => return Ok(self.pinned()),
            EffortRequest::Authorized(e) if e == self.binding.default_reasoning => {
                return Ok(self.pinned())
            }
            EffortRequest::Authorized(e) => e,
        };
        #[cfg(feature = "test-engines")]
        if crate::engine::test_faults::armed_for_task(
            &self.binding.task_instance_id,
            "authorize-fail",
        ) {
            return Err(te(
                "registry-unavailable",
                "[injected] the Registry refused to authorize the attempt",
            ));
        }
        if !self.binding.supported_reasoning.iter().any(|l| l == effort) {
            return Err(te(
                "reasoning-level-not-supported",
                "the task's route does not declare this reasoning effort; nothing was sent",
            ));
        }
        let out = bridge(
            b,
            "issue-attempt",
            &[],
            Some(&serde_json::json!({
                "taskBinding": self.binding,
                "taskBindingDigest": self.binding_digest,
                "resolution": self.resolution,
                "extension": self.extension,
                "requestedEffort": effort,
            })),
        )?;
        let resolution = out.get("resolution").cloned().unwrap_or_default();
        let extension = out.get("extension").cloned().unwrap_or_default();
        let typed: nexus_contracts::RegistryResolutionV1 =
            serde_json::from_value(resolution.clone()).map_err(|_| {
                te(
                    "attempt-target-invalid",
                    "the attempt issuance is not a resolution",
                )
            })?;
        if typed.issuance_id_of() != typed.provenance.issuance_id {
            return Err(te(
                "attempt-target-invalid",
                "the attempt issuance does not match its issuance id",
            ));
        }
        // the effort exactly as requested, under the task's binding
        let got = self
            .binding
            .admits(&typed, &extension)
            .map_err(|e| te("attempt-target-invalid", e.message))?;
        if got != effort || out.get("effort").and_then(|v| v.as_str()) != Some(effort) {
            return Err(te(
                "attempt-target-invalid",
                "the Registry issued another effort than requested; nothing was sent",
            ));
        }
        daemon(b, "seal", serde_json::json!({ "resolution": resolution }))?;
        let sealed = daemon(
            b,
            "seal-extension",
            serde_json::json!({ "extension": extension }),
        )?;
        let extension_digest = str_of(&sealed, "extensionDigest")?;
        if Some(extension_digest.as_str()) != out.get("extensionDigest").and_then(|v| v.as_str()) {
            return Err(te(
                "attempt-target-invalid",
                "the Kernel sealed another extension than the Registry issued",
            ));
        }
        Ok(AttemptTarget {
            effort: got,
            resolution,
            extension,
            extension_digest,
        })
    }
}

/// See [`TaskTarget::identity_digest`].
pub fn identity_digest(binding: &nexus_contracts::TaskBindingV1) -> String {
    let t = &binding.target;
    let x = &binding.extension;
    let pick = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let endpoint = x.get("endpoint").cloned().unwrap_or(Value::Null);
    let mut identity = serde_json::json!({
        "modeId": pick(t, "modeId"),
        "orchestrationEngineId": pick(t, "orchestrationEngineId"),
        "roleId": pick(t, "roleId"),
        "logicalModelId": pick(t, "logicalModelId"),
        "routeId": pick(t, "routeId"),
        "providerId": pick(t, "providerId"),
        "remoteModelId": pick(t, "remoteModelId"),
        "connectionId": pick(t, "connectionId"),
        "executionKind": pick(t, "executionKind"),
        "protocolId": pick(t, "protocolId"),
        "endpoint": {
            "protocol": pick(&endpoint, "protocol"),
            "origin": pick(&endpoint, "origin"),
            "path": pick(&endpoint, "path"),
            "method": pick(&endpoint, "method"),
        },
        "credentialRef": pick(x, "credentialRef"),
        "wireProfile": pick(x, "wireProfile"),
        "defaultReasoning": binding.default_reasoning,
    });
    // EM-04C1: a budgeted mode's budget is part of the identity a continuation must keep; a mode
    // without one hashes exactly as before (the key is absent, not null).
    if let Some(b) = t.get("requestBudgetBytes") {
        identity["requestBudgetBytes"] = b.clone();
    }
    nexus_contracts::digest_value(&identity)
}
