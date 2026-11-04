//! R-NATIVE-2: one shared target resolution ("which target does this run
//! use") for model-only and coding runs. The Registry catalog is the only
//! authority; this module only selects among catalog entries. Resolution
//! happens once, before the run exists; a non-issuable or unknown target is
//! refused before any run (same codes as R-NATIVE-1, with the catalog
//! reason). There is no silent fallback: an explicit selection must match
//! exactly, and when only (providerId, remoteModelId) is given and more
//! than one issuable route matches, resolution refuses with
//! `ambiguous-target` listing the routeIds.

use nexus_client::intent_client::RegistryTarget;
use nexus_contracts::intent::ModelSelection;

/// Resolved Registry target identity bound to one run for its whole life.
/// Identity plus limits only; never a credential reference, value or path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub provider_id: String,
    pub logical_model_id: String,
    pub remote_model_id: String,
    pub route_id: String,
    pub connection_id: Option<String>,
    pub context_limit_tokens: u64,
    pub output_limit_tokens: u64,
    pub billing_tier: String,
}

impl ResolvedTarget {
    pub fn selection_for_issue(&self) -> serde_json::Value {
        serde_json::json!({
            "logicalModelId": self.logical_model_id,
            "routeId": self.route_id,
        })
    }

    pub fn matches_selection(&self, m: &ModelSelection) -> bool {
        if self.provider_id != m.provider_id || self.remote_model_id != m.remote_model_id {
            return false;
        }
        if let Some(l) = &m.logical_model_id {
            if *l != self.logical_model_id {
                return false;
            }
        }
        if let Some(r) = &m.route_id {
            if *r != self.route_id {
                return false;
            }
        }
        true
    }
}

/// Resolve one run's target from the catalog: explicit selection, else the
/// conversation's target, else the default (first issuable in catalog
/// order). `conversation` carries the conversation's bound identity, when
/// any. Fails closed: unknown, non-issuable and ambiguous selections are
/// refused before any run exists.
pub fn resolve_target(
    catalog: &[RegistryTarget],
    explicit: Option<&ModelSelection>,
    conversation: Option<&ResolvedTarget>,
) -> Result<ResolvedTarget, (String, String)> {
    let from_catalog = |t: &RegistryTarget| ResolvedTarget {
        provider_id: t.provider_id.clone(),
        logical_model_id: t.logical_model_id.clone(),
        remote_model_id: t.remote_model_id.clone(),
        route_id: t.route_id.clone(),
        connection_id: t.connection_id.clone(),
        context_limit_tokens: t.context_limit_tokens,
        output_limit_tokens: t.output_limit_tokens,
        billing_tier: t.billing_tier.clone(),
    };
    if let Some(sel) = explicit {
        // Bare routeId (thread-send `--route` without a model pair): match
        // the route alone, exactly.
        if sel.provider_id.is_empty() && sel.remote_model_id.is_empty() {
            if let Some(rid) = sel.route_id.as_ref() {
                match catalog.iter().find(|t| t.route_id == **rid) {
                    Some(t) if t.issuable => return Ok(from_catalog(t)),
                    Some(t) => {
                        let reason = t.reason.clone().unwrap_or_else(|| "not-issuable".into());
                        return Err((
                            "model-not-available".to_owned(),
                            format!(
                                "the Registry does not currently issue this provider/model ({reason})"
                            ),
                        ));
                    }
                    None => {
                        return Err((
                            "model-not-available".to_owned(),
                            "the Registry does not currently issue this provider/model (unknown-target)"
                                .to_owned(),
                        ));
                    }
                }
            }
            return Err((
                "bad-intent".to_owned(),
                "model must be provider/model".to_owned(),
            ));
        }
        let exact: Vec<&RegistryTarget> = catalog
            .iter()
            .filter(|t| {
                t.provider_id == sel.provider_id && t.remote_model_id == sel.remote_model_id
            })
            .collect();
        if exact.is_empty() {
            return Err((
                "model-not-available".to_owned(),
                "the Registry does not currently issue this provider/model (unknown-target)"
                    .to_owned(),
            ));
        }
        // Optional route identity: when given it must match exactly.
        if let Some(rid) = &sel.route_id {
            let want_logical = sel.logical_model_id.as_ref();
            match exact.iter().find(|t| {
                t.route_id == **rid
                    && want_logical
                        .map(|l| *l == t.logical_model_id)
                        .unwrap_or(true)
            }) {
                Some(t) if t.issuable => return Ok(from_catalog(t)),
                Some(t) => {
                    let reason = t.reason.clone().unwrap_or_else(|| "not-issuable".into());
                    return Err((
                        "model-not-available".to_owned(),
                        format!(
                            "the Registry does not currently issue this provider/model ({reason})"
                        ),
                    ));
                }
                None => {
                    return Err((
                        "model-not-available".to_owned(),
                        "the Registry does not currently issue this provider/model (unknown-target)"
                            .to_owned(),
                    ));
                }
            }
        }
        if let Some(lid) = &sel.logical_model_id {
            match exact.iter().find(|t| t.logical_model_id == **lid) {
                Some(t) if t.issuable => return Ok(from_catalog(t)),
                Some(t) => {
                    let reason = t.reason.clone().unwrap_or_else(|| "not-issuable".into());
                    return Err((
                        "model-not-available".to_owned(),
                        format!(
                            "the Registry does not currently issue this provider/model ({reason})"
                        ),
                    ));
                }
                None => {
                    return Err((
                        "model-not-available".to_owned(),
                        "the Registry does not currently issue this provider/model (unknown-target)"
                            .to_owned(),
                    ));
                }
            }
        }
        let issuable: Vec<&RegistryTarget> = exact.iter().filter(|t| t.issuable).copied().collect();
        match issuable.len() {
            0 => {
                let reason = exact
                    .iter()
                    .filter_map(|t| t.reason.clone())
                    .next()
                    .unwrap_or_else(|| "not-issuable".into());
                Err((
                    "model-not-available".to_owned(),
                    format!("the Registry does not currently issue this provider/model ({reason})"),
                ))
            }
            1 => Ok(from_catalog(issuable[0])),
            _ => {
                let mut ids: Vec<String> = issuable.iter().map(|t| t.route_id.clone()).collect();
                ids.sort();
                Err((
                    "ambiguous-target".to_owned(),
                    format!(
                        "more than one issuable route matches this provider/model; choose one: {}",
                        ids.join(", ")
                    ),
                ))
            }
        }
    } else if let Some(conv) = conversation {
        // The conversation's target must still be issuable; no fallback.
        match catalog
            .iter()
            .find(|t| t.route_id == conv.route_id && t.logical_model_id == conv.logical_model_id)
        {
            Some(t) if t.issuable => Ok(from_catalog(t)),
            Some(t) => {
                let reason = t.reason.clone().unwrap_or_else(|| "not-issuable".into());
                Err((
                    "model-not-available".to_owned(),
                    format!(
                        "the conversation's model is no longer issued by the Registry ({reason})"
                    ),
                ))
            }
            None => Err((
                "model-not-available".to_owned(),
                "the conversation's model is no longer issued by the Registry (unknown-target)"
                    .to_owned(),
            )),
        }
    } else {
        catalog
            .iter()
            .find(|t| t.issuable)
            .map(from_catalog)
            .ok_or_else(|| {
                (
                    "model-not-allowed".to_owned(),
                    "no model is allowed for this broker".to_owned(),
                )
            })
    }
}

/// Effective context budget in bytes: the configured budget, bounded by a
/// documented bytes-per-token fraction of the target's context window. For
/// the default target (very large window) this equals the configured budget
/// exactly, so default behaviour is unchanged (golden-tested).
pub const BYTES_PER_CONTEXT_TOKEN: u64 = 4;

pub fn effective_context_budget(configured_bytes: usize, context_limit_tokens: u64) -> usize {
    if context_limit_tokens == 0 {
        return configured_bytes;
    }
    let cap = context_limit_tokens.saturating_mul(BYTES_PER_CONTEXT_TOKEN);
    let cap: usize = cap.try_into().unwrap_or(usize::MAX);
    configured_bytes.min(cap)
}

/// The per-turn output cap never exceeds the target's output limit. For the
/// default target (very large limit) the requested/ceiling values are
/// unchanged (golden-tested).
pub fn effective_output_cap(requested: Option<u64>, target_limit: u64) -> Option<u64> {
    match (requested, target_limit) {
        (r, 0) => r,
        (None, l) => Some(l),
        (Some(r), l) => Some(r.min(l)),
    }
}

/// Run binding identity recorded on `IntentRun` (identity + limits only).
pub fn run_binding(t: &ResolvedTarget) -> serde_json::Value {
    serde_json::json!({
        "routeId": t.route_id,
        "logicalModelId": t.logical_model_id,
        "connectionId": t.connection_id,
        "contextLimitTokens": t.context_limit_tokens,
        "outputLimitTokens": t.output_limit_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn target(
        provider: &str,
        logical: &str,
        remote: &str,
        route: &str,
        issuable: bool,
        reason: Option<&str>,
        connection: Option<&str>,
        context: u64,
        output: u64,
    ) -> RegistryTarget {
        RegistryTarget {
            provider_id: provider.into(),
            logical_model_id: logical.into(),
            remote_model_id: remote.into(),
            route_id: route.into(),
            connection_id: connection.map(str::to_owned),
            connection_status: "verified".into(),
            protocol: "https".into(),
            context_limit_tokens: context,
            output_limit_tokens: output,
            billing_tier: "standard".into(),
            data_use: None,
            issuable,
            reason: reason.map(str::to_owned),
        }
    }

    fn catalog() -> Vec<RegistryTarget> {
        vec![
            target(
                "p",
                "l1",
                "r1",
                "route-1",
                true,
                None,
                Some("c1"),
                1_000_000,
                8_000,
            ),
            target(
                "p",
                "l2",
                "r2",
                "route-2a",
                true,
                None,
                Some("c2"),
                2_000,
                100,
            ),
            target(
                "p",
                "l2",
                "r2",
                "route-2b",
                true,
                None,
                Some("c2"),
                3_000,
                200,
            ),
            target(
                "p",
                "l3",
                "r3",
                "route-3",
                false,
                Some("connection-unverified"),
                Some("c3"),
                4_000,
                400,
            ),
        ]
    }

    #[test]
    fn default_is_first_issuable() {
        let t = resolve_target(&catalog(), None, None).expect("default");
        assert_eq!(t.route_id, "route-1");
        assert_eq!(t.logical_model_id, "l1");
    }

    #[test]
    fn explicit_unique_selection_resolves() {
        let sel = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r1".into(),
            logical_model_id: None,
            route_id: None,
            mode_id: None,
        };
        let t = resolve_target(&catalog(), Some(&sel), None).expect("explicit");
        assert_eq!(t.route_id, "route-1");
        assert_eq!(t.connection_id.as_deref(), Some("c1"));
    }

    #[test]
    fn explicit_route_identity_must_match() {
        let sel = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r2".into(),
            logical_model_id: Some("l2".into()),
            route_id: Some("route-2b".into()),
            mode_id: None,
        };
        let t = resolve_target(&catalog(), Some(&sel), None).expect("route");
        assert_eq!(t.route_id, "route-2b");
        assert_eq!(t.output_limit_tokens, 200);
        let bad = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r2".into(),
            logical_model_id: None,
            route_id: Some("route-nope".into()),
            mode_id: None,
        };
        let (code, _) = resolve_target(&catalog(), Some(&bad), None).expect_err("unknown");
        assert_eq!(code, "model-not-available");
    }

    #[test]
    fn ambiguous_without_route_is_refused() {
        let sel = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r2".into(),
            logical_model_id: None,
            route_id: None,
            mode_id: None,
        };
        let (code, msg) = resolve_target(&catalog(), Some(&sel), None).expect_err("ambiguous");
        assert_eq!(code, "ambiguous-target");
        assert!(msg.contains("route-2a"), "{msg}");
        assert!(msg.contains("route-2b"), "{msg}");
    }

    #[test]
    fn non_issuable_and_unknown_are_refused() {
        let sel = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r3".into(),
            logical_model_id: None,
            route_id: None,
            mode_id: None,
        };
        let (code, msg) = resolve_target(&catalog(), Some(&sel), None).expect_err("refused");
        assert_eq!(code, "model-not-available");
        assert!(msg.contains("connection-unverified"), "{msg}");
        let ghost = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "ghost".into(),
            logical_model_id: None,
            route_id: None,
            mode_id: None,
        };
        let (code, _) = resolve_target(&catalog(), Some(&ghost), None).expect_err("unknown");
        assert_eq!(code, "model-not-available");
    }

    #[test]
    fn conversation_binding_is_remembered_and_checked() {
        let conv = resolve_target(
            &catalog(),
            Some(&ModelSelection {
                provider_id: "p".into(),
                remote_model_id: "r1".into(),
                logical_model_id: None,
                route_id: None,
                mode_id: None,
            }),
            None,
        )
        .expect("conv");
        // Follow-up without a selection keeps the conversation's target,
        // even though the default would be identical here via catalog order;
        // prove it with the second target.
        let sel2 = ModelSelection {
            provider_id: "p".into(),
            remote_model_id: "r2".into(),
            logical_model_id: None,
            route_id: Some("route-2a".into()),
            mode_id: None,
        };
        let conv2 = resolve_target(&catalog(), Some(&sel2), None).expect("second");
        let follow = resolve_target(&catalog(), None, Some(&conv2)).expect("follow-up");
        assert_eq!(follow.route_id, "route-2a");
        // A conversation whose target is no longer issuable is refused.
        let mut gone = catalog();
        gone.iter_mut()
            .find(|t| t.route_id == "route-2a")
            .unwrap()
            .issuable = false;
        gone.iter_mut()
            .find(|t| t.route_id == "route-2a")
            .unwrap()
            .reason = Some("connection-unverified".into());
        let t = resolve_target(&catalog()[..], None, Some(&conv)).expect("same catalog");
        assert_eq!(t.route_id, conv.route_id);
        let (code, _) = resolve_target(&gone, None, Some(&conv2)).expect_err("stale");
        assert_eq!(code, "model-not-available");
    }

    #[test]
    fn limit_helpers_keep_default_behaviour() {
        assert_eq!(effective_context_budget(48 * 1024, 1_000_000), 48 * 1024);
        assert_eq!(effective_context_budget(48 * 1024, 2_000), 8_000);
        assert_eq!(effective_output_cap(Some(100), 4_000), Some(100));
        assert_eq!(effective_output_cap(Some(9_000), 4_000), Some(4_000));
    }
}
