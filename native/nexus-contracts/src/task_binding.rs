//! EM-02: immutable task-level binding and per-attempt reasoning authorization.
//!
//! A task's Registry issuance (sealed resolution + sealed V2 extension) pins everything about
//! where its model requests go. EM-02 splits that into
//!
//! * the **task binding** ([`TaskBindingV1`]): every field of the issued target and extension
//!   EXCEPT the reasoning effort, plus the task's default effort and the reasoning levels the
//!   bound route declared when the task was issued. It is produced by the Registry once per task
//!   generation, sealed by the Kernel (first writer wins, immutable), and never re-read from the
//!   live Registry configuration;
//! * a **per-attempt target**: a Registry issuance for one model attempt that is identical to the
//!   task's issuance except for `target.reasoning` / `extension.reasoningEffort` (and the digests
//!   derived from them), with an effort the binding declares supported.
//!
//! [`TaskBindingV1::admits`] is the single rule both the Kernel and tests apply: a (resolution,
//! extension) pair is executable under a binding iff its projection equals the binding's and its
//! effort is one of the binding's supported levels. The projection removes exactly
//! `target.reasoning` and `extension.reasoningEffort`; JS (`native-task-binding.cjs`) and Rust
//! compute the same canonical digests.

use crate::canonical::digest_value;
use crate::errors::{KernelError, KernelErrorCode, KernelResult};
use crate::target::RegistryResolutionV1;
use serde::{Deserialize, Serialize};

pub const TASK_BINDING_SCHEMA_VERSION: u32 = 1;
/// Upper bound on declared reasoning levels (Registry routes declare a handful).
pub const MAX_REASONING_LEVELS: usize = 16;

/// The immutable task-level binding (camelCase on the wire, like every Registry contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskBindingV1 {
    pub schema_version: u32,
    pub task_instance_id: String,
    pub role: String,
    pub issuer: String,
    pub registry_snapshot_digest: String,
    pub mode_config_revision: serde_json::Value,
    /// The issued target without `reasoning`.
    pub target: serde_json::Value,
    /// The issued V2 extension without `reasoningEffort`.
    pub extension: serde_json::Value,
    /// The effort of the task's own issuance (the configured default).
    pub default_reasoning: String,
    /// Reasoning levels the bound route declared at issuance (Registry capability data).
    pub supported_reasoning: Vec<String>,
}

/// `target` without its attempt-variable field.
pub fn project_target(target: &serde_json::Value) -> serde_json::Value {
    without(target, "reasoning")
}

/// `extension` without its attempt-variable field.
pub fn project_extension(extension: &serde_json::Value) -> serde_json::Value {
    without(extension, "reasoningEffort")
}

fn without(v: &serde_json::Value, key: &str) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut m = m.clone();
            m.remove(key);
            serde_json::Value::Object(m)
        }
        other => other.clone(),
    }
}

/// The reasoning levels a sealed target authorizes: its slot policy (`allowedReasoning`, carried
/// in the Registry-issued, digest-covered target) or, without one, its own effort alone. The
/// route's declared capability never authorizes a level by itself (the Registry resolver already
/// required every policy level to be route-declared). Sorted, distinct. Identical to the JS
/// `authorizedLevels`.
pub fn authorized_levels(target: &crate::target::ExecutionTargetCoreV1) -> Vec<String> {
    let mut v = match &target.allowed_reasoning {
        Some(levels) => levels.clone(),
        None => vec![target.reasoning.clone()],
    };
    v.sort();
    v.dedup();
    v
}

fn mismatch(msg: impl Into<String>) -> KernelError {
    KernelError::new(KernelErrorCode::BindingMismatch, msg)
}

impl TaskBindingV1 {
    /// Canonical digest of the binding (identical to the JS `bindingDigest`).
    pub fn binding_digest(&self) -> String {
        digest_value(&serde_json::to_value(self).unwrap_or(serde_json::Value::Null))
    }

    /// Structural validity: schema, identities, a non-empty set of distinct levels that
    /// contains the default.
    pub fn validate(&self) -> KernelResult<()> {
        if self.schema_version != TASK_BINDING_SCHEMA_VERSION {
            return Err(KernelError::new(
                KernelErrorCode::UnsupportedSchema,
                "unsupported task binding schemaVersion",
            ));
        }
        if self.task_instance_id.trim().is_empty()
            || self.role.trim().is_empty()
            || self.issuer.trim().is_empty()
            || self.registry_snapshot_digest.trim().is_empty()
        {
            return Err(KernelError::new(
                KernelErrorCode::TargetIncomplete,
                "task binding lacks its task, role, issuer or snapshot identity",
            ));
        }
        if !self.target.is_object() || !self.extension.is_object() {
            return Err(KernelError::new(
                KernelErrorCode::TargetIncomplete,
                "task binding lacks its target or extension",
            ));
        }
        if self.target.get("reasoning").is_some() || self.extension.get("reasoningEffort").is_some()
        {
            return Err(mismatch(
                "task binding must not pin an effort inside its projection",
            ));
        }
        let levels = &self.supported_reasoning;
        if levels.is_empty()
            || levels.len() > MAX_REASONING_LEVELS
            || levels.iter().any(|l| !valid_level(l))
            || levels.windows(2).any(|w| w[0] >= w[1])
        {
            return Err(KernelError::new(
                KernelErrorCode::TargetIncomplete,
                "task binding declares no valid reasoning levels (canonical: sorted, distinct)",
            ));
        }
        if !levels.contains(&self.default_reasoning) {
            return Err(mismatch(
                "the task's default effort is not one of the levels its route declares",
            ));
        }
        Ok(())
    }

    /// Whether `issued` (+ its sealed `extension`) may execute under this binding: same task,
    /// role, issuer, snapshot, mode revision, target and extension except for the effort, and
    /// an effort the binding declares supported. Never escalates or downgrades: the effort is
    /// checked exactly as issued.
    pub fn admits(
        &self,
        issued: &RegistryResolutionV1,
        extension: &serde_json::Value,
    ) -> KernelResult<String> {
        let effort = self.admits_target(issued)?;
        if digest_value(&project_extension(extension)) != digest_value(&self.extension) {
            return Err(mismatch(
                "target extension changes the task's endpoint, connection, credential or limits",
            ));
        }
        let ext_effort = extension
            .get("reasoningEffort")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if effort != ext_effort {
            return Err(mismatch(
                "extension effort differs from the issued target effort",
            ));
        }
        Ok(effort)
    }

    /// The target half of [`Self::admits`] (where only the issuance is presented, e.g. the
    /// Kernel's command acceptance): returns the issued effort.
    pub fn admits_target(&self, issued: &RegistryResolutionV1) -> KernelResult<String> {
        self.validate()?;
        if issued.task_instance_id != self.task_instance_id {
            return Err(KernelError::new(
                KernelErrorCode::GenerationMismatch,
                "issuance belongs to another task than its binding",
            ));
        }
        if issued.role != self.role
            || issued.issuer != self.issuer
            || issued.provenance.issuer != self.issuer
            || issued.provenance.registry_snapshot_digest != self.registry_snapshot_digest
            || issued.provenance.mode_config_revision != self.mode_config_revision
        {
            return Err(mismatch(
                "issuance role, issuer, snapshot or mode revision differs from the task binding",
            ));
        }
        let target = serde_json::to_value(&issued.target).map_err(|_| {
            KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                "target is not JSON-representable",
            )
        })?;
        if digest_value(&project_target(&target)) != digest_value(&self.target) {
            return Err(mismatch(
                "issued target changes the task's model, route, provider, connection or policy",
            ));
        }
        let effort = issued.target.reasoning.clone();
        // the binding's levels are exactly what the sealed target authorizes (its slot policy),
        // and the effort is one of them: a binding can never widen what the Registry issued
        if self.supported_reasoning != authorized_levels(&issued.target) {
            return Err(mismatch(
                "the binding's reasoning levels differ from those the issued target authorizes",
            ));
        }
        if !self.supported_reasoning.contains(&effort) {
            return Err(mismatch(format!(
                "reasoning effort {:?} is not supported by the task's route",
                effort.chars().take(32).collect::<String>()
            )));
        }
        Ok(effort)
    }

    /// The binding a task's own issuance implies (used to check that a delivered binding
    /// describes exactly the issuance it claims to bind).
    pub fn matches_task_issuance(
        &self,
        issued: &RegistryResolutionV1,
        extension: &serde_json::Value,
    ) -> KernelResult<()> {
        let effort = self.admits(issued, extension)?;
        if effort != self.default_reasoning {
            return Err(mismatch(
                "the task's own issuance must carry the binding's default effort",
            ));
        }
        Ok(())
    }
}

fn valid_level(l: &str) -> bool {
    // 1..=32 visible ASCII characters (the JS Registry applies the same rule)
    !l.is_empty() && l.len() <= 32 && l.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::{ExecutionTargetCoreV1, RegistryProvenanceV1};

    fn issued(effort: &str) -> (RegistryResolutionV1, serde_json::Value) {
        issued_with(effort, Some(&["high", "low"]))
    }

    /// A Registry-shaped issuance whose target carries `policy` as its slot reasoning policy.
    fn issued_with(
        effort: &str,
        policy: Option<&[&str]>,
    ) -> (RegistryResolutionV1, serde_json::Value) {
        let mut target =
            ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(0));
        target.reasoning = effort.into();
        target.allowed_reasoning = policy.map(|p| p.iter().map(|s| s.to_string()).collect());
        let mut r = RegistryResolutionV1 {
            schema_version: 1,
            issuer: "registry".into(),
            task_instance_id: "task-1".into(),
            role: "muse_main".into(),
            target: target.clone(),
            provenance: RegistryProvenanceV1 {
                issuer: "registry".into(),
                resolution_id_compat: "r".into(),
                registry_snapshot_digest: "snap".into(),
                target_digest: String::new(),
                mode_config_revision: serde_json::json!(0),
                issuance_id: String::new(),
            },
        };
        r.provenance.target_digest = digest_value(&serde_json::to_value(&target).unwrap());
        r.provenance.issuance_id = r.issuance_id_of();
        let ext = serde_json::json!({
            "extensionVersion": 1,
            "endpoint": {"origin": "https://example.test", "path": "/v1/responses"},
            "remoteModelIdConfirmed": "remote-model",
            "reasoningEffort": effort,
            "connectionBinding": "connection",
            "credentialRef": "credential://c",
        });
        (r, ext)
    }

    fn binding(levels: &[&str]) -> TaskBindingV1 {
        let (r, ext) = issued("low");
        binding_of(&r, &ext, levels)
    }

    fn binding_of(
        r: &RegistryResolutionV1,
        ext: &serde_json::Value,
        levels: &[&str],
    ) -> TaskBindingV1 {
        TaskBindingV1 {
            schema_version: 1,
            task_instance_id: r.task_instance_id.clone(),
            role: r.role.clone(),
            issuer: r.issuer.clone(),
            registry_snapshot_digest: r.provenance.registry_snapshot_digest.clone(),
            mode_config_revision: r.provenance.mode_config_revision.clone(),
            target: project_target(&serde_json::to_value(&r.target).unwrap()),
            extension: project_extension(ext),
            default_reasoning: "low".into(),
            supported_reasoning: levels.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// EM-04C1: a target of a mode without a request budget serializes WITHOUT the key, with the
    /// digest it always had; a budgeted target is a different target that no other binding admits.
    fn issued_budget(budget: Option<u64>) -> (RegistryResolutionV1, serde_json::Value) {
        let (mut r, ext) = issued("low");
        r.target.request_budget_bytes = budget;
        r.provenance.target_digest = digest_value(&serde_json::to_value(&r.target).unwrap());
        r.provenance.issuance_id = r.issuance_id_of();
        (r, ext)
    }

    #[test]
    fn a_target_without_a_budget_is_byte_for_byte_what_it_was() {
        let (plain, _) = issued("low");
        let v = serde_json::to_value(&plain.target).unwrap();
        assert!(v.get("requestBudgetBytes").is_none(), "{v}");
        // the digest of a budget-less sample target is pinned: the new field cannot move it
        let mut t =
            ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(0));
        t.reasoning = "low".into();
        assert_eq!(
            digest_value(&serde_json::to_value(&t).unwrap()),
            digest_value(&serde_json::json!({
                "schemaVersion": 1, "resolutionId": "compat-resolution", "modeId": "engineering-v2",
                "orchestrationEngineId": "muse", "modeConfigRevision": 0, "roleId": "muse_main",
                "logicalModelId": "logical-model", "routeId": "route", "providerId": "provider",
                "remoteModelId": "remote-model", "connectionId": "connection",
                "executionKind": "raw-model", "accessType": "managed", "protocolId": "https",
                "reasoning": "low", "requiredCapabilities": [], "slotRequirements": {},
                "dataUseTier": null,
            }))
        );
        // an old serialized target (no key) still reads, as `None`
        let back: ExecutionTargetCoreV1 = serde_json::from_value(v).unwrap();
        assert_eq!(back.request_budget_bytes, None);
    }

    #[test]
    fn a_budgeted_target_round_trips_and_is_bounded() {
        let (r, _) = issued_budget(Some(428_722));
        let v = serde_json::to_value(&r.target).unwrap();
        assert_eq!(v["requestBudgetBytes"], 428_722);
        let back: ExecutionTargetCoreV1 = serde_json::from_value(v).unwrap();
        assert_eq!(back.request_budget_bytes, Some(428_722));
        back.validate_complete().unwrap();
        for ok in [
            crate::MIN_REQUEST_BUDGET_BYTES,
            450_000,
            crate::MAX_REQUEST_BUDGET_BYTES,
        ] {
            let mut t = back.clone();
            t.request_budget_bytes = Some(ok);
            t.validate_complete().unwrap();
        }
        for bad in [
            0,
            1,
            crate::MIN_REQUEST_BUDGET_BYTES - 1,
            crate::MAX_REQUEST_BUDGET_BYTES + 1,
            u64::MAX,
        ] {
            let mut t = back.clone();
            t.request_budget_bytes = Some(bad);
            assert_eq!(
                t.validate_complete().unwrap_err().code,
                KernelErrorCode::BindingMismatch,
                "{bad}"
            );
        }
        // a non-integer budget is not representable
        let mut v = serde_json::to_value(&back).unwrap();
        v["requestBudgetBytes"] = serde_json::json!("450000");
        assert!(serde_json::from_value::<ExecutionTargetCoreV1>(v).is_err());
    }

    #[test]
    fn a_binding_admits_only_targets_with_its_own_budget() {
        let (r0, ext) = issued_budget(Some(428_722));
        let b = binding_of(&r0, &ext, &["high", "low"]);
        assert_eq!(
            b.target["requestBudgetBytes"], 428_722,
            "the projection keeps it"
        );
        b.matches_task_issuance(&r0, &ext).unwrap();
        // another budget, no budget, or a widened one: refused
        for other in [Some(100_000), None, Some(crate::MAX_REQUEST_BUDGET_BYTES)] {
            let (r, ext) = issued_budget(other);
            assert!(b.admits(&r, &ext).is_err(), "{other:?}");
            assert!(b.admits_target(&r).is_err(), "{other:?}");
        }
        // and a budget-less binding refuses a budgeted target
        let (plain, ext) = issued_budget(None);
        let bp = binding_of(&plain, &ext, &["high", "low"]);
        bp.matches_task_issuance(&plain, &ext).unwrap();
        assert!(bp.admits(&r0, &ext).is_err());
        // the effort still changes freely inside the same budget
        let (mut hi, ext) = issued_budget(Some(428_722));
        hi.target.reasoning = "high".into();
        hi.provenance.target_digest = digest_value(&serde_json::to_value(&hi.target).unwrap());
        hi.provenance.issuance_id = hi.issuance_id_of();
        let mut ext_hi = ext.clone();
        ext_hi["reasoningEffort"] = "high".into();
        assert_eq!(b.admits(&hi, &ext_hi).unwrap(), "high");
    }

    #[test]
    fn supported_efforts_are_admitted_with_an_identical_projection() {
        let b = binding(&["high", "low"]);
        for e in ["low", "high"] {
            let (r, ext) = issued(e);
            assert_eq!(b.admits(&r, &ext).unwrap(), e);
        }
        let (r, ext) = issued("low");
        b.matches_task_issuance(&r, &ext).unwrap();
        let (r, ext) = issued("high");
        assert!(b.matches_task_issuance(&r, &ext).is_err());
    }

    #[test]
    fn anything_but_a_supported_effort_is_refused() {
        let b = binding(&["high", "low"]);
        // unsupported effort
        let (r, ext) = issued("xhigh");
        assert_eq!(
            b.admits(&r, &ext).unwrap_err().code,
            KernelErrorCode::BindingMismatch
        );
        // model / route / provider / connection changes
        for (field, value) in [
            ("remoteModelId", "other-model"),
            ("routeId", "other-route"),
            ("providerId", "other-provider"),
            ("connectionId", "other-connection"),
            ("logicalModelId", "other-logical"),
            ("modeId", "engineering-v3"),
            ("orchestrationEngineId", "nova-v3"),
        ] {
            let (mut r, ext) = issued("low");
            let mut t = serde_json::to_value(&r.target).unwrap();
            t[field] = value.into();
            r.target = serde_json::from_value(t).unwrap();
            assert!(b.admits(&r, &ext).is_err(), "{field}");
        }
        // extension endpoint / credential changes
        for (field, value) in [
            ("credentialRef", serde_json::json!("credential://other")),
            (
                "endpoint",
                serde_json::json!({"origin": "https://evil.test"}),
            ),
            ("connectionBinding", serde_json::json!("other")),
        ] {
            let (r, mut ext) = issued("low");
            ext[field] = value;
            assert!(b.admits(&r, &ext).is_err(), "{field}");
        }
        // effort split between target and extension
        let (r, mut ext) = issued("low");
        ext["reasoningEffort"] = "high".into();
        assert!(b.admits(&r, &ext).is_err());
        // another task
        let (mut r, ext) = issued("low");
        r.task_instance_id = "task-2".into();
        assert_eq!(
            b.admits(&r, &ext).unwrap_err().code,
            KernelErrorCode::GenerationMismatch
        );
    }

    #[test]
    fn a_malformed_binding_is_refused() {
        let mut b = binding(&["low"]);
        b.default_reasoning = "high".into();
        assert!(b.validate().is_err(), "default outside the levels");
        let mut b = binding(&[]);
        b.default_reasoning = "low".into();
        assert!(b.validate().is_err(), "no levels");
        assert!(
            binding(&["low", "low"]).validate().is_err(),
            "duplicate levels"
        );
        assert!(binding(&["low", "bad level"]).validate().is_err());
        let mut b = binding(&["low"]);
        b.target["reasoning"] = "low".into();
        assert!(b.validate().is_err(), "projection must not pin an effort");
        // the wire form round-trips and refuses unknown fields
        let b = binding(&["high", "low"]);
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(
            serde_json::from_value::<TaskBindingV1>(v.clone()).unwrap(),
            b
        );
        let mut extra = v;
        extra["supportedModels"] = serde_json::json!([]);
        assert!(serde_json::from_value::<TaskBindingV1>(extra).is_err());
    }

    /// EM-02 hardening: a binding can never claim more levels than the sealed target's slot
    /// policy authorizes, and a target without a slot policy authorizes its own effort only.
    #[test]
    fn the_sealed_target_policy_is_the_only_source_of_authorized_levels() {
        // widened binding (as a broker could deliver before sealing)
        let (r, ext) = issued_with("low", Some(&["low"]));
        let wide = binding_of(&r, &ext, &["high", "low"]);
        assert_eq!(
            wide.matches_task_issuance(&r, &ext).unwrap_err().code,
            KernelErrorCode::BindingMismatch
        );
        // no slot policy: only the default
        let (r, ext) = issued_with("low", None);
        assert_eq!(authorized_levels(&r.target), vec!["low"]);
        let b = binding_of(&r, &ext, &["low"]);
        b.matches_task_issuance(&r, &ext).unwrap();
        let (high, high_ext) = issued_with("high", None);
        assert!(
            b.admits(&high, &high_ext).is_err(),
            "route capability alone authorizes nothing"
        );
        assert!(binding_of(&r, &ext, &["high", "low"])
            .matches_task_issuance(&r, &ext)
            .is_err());
        // an effort outside the target's own policy is refused by the target itself
        let (bad, _) = issued_with("high", Some(&["low"]));
        assert!(bad.target.validate_complete().is_err());
        // a policy that differs between the task target and an attempt target is a redirect
        let (r, ext) = issued_with("low", Some(&["high", "low"]));
        let b = binding_of(&r, &ext, &["high", "low"]);
        let (other, other_ext) = issued_with("high", Some(&["high", "low", "max"]));
        assert!(b.admits(&other, &other_ext).is_err());
    }
}
