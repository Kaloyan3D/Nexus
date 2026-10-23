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

/// Version of the identity digest recorded with a run (EM-04C2 S3). Version 2 added the slot's
/// `allowedReasoning` policy; runs recorded before carry no version (legacy, version 1).
pub const IDENTITY_VERSION: u32 = 2;

fn identity_base(binding: &nexus_contracts::TaskBindingV1) -> Value {
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
    identity
}

/// The identity a continuation must keep: model, route, provider, connection, credential, mode,
/// engine, default effort, request budget and - EM-04C2 S3 (G-1) - the slot's explicit
/// `allowedReasoning` policy, as a sorted, de-duplicated list. The policy key is present ONLY when
/// the target carries one, so every policy-less binding hashes byte-for-byte as before. A widened,
/// narrowed or removed policy is therefore another identity: `task-binding-mismatch` before any
/// request, never a silent inheritance of broader (or different) authorization.
pub fn identity_digest(binding: &nexus_contracts::TaskBindingV1) -> String {
    let mut identity = identity_base(binding);
    if let Some(policy) = binding.target.get("allowedReasoning") {
        identity["allowedReasoning"] = canonical_policy(policy);
    }
    nexus_contracts::digest_value(&identity)
}

/// The identity digest of runs recorded before EM-04C2 (no policy key). Kept only to verify
/// legacy records.
pub fn identity_digest_v1(binding: &nexus_contracts::TaskBindingV1) -> String {
    nexus_contracts::digest_value(&identity_base(binding))
}

/// The policy as a canonical list: a list of strings is sorted and de-duplicated; anything else is
/// carried verbatim (the Registry never issues it, and carrying it makes any change visible).
fn canonical_policy(policy: &Value) -> Value {
    match policy.as_array() {
        Some(a) if a.iter().all(|v| v.is_string()) => {
            let mut l: Vec<String> = a
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            l.sort();
            l.dedup();
            serde_json::json!(l)
        }
        _ => policy.clone(),
    }
}

/// Whether a run recorded with `recorded` (identity digest) and `version` may be continued under
/// `binding`.
///
/// * version 2: the recorded digest must equal this binding's v2 digest (policy included).
/// * no version (a run recorded before EM-04C2): the recorded digest must equal the legacy digest,
///   AND the new binding must carry no explicit policy: the old record cannot prove which policy
///   it ran under, so a binding that authorizes extra levels cannot be shown to be unchanged
///   and is refused. (A legacy run under an engine that cannot change effort, which is every
///   shipped engine, never used the policy.)
pub fn identity_matches(
    recorded: &str,
    version: Option<u32>,
    binding: &nexus_contracts::TaskBindingV1,
) -> bool {
    match version {
        Some(IDENTITY_VERSION) => recorded == identity_digest(binding),
        Some(_) => false,
        None => {
            recorded == identity_digest_v1(binding)
                && binding.target.get("allowedReasoning").is_none()
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use nexus_contracts::TaskBindingV1;

    fn binding(policy: Option<&[&str]>, budget: Option<u64>) -> TaskBindingV1 {
        let mut target = serde_json::json!({
            "modeId": "engineering-v2", "orchestrationEngineId": "muse-v0", "roleId": "muse_main",
            "logicalModelId": "m", "routeId": "r", "providerId": "p", "remoteModelId": "x",
            "connectionId": "c", "executionKind": "raw-model", "protocolId": "p"
        });
        if let Some(p) = policy {
            target["allowedReasoning"] = serde_json::json!(p);
        }
        if let Some(b) = budget {
            target["requestBudgetBytes"] = serde_json::json!(b);
        }
        TaskBindingV1 {
            schema_version: 1,
            task_instance_id: "t".into(),
            role: "muse_main".into(),
            issuer: "i".into(),
            registry_snapshot_digest: "s".into(),
            mode_config_revision: serde_json::json!(0),
            target,
            extension: serde_json::json!({"endpoint": {"protocol": "https", "origin": "o",
                "path": "/p", "method": "POST"}, "credentialRef": "cr", "wireProfile": "w"}),
            default_reasoning: "low".into(),
            supported_reasoning: policy
                .map(|p| p.iter().map(|s| s.to_string()).collect())
                .unwrap_or_else(|| vec!["low".into()]),
        }
    }

    /// Digests computed by the BASELINE code (`50a24d7`, before this change) for these inputs.
    #[test]
    fn policy_less_identities_are_byte_identical_to_the_baseline() {
        assert_eq!(
            identity_digest(&binding(None, None)),
            "b367efc6807d64e4f2aa532ac1423e3704a573d9c9d8bc48314f765643b7a07d"
        );
        assert_eq!(
            identity_digest(&binding(None, Some(428_722))),
            "bbebf7348bd6632f2a0f72e029c6e13b75f209e37054b8bd2b03f1b362543bd9"
        );
        assert_eq!(
            identity_digest(&binding(None, None)),
            identity_digest_v1(&binding(None, None))
        );
        // the legacy digest ignores a policy, exactly as the baseline did
        assert_eq!(
            identity_digest_v1(&binding(Some(&["low", "medium"]), None)),
            "b367efc6807d64e4f2aa532ac1423e3704a573d9c9d8bc48314f765643b7a07d"
        );
    }

    #[test]
    fn the_policy_is_part_of_the_identity_canonically() {
        let none = identity_digest(&binding(None, None));
        let only = identity_digest(&binding(Some(&["low"]), None));
        let wide = identity_digest(&binding(Some(&["low", "medium", "high", "xhigh"]), None));
        let mid = identity_digest(&binding(Some(&["low", "medium"]), None));
        // default-only policy, widened, narrowed and absent are four distinct identities
        let all = [&none, &only, &wide, &mid];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
        // order and duplicates do not matter (canonical sorted set)
        assert_eq!(
            wide,
            identity_digest(&binding(
                Some(&["xhigh", "high", "low", "medium", "high"]),
                None
            ))
        );
        // the budget and the policy are independent parts
        assert_ne!(
            identity_digest(&binding(Some(&["low"]), Some(100_000))),
            identity_digest(&binding(Some(&["low"]), Some(200_000)))
        );
        // everything else of the identity still counts
        let mut other = binding(Some(&["low"]), None);
        other.target["routeId"] = "r2".into();
        assert_ne!(identity_digest(&other), only);
    }

    /// EM-04C2 S4: the mode and its engine are part of the identity, so no continuation can move
    /// between modes (or between the engines they name) and keep its binding.
    #[test]
    fn the_mode_and_the_engine_are_part_of_the_identity() {
        let base = binding(Some(&["low", "medium"]), None);
        let id = identity_digest(&base);
        let mut other_mode = base.clone();
        other_mode.target["modeId"] = "engineering-v2-adaptive".into();
        let mut other_engine = base.clone();
        other_engine.target["orchestrationEngineId"] = "nexus-adaptive-v1".into();
        let mut both = other_mode.clone();
        both.target["orchestrationEngineId"] = "nexus-adaptive-v1".into();
        for changed in [&other_mode, &other_engine, &both] {
            assert_ne!(identity_digest(changed), id);
            assert!(!identity_matches(&id, Some(IDENTITY_VERSION), changed));
        }
        assert!(identity_matches(&id, Some(IDENTITY_VERSION), &base));
    }

    #[test]
    fn a_continuation_needs_the_same_policy_and_legacy_records_fail_closed_on_a_policy() {
        let rec = |b: &TaskBindingV1| (identity_digest(b), Some(IDENTITY_VERSION));
        let (id, v) = rec(&binding(Some(&["low"]), None));
        // identical policy continues
        assert!(identity_matches(&id, v, &binding(Some(&["low"]), None)));
        assert!(identity_matches(&id, v, &binding(Some(&["low"]), None)));
        // widened, narrowed (to another set) and removed policies do not
        for changed in [
            binding(Some(&["low", "medium", "high", "xhigh"]), None),
            binding(Some(&["low", "medium"]), None),
            binding(None, None),
        ] {
            assert!(!identity_matches(&id, v, &changed));
        }
        // a policy-less run cannot be continued under a newly added policy either
        let (id0, v0) = rec(&binding(None, None));
        assert!(identity_matches(&id0, v0, &binding(None, None)));
        assert!(!identity_matches(
            &id0,
            v0,
            &binding(Some(&["low", "high"]), None)
        ));
        // a record written before EM-04C2 (no version): its digest is the legacy one
        let legacy = identity_digest_v1(&binding(None, None));
        assert!(
            identity_matches(&legacy, None, &binding(None, None)),
            "legacy + policy-less continues"
        );
        assert!(
            !identity_matches(&legacy, None, &binding(Some(&["low", "high"]), None)),
            "legacy + an explicit policy: it cannot be shown unchanged, so it is refused"
        );
        assert!(!identity_matches(&legacy, None, &{
            let mut b = binding(None, None);
            b.target["routeId"] = "other".into();
            b
        }));
        // unknown versions never match
        assert!(!identity_matches(&id0, Some(1), &binding(None, None)));
        assert!(!identity_matches(&id0, Some(3), &binding(None, None)));
    }

    /// S9.5: representative sealed digests, computed by the SAME code before (`cb2edbc`, with the
    /// engine id `muse-v1`) and after (`nexus-adaptive-v1`) the identity rename. The digest code is
    /// engine-id-agnostic, so the rename changes exactly the digests whose input names the adaptive
    /// engine, and none of the `muse-v0` ones.
    fn adaptive_binding(engine: &str) -> TaskBindingV1 {
        let mut b = binding(Some(&["low", "medium", "high", "xhigh"]), Some(440_000));
        b.target["modeId"] = "engineering-v2-adaptive".into();
        b.target["orchestrationEngineId"] = engine.into();
        b
    }

    fn digests(b: &TaskBindingV1) -> [String; 3] {
        [
            identity_digest(b),
            identity_digest_v1(b),
            b.binding_digest(),
        ]
    }

    #[test]
    fn the_rename_changes_exactly_the_digests_that_name_the_adaptive_engine() {
        let strs = |a: [&str; 3]| a.map(str::to_owned);
        // muse-v0: identical before and after (default mode, and with a policy + budget)
        assert_eq!(
            digests(&binding(None, None)),
            strs([
                "b367efc6807d64e4f2aa532ac1423e3704a573d9c9d8bc48314f765643b7a07d",
                "b367efc6807d64e4f2aa532ac1423e3704a573d9c9d8bc48314f765643b7a07d",
                "5c273dd36d55cacedeaf0c3d42c889b57b497ea4d5b821c8feffaa3551d0b6c7",
            ])
        );
        let mut v0 = binding(Some(&["low", "medium", "high", "xhigh"]), Some(440_000));
        v0.target["modeId"] = "engineering-v2".into();
        assert_eq!(
            digests(&v0),
            strs([
                "90aeabe84f167eb03160d283ab0bbcbd2812b7e0909309f2856b410c7d355dd6",
                "4f7d6e8250706cefd481d7561fe0cb6c44a68bbd46ed5e6d27055dfaf3133537",
                "a562a159f669e29e58505c46728808e062ef483435ec3fd05d4d089cac0404f6",
            ])
        );
        // the adaptive engine: pinned before (old id) and after (new id)
        let old = adaptive_binding("muse-v1");
        let new = adaptive_binding("nexus-adaptive-v1");
        assert_eq!(
            digests(&old),
            strs([
                "09c9dfd1b9b1f1731b66c01e48832188b022a6a228c9a15c0721cedbadb62216",
                "483cf1c714086ce46125c7941aaaceadd9629f812dc64351910de6af95bcd70d",
                "ad8e8d9524ca65ef229f01a44fbde5e34e1896626a441fde04e5af77779b370a",
            ])
        );
        assert_eq!(
            digests(&new),
            strs([
                "426db16e3285bd424d2b7ce3431c55345feb7c0f30df8e541433d16b8c01c430",
                "424d2b5364d84e6eed294c11a729965955d1a0dd16c42c60c5eb05b38af0c0e5",
                "61b45a036d7ef6969109068127daf2c51be2603b19427a6038efe9d5bcfc3451",
            ])
        );
        // every identity-dependent digest changes
        for (o, n) in digests(&old).iter().zip(digests(&new).iter()) {
            assert_ne!(o, n);
        }
        // a run recorded under the old identity can never be continued under the new binding
        assert!(!identity_matches(
            &identity_digest(&old),
            Some(IDENTITY_VERSION),
            &new
        ));
        assert!(identity_matches(
            &identity_digest(&new),
            Some(IDENTITY_VERSION),
            &new
        ));
        // ... and not through the legacy (no-version) path either
        assert!(!identity_matches(&identity_digest_v1(&old), None, &new));
        // the engine id is the ONLY difference between the two bindings
        let mut renamed = old.clone();
        renamed.target["orchestrationEngineId"] = "nexus-adaptive-v1".into();
        assert_eq!(digests(&renamed), digests(&new));
    }
}
