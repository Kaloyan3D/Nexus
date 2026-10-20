//! Native model dispatch authorization (A2.3 Phase 3).
//!
//! Independently revalidates Controller authority, Registry issuance, lease
//! currency, witness health, and credential binding at the dispatch
//! boundary, before any network I/O.
//!
//! Scope discipline: A2.3 admits exactly mock-e2e (loopback mock provider).
//! Any other scope is refused with scope-refused. General production
//! dispatch stays disabled: dispatch_enabled() is false and
//! authorize_dispatch() still always refuses.
//!
//! An A2.2 structural attestation is NEVER production authorization here:
//! the grant additionally requires the kernel HMAC seals (V1 issuance, V2
//! extension, published intent), a live lease proof, and an accepted receipt.

use crate::{hmac_seal_hex, Kernel};
use nexus_contracts::{KernelError, KernelErrorCode, KernelResult, RegistryResolutionV1};

/// The only execution scope A2.3 authorizes: loopback mock provider.
pub const SCOPE_MOCK_E2E: &str = "mock-e2e";

/// A5.1 user-initiated, text-only model inference scope. Separately gated
/// (`Kernel::enable_model_only_pilot`, default off), sealed-grant only, and
/// never a tool/effect authority: the grant covers one prepared request's
/// bytes to one sealed endpoint and nothing else. `dispatch_enabled()` and
/// `authorize_dispatch()` are untouched by this scope.
pub const SCOPE_MODEL_ONLY: &str = "model-only";

/// A5.5 user-initiated, read-only agentic repository inspection. One
/// published intent covers exactly ONE provider request (one model turn);
/// the tools its response proposes may afterwards be authorized under the
/// same command, read scope only, against the Controller-committed
/// workspace. Separately gated (`Kernel::enable_repo_inspect_pilot`, default
/// off). It is never a write/process authority.
pub const SCOPE_REPO_INSPECT: &str = "repo-inspect";

/// A5.6 user-initiated, bounded coding workflow in an isolated working copy.
/// One published intent covers exactly ONE provider request, exactly like
/// `repo-inspect`; the tools its response proposes may be authorized under the
/// same command, but write and process tools additionally need an
/// independent, transaction-scoped human approval consumed immediately before
/// their grant is minted. Separately gated (`enable_repo_code_pilot`, default
/// off) and never implied by `repo-inspect`.
pub const SCOPE_REPO_CODE: &str = "repo-code";

/// The only initiator value a `model-only`, `repo-inspect` or `repo-code` intent may carry.
pub const INITIATOR_USER_EXPLICIT: &str = "user-explicit";

/// Durable Controller execution intent bundle reference.
#[derive(Debug, Clone)]
pub struct PublishedIntent {
    /// Command identity (also the store key).
    pub command_id: String,
    /// Canonical bundle bytes as sealed.
    pub canonical_json: String,
}

/// Dispatch authorization request.
#[derive(Debug, Clone)]
pub struct NativeDispatchRequest {
    /// Accepted command identity.
    pub command_id: String,
    /// sha256 of the exact prepared request bytes to be sent.
    pub request_digest: String,
    /// Execution scope (must be mock-e2e in A2.3).
    pub scope: String,
    /// Prepared endpoint origin (must equal the sealed extension origin).
    pub endpoint_origin: String,
    /// Presented credential reference (must equal the sealed extension ref).
    pub credential_ref: String,
}

/// Successful authorization, consumed exactly once.
#[derive(Debug, Clone)]
pub struct NativeDispatchGrant {
    /// Authorized command.
    pub command_id: String,
    /// Authorized attempt.
    pub attempt_id: String,
    /// Authorized request bytes digest.
    pub request_digest: String,
    /// Authorized endpoint origin.
    pub endpoint_origin: String,
    /// Authorized scope.
    pub scope: String,
    /// Grant instant (UTC, audit only).
    pub granted_at_utc: String,
}

pub const GRANT_SEAL_DOMAIN: &str = "nexus-dispatch-grant/v1";

pub const GRANT_TTL_MS: i64 = 300_000;

pub const GRANT_SKEW_MS: i64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq, serde :: Serialize, serde :: Deserialize)]
pub struct SealedNativeDispatchGrant {
    pub command_id: String,
    pub attempt_id: String,
    pub task_instance_id: String,
    pub request_digest: String,
    pub endpoint_origin: String,
    pub scope: String,
    pub target_digest: String,
    pub extension_digest: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    pub credential_ref: String,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub nonce_hex: String,
    pub granted_at_utc: String,
    pub tag_hex: String,
}

fn utc_now() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => [
            d.as_secs().to_string(),
            ".".to_owned(),
            format!("{:09}", d.subsec_nanos()),
            "Z".to_owned(),
        ]
        .concat(),
        Err(_) => "0.000000000Z".to_owned(),
    }
}

fn field_u64(bundle: &serde_json::Value, key: &str) -> KernelResult<u64> {
    bundle.get(key).and_then(|v| v.as_u64()).ok_or_else(|| {
        KernelError::new(
            KernelErrorCode::DeliveryInvalid,
            ["intent field ", key, " is not a u64"].concat(),
        )
    })
}

fn field_str(bundle: &serde_json::Value, key: &str) -> KernelResult<String> {
    bundle
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            KernelError::new(
                KernelErrorCode::DeliveryInvalid,
                ["intent field ", key, " is missing"].concat(),
            )
        })
}

fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

fn nonce_hex() -> String {
    let mut bytes = [0u8; 16];
    let mut filled = false;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read as _;
        if f.read_exact(&mut bytes).is_ok() {
            filled = true;
        }
    }
    if !filled {
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let c = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let t = now_ms() as u64;
        let pid = std::process::id() as u64;
        let mut x =
            t ^ (pid.wrapping_mul(0x9E3779B97F4A7C15)) ^ (c.wrapping_mul(0xBF58476D1CE4E5B9));
        for b in bytes.iter_mut() {
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            x = x.wrapping_mul(0x2545F4914F6CDD1D);
            *b = (x & 0xFF) as u8;
        }
    }
    hex::encode(bytes)
}

fn sealed_grant_canonical(g: &SealedNativeDispatchGrant) -> String {
    let v = serde_json::json!({
        "domain": GRANT_SEAL_DOMAIN,
        "commandId": g.command_id,
        "attemptId": g.attempt_id,
        "taskInstanceId": g.task_instance_id,
        "requestDigest": g.request_digest,
        "endpointOrigin": g.endpoint_origin,
        "scope": g.scope,
        "targetDigest": g.target_digest,
        "extensionDigest": g.extension_digest,
        "leaseEpoch": g.lease_epoch,
        "storeIncarnation": g.store_incarnation,
        "credentialRef": g.credential_ref,
        "issuedAtMs": g.issued_at_ms,
        "expiresAtMs": g.expires_at_ms,
        "nonceHex": g.nonce_hex,
    });
    nexus_contracts::canonical_json(&v)
}

fn sealed_grant_tag(key_hex: &str, g: &SealedNativeDispatchGrant) -> KernelResult<String> {
    crate::hmac_seal_hex(key_hex, &sealed_grant_canonical(g))
}

fn is_loopback_origin(origin: &str) -> bool {
    let after_scheme = match origin.split_once("://") {
        Some(pair) if pair.0 == "http" => pair.1,
        _ => return false,
    };
    let slash = after_scheme.find('/').unwrap_or(after_scheme.len());
    let hostport = after_scheme[..slash].to_owned();
    let colon = hostport.find(':').unwrap_or(hostport.len());
    let host = hostport[..colon].to_owned();
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h.starts_with("127.")
}

/// Origin policy per scope. mock-e2e: loopback http only (unchanged).
/// model-only: loopback http (local test double or local model, no public
/// network) OR https to a syntactically public host; plaintext to any
/// non-loopback host and every private/link-local/metadata address is
/// refused.
fn origin_allowed_for_scope(scope: &str, origin: &str) -> KernelResult<()> {
    if is_loopback_origin(origin) {
        return Ok(());
    }
    if (scope == SCOPE_MODEL_ONLY || scope == SCOPE_REPO_INSPECT || scope == SCOPE_REPO_CODE)
        && nexus_contracts::is_public_https_origin(origin)
    {
        return Ok(());
    }
    Err(KernelError::new(
        KernelErrorCode::ScopeRefused,
        if scope == SCOPE_MODEL_ONLY || scope == SCOPE_REPO_INSPECT || scope == SCOPE_REPO_CODE {
            "model-only, repo-inspect and repo-code scopes require a loopback endpoint or a public https endpoint"
        } else {
            "mock scope requires a loopback-local endpoint"
        },
    ))
}

impl Kernel {
    /// A5.1: enable the model-only pilot scope for this Kernel handle.
    /// Default OFF; only the daemon's explicit `--enable-model-pilot` flag
    /// calls this. It grants no tool, file, process or approval authority.
    pub fn enable_model_only_pilot(&mut self) {
        self.model_only_enabled = true;
    }

    /// True when the model-only pilot scope is enabled on this handle.
    pub fn model_only_pilot_enabled(&self) -> bool {
        self.model_only_enabled
    }

    /// A5.5: enable the repo-inspect pilot scope. Default OFF; only the
    /// daemon's explicit `--enable-repo-inspect` flag calls this (and it is
    /// refused under `production-v1`). It needs the model-only pilot too and
    /// grants read tools only; no write, process or approval authority.
    pub fn enable_repo_inspect_pilot(&mut self) {
        self.repo_inspect_enabled = true;
    }

    pub fn repo_inspect_pilot_enabled(&self) -> bool {
        self.repo_inspect_enabled
    }

    /// A5.6: enable the repo-code pilot scope. Default OFF; only the daemon's
    /// explicit `--enable-repo-code` flag calls this (refused under
    /// `production-v1`). It also requires the model pilot, writes, human
    /// approval and a worktree root at the daemon layer; the Kernel adds no
    /// approval bypass: write/process tools still need a consumed approval.
    pub fn enable_repo_code_pilot(&mut self) {
        self.repo_code_enabled = true;
    }

    pub fn repo_code_pilot_enabled(&self) -> bool {
        self.repo_code_enabled
    }
}

fn scope_admitted(
    pilot_enabled: bool,
    repo_enabled: bool,
    code_enabled: bool,
    scope: &str,
) -> KernelResult<()> {
    match scope {
        SCOPE_MOCK_E2E => Ok(()),
        SCOPE_REPO_CODE if code_enabled && pilot_enabled => Ok(()),
        SCOPE_REPO_CODE => Err(KernelError::new(
            KernelErrorCode::ScopeRefused,
            "repo-code pilot is disabled on this kernel (default off)",
        )),
        SCOPE_REPO_INSPECT if repo_enabled && pilot_enabled => Ok(()),
        SCOPE_REPO_INSPECT => Err(KernelError::new(
            KernelErrorCode::ScopeRefused,
            "repo-inspect pilot is disabled on this kernel (default off)",
        )),
        SCOPE_MODEL_ONLY if pilot_enabled => Ok(()),
        SCOPE_MODEL_ONLY => Err(KernelError::new(
            KernelErrorCode::ScopeRefused,
            "model-only pilot is disabled on this kernel (default off)",
        )),
        _ => Err(KernelError::new(
            KernelErrorCode::ScopeRefused,
            "scope is not authorized; live dispatch refused",
        )),
    }
}

impl Kernel {
    /// EM-02: seal the immutable binding of one task generation. The binding must describe
    /// exactly the task's own sealed issuance and sealed extension (everything but the effort,
    /// with the issuance's effort as its default). First writer wins: re-sealing the identical
    /// binding is idempotent, a different binding for the same task is refused.
    pub fn seal_task_binding(
        &mut self,
        binding: &serde_json::Value,
        issuance_id: &str,
        extension_digest: &str,
    ) -> KernelResult<String> {
        Self::critical(&self.lock_file, &self.in_process, || {
            let parsed: nexus_contracts::TaskBindingV1 = serde_json::from_value(binding.clone())
                .map_err(|_| {
                    KernelError::new(
                        KernelErrorCode::DeliveryInvalid,
                        "task binding does not match TaskBindingV1",
                    )
                })?;
            parsed.validate()?;
            let (issued_json, _) = self.store.fetch_sealed(issuance_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "no sealed issuance for this task binding; seal first",
                )
            })?;
            let (ext_json, _) = self
                .store
                .fetch_extension(extension_digest)?
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "no sealed target extension for this task binding; seal first",
                    )
                })?;
            let issued: RegistryResolutionV1 =
                serde_json::from_str(&issued_json).map_err(|_| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed issuance is not a resolution",
                    )
                })?;
            let ext: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            parsed.matches_task_issuance(&issued, &ext)?;
            let canonical = nexus_contracts::canonical_json(
                &serde_json::to_value(&parsed).unwrap_or(serde_json::Value::Null),
            );
            let digest = nexus_contracts::sha256_hex(&canonical);
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &canonical)?;
            self.store
                .seal_task_binding(&parsed.task_instance_id, &digest, &canonical, &seal)?;
            Ok(digest)
        })
    }
}

impl Kernel {
    /// Seal one Registry-issued V2 extension under its digest identity,
    /// using the issuance key (same trust root as V1 seals). The extension
    /// must be a JSON object; its canonical digest becomes the seal id.
    /// Re-sealing identical bytes is idempotent.
    pub fn seal_extension(&mut self, extension: &serde_json::Value) -> KernelResult<String> {
        Self::critical(&self.lock_file, &self.in_process, || {
            if !extension.is_object() {
                return Err(KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "extension must be a JSON object",
                ));
            }
            let canonical = nexus_contracts::canonical_json(extension);
            let digest = nexus_contracts::sha256_hex(&canonical);
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &canonical)?;
            match self.store.seal_extension(&digest, &canonical, &seal)? {
                nexus_store::SealOutcome::Created | nexus_store::SealOutcome::Identical => {
                    Ok(digest)
                }
            }
        })
    }
    /// Publish one durable Controller execution intent through the
    /// authenticated channel. Referenced V1 issuance and V2 extension seals
    /// must pre-exist; bundle digests must agree with the sealed records;
    /// the lease must equal the current generation. Republishing
    /// byte-identical intent is idempotent.
    pub fn publish_intent(&mut self, bundle: &serde_json::Value) -> KernelResult<PublishedIntent> {
        let pilot = self.model_only_enabled;
        let repo = self.repo_inspect_enabled;
        let code = self.repo_code_enabled;
        Self::critical(&self.lock_file, &self.in_process, || {
            let command_id = field_str(bundle, "commandId")?;
            let task_instance_id = field_str(bundle, "taskInstanceId")?;
            let lease_epoch = field_u64(bundle, "leaseEpoch")?;
            let store_incarnation = field_str(bundle, "storeIncarnation")?;
            let role = field_str(bundle, "role")?;
            let target_digest = field_str(bundle, "targetDigest")?;
            let snapshot_digest = field_str(bundle, "snapshotDigest")?;
            let issuance_id = field_str(bundle, "issuanceId")?;
            let extension_digest = field_str(bundle, "extensionDigest")?;
            let scope = field_str(bundle, "scope")?;
            field_str(bundle, "attemptId")?;
            field_str(bundle, "requestDigest")?;
            field_str(bundle, "sessionId")?;
            scope_admitted(pilot, repo, code, &scope)?;
            if (scope == SCOPE_MODEL_ONLY
                || scope == SCOPE_REPO_INSPECT
                || scope == SCOPE_REPO_CODE)
                && bundle.get("initiator").and_then(|v| v.as_str()) != Some(INITIATOR_USER_EXPLICIT)
            {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "model-only and repo-inspect intents must declare initiator user-explicit",
                ));
            }
            let (issued_json, _seal) = self.store.fetch_sealed(&issuance_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "no sealed issuance for this intent; seal first",
                )
            })?;
            let (ext_json, _ext_seal) =
                self.store
                    .fetch_extension(&extension_digest)?
                    .ok_or_else(|| {
                        KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "no sealed target extension for this intent; seal first",
                        )
                    })?;
            let issued: RegistryResolutionV1 =
                serde_json::from_str(&issued_json).map_err(|_| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed issuance is not a resolution",
                    )
                })?;
            if issued.provenance.target_digest != target_digest
                || issued.provenance.registry_snapshot_digest != snapshot_digest
                || issued.provenance.issuance_id != issuance_id
                || issued.task_instance_id != task_instance_id
                || issued.role != role
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "intent digests disagree with the sealed issuance",
                ));
            }
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            if nexus_contracts::digest_value(&ext_value) != extension_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "sealed extension does not match its digest",
                ));
            }
            if scope == SCOPE_MODEL_ONLY || scope == SCOPE_REPO_INSPECT || scope == SCOPE_REPO_CODE
            {
                let origin = ext_value
                    .get("endpoint")
                    .and_then(|e| e.get("origin"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                origin_allowed_for_scope(&scope, origin)?;
            }
            let ext_remote = ext_value
                .get("remoteModelIdConfirmed")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ext_reasoning = ext_value
                .get("reasoningEffort")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ext_conn = ext_value
                .get("connectionBinding")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if ext_remote != issued.target.remote_model_id
                || ext_reasoning != issued.target.reasoning
                || ext_conn != issued.target.connection_id
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "sealed extension disagrees with the sealed core identity",
                ));
            }
            // EM-02: under a sealed task binding, every attempt's target keeps the task's model,
            // route, provider, connection, endpoint and credential; only a supported effort varies.
            if let Some(binding) = sealed_task_binding(&mut self.store, &task_instance_id)? {
                binding.admits(&issued, &ext_value)?;
            }
            match self.store.current_generation(&task_instance_id, "native")? {
                Some(g) if g.epoch == lease_epoch && g.incarnation == store_incarnation => {}
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "intent lease is not the current generation",
                    ));
                }
            }
            let canonical = nexus_contracts::canonical_json(bundle);
            let key_hex = self.store.issuance_key_hex()?;
            let seal = hmac_seal_hex(&key_hex, &canonical)?;
            match self.store.publish_intent(&command_id, &canonical, &seal)? {
                nexus_store::SealOutcome::Created | nexus_store::SealOutcome::Identical => {
                    Ok(PublishedIntent {
                        command_id,
                        canonical_json: canonical,
                    })
                }
            }
        })
    }

    /// Terminally fence one published intent (Controller cancellation).
    pub fn fence_intent(&mut self, command_id: &str) -> KernelResult<()> {
        Self::critical(&self.lock_file, &self.in_process, || {
            self.store.fence_intent(command_id)
        })
    }
    /// Authorize exactly one native model dispatch after revalidating the
    /// nine dispatch-boundary proofs. Consumes the intent atomically, so a
    /// second authorization for the same command is refused.
    pub fn authorize_native_dispatch(
        &mut self,
        req: &NativeDispatchRequest,
    ) -> KernelResult<NativeDispatchGrant> {
        Self::critical(&self.lock_file, &self.in_process, || {
            if req.scope != SCOPE_MOCK_E2E {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "only the mock-e2e scope is authorized; live dispatch refused",
                ));
            }
            let (stored_json, stored_seal, state) =
                self.store.fetch_intent(&req.command_id)?.ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::IntentUnknown,
                        "no published intent for this command identity",
                    )
                })?;
            match state.as_str() {
                "published" => {}
                "cancelled" => {
                    return Err(KernelError::new(
                        KernelErrorCode::IntentFenced,
                        "intent was fenced; dispatch refused",
                    ));
                }
                "executed" | "redeemed" => {
                    return Err(KernelError::new(
                        KernelErrorCode::CommandConflict,
                        "intent already executed; duplicate dispatch refused",
                    ));
                }
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "intent carries an unknown lifecycle state",
                    ));
                }
            }
            let key_hex = self.store.issuance_key_hex()?;
            let expect_seal = hmac_seal_hex(&key_hex, &stored_json)?;
            if expect_seal != stored_seal {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "published intent seal mismatch; store tampered",
                ));
            }
            let bundle: serde_json::Value = serde_json::from_str(&stored_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent is not JSON",
                )
            })?;
            if field_str(&bundle, "commandId")? != req.command_id {
                return Err(KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent identity drifted",
                ));
            }
            if field_str(&bundle, "requestDigest")? != req.request_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request bytes differ from the published intent",
                ));
            }
            if field_str(&bundle, "scope")? != req.scope {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request scope differs from the published intent",
                ));
            }
            let extension_digest = field_str(&bundle, "extensionDigest")?;
            let (ext_json, _ext_seal) =
                self.store
                    .fetch_extension(&extension_digest)?
                    .ok_or_else(|| {
                        KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "sealed extension lost after publication",
                        )
                    })?;
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            let origin = ext_value
                .get("endpoint")
                .and_then(|e| e.get("origin"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks an endpoint origin",
                    )
                })?;
            if origin != req.endpoint_origin {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "prepared endpoint differs from the sealed extension",
                ));
            }
            if !is_loopback_origin(origin) {
                return Err(KernelError::new(
                    KernelErrorCode::ScopeRefused,
                    "mock scope requires a loopback-local endpoint",
                ));
            }
            let cred = ext_value
                .get("credentialRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks a credential reference",
                    )
                })?;
            if cred != req.credential_ref {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "credential reference differs from the sealed extension",
                ));
            }
            let receipt = self.store.read_receipt(&req.command_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command",
                )
            })?;
            if receipt.target_digest != field_str(&bundle, "targetDigest")?
                || receipt.snapshot_digest != field_str(&bundle, "snapshotDigest")?
                || receipt.issuance_id != field_str(&bundle, "issuanceId")?
                || receipt.lease_epoch != field_u64(&bundle, "leaseEpoch")?
                || receipt.task_instance_id != field_str(&bundle, "taskInstanceId")?
                || receipt.attempt_id != field_str(&bundle, "attemptId")?
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "accepted receipt disagrees with the published intent",
                ));
            }
            let task_id = receipt.task_instance_id.clone();
            let current = self.store.current_generation(&task_id, "native")?;
            let (epoch_now, incarnation_now, protected_now) = match current {
                Some(g) => (g.epoch, g.incarnation, g.witness_protected),
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "generation vanished after acceptance",
                    ));
                }
            };
            if epoch_now != receipt.lease_epoch || incarnation_now != receipt.store_incarnation {
                return Err(KernelError::new(
                    KernelErrorCode::StaleLease,
                    "generation advanced after acceptance; re-acquire first",
                ));
            }
            match self.witness.as_ref() {
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::WitnessRequired,
                        "dispatch needs the independent witness; configure it first",
                    ));
                }
                Some(w) => {
                    let gkey = nexus_contracts::generation_key(&task_id, "native");
                    match w.read(&gkey)? {
                        Some(rec) => {
                            if rec.max_epoch > epoch_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::RollbackDetected,
                                    "store epoch is behind the witness maximum",
                                ));
                            }
                        }
                        None => {
                            if protected_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::ReconciliationRequired,
                                    "witness record lost after protection was established",
                                ));
                            }
                        }
                    }
                }
            }
            self.store.mark_intent_executed(&req.command_id)?;
            Ok(NativeDispatchGrant {
                command_id: req.command_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                request_digest: req.request_digest.clone(),
                endpoint_origin: origin.to_owned(),
                scope: req.scope.clone(),
                granted_at_utc: utc_now(),
            })
        })
    }
}

impl Kernel {
    pub fn authorize_sealed_dispatch(
        &mut self,
        req: &NativeDispatchRequest,
    ) -> KernelResult<SealedNativeDispatchGrant> {
        let pilot = self.model_only_enabled;
        let repo = self.repo_inspect_enabled;
        let code = self.repo_code_enabled;
        Self::critical(&self.lock_file, &self.in_process, || {
            scope_admitted(pilot, repo, code, &req.scope)?;
            let (stored_json, stored_seal, state) =
                self.store.fetch_intent(&req.command_id)?.ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::IntentUnknown,
                        "no published intent for this command identity",
                    )
                })?;
            match state.as_str() {
                "published" => {}
                "cancelled" => {
                    return Err(KernelError::new(
                        KernelErrorCode::IntentFenced,
                        "intent was fenced; dispatch refused",
                    ))
                }
                "executed" | "redeemed" => {
                    return Err(KernelError::new(
                        KernelErrorCode::CommandConflict,
                        "intent already executed; duplicate dispatch refused",
                    ))
                }
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "intent carries an unknown lifecycle state",
                    ))
                }
            }
            let key_hex = self.store.issuance_key_hex()?;
            let expect_seal = hmac_seal_hex(&key_hex, &stored_json)?;
            if expect_seal != stored_seal {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "published intent seal mismatch; store tampered",
                ));
            }
            let bundle: serde_json::Value = serde_json::from_str(&stored_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent is not JSON",
                )
            })?;
            if field_str(&bundle, "commandId")? != req.command_id {
                return Err(KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent identity drifted",
                ));
            }
            if field_str(&bundle, "requestDigest")? != req.request_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request bytes differ from the published intent",
                ));
            }
            if field_str(&bundle, "scope")? != req.scope {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "request scope differs from the published intent",
                ));
            }
            let extension_digest = field_str(&bundle, "extensionDigest")?;
            let target_digest = field_str(&bundle, "targetDigest")?;
            let task_instance_id = field_str(&bundle, "taskInstanceId")?;
            let attempt_id_b = field_str(&bundle, "attemptId")?;
            let lease_epoch_b = field_u64(&bundle, "leaseEpoch")?;
            let _store_incarnation_b = field_str(&bundle, "storeIncarnation")?;
            let (ext_json, _ext_seal) =
                self.store
                    .fetch_extension(&extension_digest)?
                    .ok_or_else(|| {
                        KernelError::new(
                            KernelErrorCode::ForgedIssuer,
                            "sealed extension lost after publication",
                        )
                    })?;
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            let origin = ext_value
                .get("endpoint")
                .and_then(|e| e.get("origin"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks an endpoint origin",
                    )
                })?
                .to_owned();
            if origin != req.endpoint_origin {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "prepared endpoint differs from the sealed extension",
                ));
            }
            origin_allowed_for_scope(&req.scope, &origin)?;
            let cred = ext_value
                .get("credentialRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks a credential reference",
                    )
                })?
                .to_owned();
            if cred != req.credential_ref {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "credential reference differs from the sealed extension",
                ));
            }
            let receipt = self.store.read_receipt(&req.command_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this command",
                )
            })?;
            if receipt.target_digest != target_digest
                || receipt.snapshot_digest != field_str(&bundle, "snapshotDigest")?
                || receipt.issuance_id != field_str(&bundle, "issuanceId")?
                || receipt.lease_epoch != lease_epoch_b
                || receipt.task_instance_id != task_instance_id
                || receipt.attempt_id != attempt_id_b
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "accepted receipt disagrees with the published intent",
                ));
            }
            let task_id = receipt.task_instance_id.clone();
            let current = self.store.current_generation(&task_id, "native")?;
            let (epoch_now, incarnation_now, protected_now) = match current {
                Some(g) => (g.epoch, g.incarnation, g.witness_protected),
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "generation vanished after acceptance",
                    ))
                }
            };
            if epoch_now != receipt.lease_epoch || incarnation_now != receipt.store_incarnation {
                return Err(KernelError::new(
                    KernelErrorCode::StaleLease,
                    "generation advanced after acceptance; re-acquire first",
                ));
            }
            match self.witness.as_ref() {
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::WitnessRequired,
                        "dispatch needs the independent witness; configure it first",
                    ))
                }
                Some(w) => {
                    let gkey = nexus_contracts::generation_key(&task_id, "native");
                    match w.read(&gkey)? {
                        Some(rec) => {
                            if rec.max_epoch > epoch_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::RollbackDetected,
                                    "store epoch is behind the witness maximum",
                                ));
                            }
                        }
                        None => {
                            if protected_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::ReconciliationRequired,
                                    "witness record lost after protection was established",
                                ));
                            }
                        }
                    }
                }
            }
            self.store.mark_intent_executed(&req.command_id)?;
            let issued_at = now_ms();
            let mut grant = SealedNativeDispatchGrant {
                command_id: req.command_id.clone(),
                attempt_id: receipt.attempt_id.clone(),
                task_instance_id: task_id,
                request_digest: req.request_digest.clone(),
                endpoint_origin: origin,
                scope: req.scope.clone(),
                target_digest,
                extension_digest,
                lease_epoch: receipt.lease_epoch,
                store_incarnation: receipt.store_incarnation.clone(),
                credential_ref: cred,
                issued_at_ms: issued_at,
                expires_at_ms: issued_at.saturating_add(GRANT_TTL_MS),
                nonce_hex: nonce_hex(),
                granted_at_utc: utc_now(),
                tag_hex: String::new(),
            };
            let tag = sealed_grant_tag(&key_hex, &grant)?;
            grant.tag_hex = tag;
            Ok(grant)
        })
    }

    pub fn verify_sealed_grant(
        &mut self,
        grant: &SealedNativeDispatchGrant,
        expected_request_digest: &str,
        expected_endpoint_origin: &str,
        expected_credential_ref: &str,
        now_ms_value: i64,
    ) -> KernelResult<NativeDispatchGrant> {
        let pilot = self.model_only_enabled;
        let repo = self.repo_inspect_enabled;
        let code = self.repo_code_enabled;
        Self::critical(&self.lock_file, &self.in_process, || {
            scope_admitted(pilot, repo, code, &grant.scope)?;
            if grant.command_id.is_empty()
                || grant.attempt_id.is_empty()
                || grant.task_instance_id.is_empty()
                || grant.request_digest.is_empty()
                || grant.endpoint_origin.is_empty()
                || grant.target_digest.is_empty()
                || grant.extension_digest.is_empty()
                || grant.store_incarnation.is_empty()
                || grant.credential_ref.is_empty()
                || grant.nonce_hex.is_empty()
                || grant.tag_hex.is_empty()
            {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "grant is incomplete; refusing",
                ));
            }
            if grant.request_digest != expected_request_digest {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant does not cover these request bytes",
                ));
            }
            if grant.endpoint_origin != expected_endpoint_origin {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant does not cover this endpoint",
                ));
            }
            if grant.credential_ref != expected_credential_ref {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant does not cover this credential reference",
                ));
            }
            if now_ms_value > grant.expires_at_ms {
                return Err(KernelError::new(
                    KernelErrorCode::ReservationExpired,
                    "grant has expired; re-authorize",
                ));
            }
            if now_ms_value < grant.issued_at_ms.saturating_sub(GRANT_SKEW_MS) {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "grant issued-at is in the future; refusing",
                ));
            }
            if grant.expires_at_ms != grant.issued_at_ms.saturating_add(GRANT_TTL_MS) {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "grant TTL was tampered; refusing",
                ));
            }
            let key_hex = self.store.issuance_key_hex()?;
            let expect_tag = sealed_grant_tag(&key_hex, grant)?;
            if expect_tag != grant.tag_hex {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "grant tag mismatch; not kernel-issued",
                ));
            }
            let (stored_json, stored_seal, state) =
                self.store.fetch_intent(&grant.command_id)?.ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::IntentUnknown,
                        "no published intent for this grant",
                    )
                })?;
            match state.as_str() {
                "executed" => {}
                "cancelled" => {
                    return Err(KernelError::new(
                        KernelErrorCode::IntentFenced,
                        "intent was fenced; grant is revoked",
                    ))
                }
                "redeemed" => {
                    return Err(KernelError::new(
                        KernelErrorCode::CommandConflict,
                        "grant was already redeemed; a second send is refused",
                    ))
                }
                "published" => {
                    return Err(KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "grant precedes authorization; refusing",
                    ))
                }
                _ => {
                    return Err(KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "intent carries an unknown lifecycle state",
                    ))
                }
            }
            let recomputed_seal = hmac_seal_hex(&key_hex, &stored_json)?;
            if recomputed_seal != stored_seal {
                return Err(KernelError::new(
                    KernelErrorCode::ForgedIssuer,
                    "published intent seal mismatch; store tampered",
                ));
            }
            let bundle: serde_json::Value = serde_json::from_str(&stored_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "published intent is not JSON",
                )
            })?;
            if field_str(&bundle, "commandId")? != grant.command_id
                || field_str(&bundle, "requestDigest")? != grant.request_digest
                || field_str(&bundle, "scope")? != grant.scope
                || field_str(&bundle, "attemptId")? != grant.attempt_id
                || field_str(&bundle, "taskInstanceId")? != grant.task_instance_id
                || field_str(&bundle, "targetDigest")? != grant.target_digest
                || field_str(&bundle, "extensionDigest")? != grant.extension_digest
                || field_u64(&bundle, "leaseEpoch")? != grant.lease_epoch
                || field_str(&bundle, "storeIncarnation")? != grant.store_incarnation
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant disagrees with the published intent",
                ));
            }
            let (ext_json, _ext_seal) = self
                .store
                .fetch_extension(&grant.extension_digest)?
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::ForgedIssuer,
                        "sealed extension lost after authorization",
                    )
                })?;
            let ext_value: serde_json::Value = serde_json::from_str(&ext_json).map_err(|_| {
                KernelError::new(
                    KernelErrorCode::StoreCorrupt,
                    "sealed extension is not JSON",
                )
            })?;
            let origin = ext_value
                .get("endpoint")
                .and_then(|e| e.get("origin"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks an endpoint origin",
                    )
                })?;
            if origin != grant.endpoint_origin {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant endpoint differs from the sealed extension",
                ));
            }
            origin_allowed_for_scope(&grant.scope, origin)?;
            let cred = ext_value
                .get("credentialRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    KernelError::new(
                        KernelErrorCode::StoreCorrupt,
                        "sealed extension lacks a credential reference",
                    )
                })?;
            if cred != grant.credential_ref {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant credential differs from the sealed extension",
                ));
            }
            let receipt = self.store.read_receipt(&grant.command_id)?.ok_or_else(|| {
                KernelError::new(
                    KernelErrorCode::DeliveryInvalid,
                    "no accepted receipt for this grant",
                )
            })?;
            if receipt.attempt_id != grant.attempt_id
                || receipt.task_instance_id != grant.task_instance_id
                || receipt.lease_epoch != grant.lease_epoch
                || receipt.store_incarnation != grant.store_incarnation
                || receipt.target_digest != grant.target_digest
            {
                return Err(KernelError::new(
                    KernelErrorCode::BindingMismatch,
                    "grant disagrees with the accepted receipt",
                ));
            }
            let current = self
                .store
                .current_generation(&grant.task_instance_id, "native")?;
            let (epoch_now, incarnation_now, _protected) = match current {
                Some(g) => (g.epoch, g.incarnation, g.witness_protected),
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::StaleLease,
                        "generation vanished after authorization",
                    ))
                }
            };
            if epoch_now != grant.lease_epoch || incarnation_now != grant.store_incarnation {
                return Err(KernelError::new(
                    KernelErrorCode::StaleLease,
                    "generation advanced after authorization; grant is stale",
                ));
            }
            match self.witness.as_ref() {
                None => {
                    return Err(KernelError::new(
                        KernelErrorCode::WitnessRequired,
                        "dispatch needs the independent witness",
                    ))
                }
                Some(w) => {
                    let gkey = nexus_contracts::generation_key(&grant.task_instance_id, "native");
                    match w.read(&gkey)? {
                        Some(rec) => {
                            if rec.max_epoch > epoch_now {
                                return Err(KernelError::new(
                                    KernelErrorCode::RollbackDetected,
                                    "store epoch is behind the witness maximum",
                                ));
                            }
                        }
                        None => {
                            if _protected {
                                return Err(KernelError::new(
                                    KernelErrorCode::ReconciliationRequired,
                                    "witness record lost after protection was established",
                                ));
                            }
                        }
                    }
                }
            }
            Ok(NativeDispatchGrant {
                command_id: grant.command_id.clone(),
                attempt_id: grant.attempt_id.clone(),
                request_digest: grant.request_digest.clone(),
                endpoint_origin: grant.endpoint_origin.clone(),
                scope: grant.scope.clone(),
                granted_at_utc: grant.granted_at_utc.clone(),
            })
        })
    }
}

impl Kernel {
    /// A5.1: durable cross-process single-use redemption of a sealed grant.
    ///
    /// Performs the full `verify_sealed_grant` checks and then atomically
    /// moves the intent `executed` -> `redeemed` BEFORE the caller may put
    /// bytes on the wire. A second redemption of the same grant (or any
    /// grant for the same command) fails with `command-conflict`, so a
    /// crash after redemption can never lead to an automatic resubmission:
    /// the outcome is uncertain by construction and stays uncertain.
    pub fn redeem_sealed_grant(
        &mut self,
        grant: &SealedNativeDispatchGrant,
        expected_request_digest: &str,
        expected_endpoint_origin: &str,
        expected_credential_ref: &str,
        now_ms_value: i64,
    ) -> KernelResult<NativeDispatchGrant> {
        let verified = self.verify_sealed_grant(
            grant,
            expected_request_digest,
            expected_endpoint_origin,
            expected_credential_ref,
            now_ms_value,
        )?;
        Self::critical(&self.lock_file, &self.in_process, || {
            self.store.mark_intent_redeemed(&grant.command_id)
        })?;
        Ok(verified)
    }
}

/// EM-02: the sealed binding of a task generation, authenticated (seal + digest), if any.
pub(crate) fn sealed_task_binding(
    store: &mut nexus_store::store::Store,
    task_instance_id: &str,
) -> KernelResult<Option<nexus_contracts::TaskBindingV1>> {
    let Some((digest, json, seal)) = store.fetch_task_binding(task_instance_id)? else {
        return Ok(None);
    };
    let key_hex = store.issuance_key_hex()?;
    if hmac_seal_hex(&key_hex, &json)? != seal || nexus_contracts::sha256_hex(&json) != digest {
        return Err(KernelError::new(
            KernelErrorCode::StoreCorrupt,
            "sealed task binding failed authentication; failing closed",
        ));
    }
    let parsed: nexus_contracts::TaskBindingV1 = serde_json::from_str(&json).map_err(|_| {
        KernelError::new(
            KernelErrorCode::StoreCorrupt,
            "sealed task binding is not a TaskBindingV1",
        )
    })?;
    if parsed.task_instance_id != task_instance_id {
        return Err(KernelError::new(
            KernelErrorCode::StoreCorrupt,
            "sealed task binding belongs to another task",
        ));
    }
    Ok(Some(parsed))
}
