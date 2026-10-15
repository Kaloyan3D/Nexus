//! Explicit offline/test harness.
//!
//! This is NOT Controller-authorized execution. It builds a throwaway
//! Kernel in a private temp directory, accepts a synthetic command there,
//! and runs one read-only tool through the same prepare -> authorize ->
//! execute path production uses. The ephemeral store is deleted on return
//! and shares nothing with the daemon store, so it confers no authority over
//! any real task. Every report is labelled `offline-test`.

use crate::{authorize, execute, prepare, CancellationToken, ToolBudgets, ToolRequestV1};
use nexus_contracts::{
    ControllerIntentV1, ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1,
    CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::{AcceptRequest, Kernel};

pub const OFFLINE_ENV_GATE: &str = "NEXUS_TOOLS_OFFLINE_TEST";
/// Second, separate gate for mutating tools.
pub const OFFLINE_WRITE_ENV_GATE: &str = "NEXUS_TOOLS_OFFLINE_WRITE_TEST";
/// A workspace must contain this marker to be mutated offline.
pub const OFFLINE_WRITE_MARKER: &str = ".nexus-offline-write-test";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineReport {
    pub authority: &'static str,
    pub controller_authorized: bool,
    pub ai_initiated: bool,
    pub result: crate::ToolResultV1,
    pub journal_phases: Vec<String>,
    pub journal_verified_entries: u64,
}

fn scratch_dir() -> Result<std::path::PathBuf, String> {
    use std::io::Read as _;
    let mut b = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| format!("entropy unavailable: {e}"))?;
    let dir = std::env::temp_dir().join(format!("nexus-tools-offline-{}", hex(&b)));
    std::fs::create_dir_all(&dir).map_err(|e| format!("scratch dir: {e}"))?;
    Ok(dir)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Run one tool against `workspace` under an ephemeral Kernel.
pub fn run_offline(
    workspace: &str,
    tool_id: &str,
    args: serde_json::Value,
    budgets: ToolBudgets,
) -> Result<OfflineReport, String> {
    run_offline_opts(workspace, tool_id, args, budgets, false)
}

/// Offline harness with an explicit mutation switch. Mutating tools need
/// ALL of: `allow_write`, `NEXUS_TOOLS_OFFLINE_WRITE_TEST=1`, a workspace
/// beneath the system temp directory, and the marker file in the
/// workspace root. The throwaway Kernel plays both issuer and approver, so
/// the report states the write scope is NOT independent.
pub fn run_offline_opts(
    workspace: &str,
    tool_id: &str,
    args: serde_json::Value,
    budgets: ToolBudgets,
    allow_write: bool,
) -> Result<OfflineReport, String> {
    let mutating = crate::ToolId::parse(tool_id)
        .map(|t| t.is_mutating())
        .unwrap_or(false);
    if mutating {
        if !allow_write {
            return Err("mutating tools need the explicit --allow-write-test flag".to_owned());
        }
        if std::env::var(OFFLINE_WRITE_ENV_GATE).as_deref() != Ok("1") {
            return Err(format!(
                "offline write execution is gated: set {OFFLINE_WRITE_ENV_GATE}=1 (isolated temp workspaces only)"
            ));
        }
        let canon = std::fs::canonicalize(workspace).map_err(|e| e.to_string())?;
        let tmp = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
        if !canon.starts_with(&tmp) || canon == tmp {
            return Err(
                "offline writes are limited to a workspace beneath the system temp directory"
                    .to_owned(),
            );
        }
        if !canon.join(OFFLINE_WRITE_MARKER).is_file() {
            return Err(format!(
                "offline writes require the marker file {OFFLINE_WRITE_MARKER} in the workspace root"
            ));
        }
    }
    if std::env::var(OFFLINE_ENV_GATE).as_deref() != Ok("1") {
        return Err(format!(
            "offline tool execution is gated: set {OFFLINE_ENV_GATE}=1 (test use only; not Controller-authorized)"
        ));
    }
    let dir = scratch_dir()?;
    let result = run_in(&dir, workspace, tool_id, args, budgets, mutating);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn run_in(
    dir: &std::path::Path,
    workspace: &str,
    tool_id: &str,
    args: serde_json::Value,
    budgets: ToolBudgets,
    mutating: bool,
) -> Result<OfflineReport, String> {
    let kerr = |e: nexus_contracts::KernelError| e.to_string();
    let mut kernel = Kernel::open(&dir.join("k.db"), Some(&dir.join("w.db"))).map_err(kerr)?;
    let task = "offline-task";
    let attempt = "offline-attempt";
    let command = "offline-command";
    let lease = kernel.acquire_generation(task, "native").map_err(kerr)?;
    let rev = serde_json::json!(1);
    let intent = ControllerIntentV1::build(
        task,
        attempt,
        command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        rev.clone(),
        serde_json::json!({"op": "offline-tool-test", "workspaceRootDigest": nexus_contracts::sha256_hex(
            std::fs::canonicalize(workspace).map_err(|e| e.to_string())?.to_str().unwrap_or_default()
        )}),
    )
    .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snapshot = serde_json::json!({"schemaVersion": 1, "tag": "offline-tools", "modes": []});
    let target = ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", rev.clone());
    let tv = serde_json::to_value(&target).map_err(|e| e.to_string())?;
    let mut issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target,
        provenance: RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "offline".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: rev,
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    kernel.seal_issuance(&issued).map_err(kerr)?;
    kernel
        .accept_command(&AcceptRequest {
            intent,
            issued,
            snapshot,
        })
        .map_err(kerr)?;
    let req = ToolRequestV1 {
        schema_version: crate::TOOL_CONTRACT_VERSION,
        request_id: "offline-request-1".into(),
        cancellation_id: "offline-cancel-1".into(),
        task_instance_id: task.into(),
        attempt_id: attempt.into(),
        command_id: command.into(),
        lease_epoch: lease.lease_epoch,
        store_incarnation: lease.store_incarnation.clone(),
        tool_id: tool_id.into(),
        tool_version: crate::TOOL_VERSION,
        args,
        budgets,
    };
    let cancel = CancellationToken::new(&req.cancellation_id);
    // Offline: the ephemeral Controller stand-in binds exactly the
    // operator-named directory (allowed base == the workspace itself).
    let binding = kernel
        .bind_workspace(command, workspace, &[std::path::PathBuf::from(workspace)])
        .map_err(kerr)?;
    let outcome = if mutating {
        let scope = kernel
            .bind_write_scope(
                command,
                "offline-test-self",
                false,
                &binding.root_digest,
                1 << 20,
            )
            .map_err(kerr)?;
        let prepared = crate::prepare_write(req, &binding, &scope).map_err(|e| e.to_string())?;
        let call = authorize(&mut kernel, prepared).map_err(|e| e.to_string())?;
        crate::execute_write(&mut kernel, &call, &cancel).map_err(|e| e.to_string())?
    } else {
        let prepared = prepare(req, &binding).map_err(|e| e.to_string())?;
        let call = authorize(&mut kernel, prepared).map_err(|e| e.to_string())?;
        execute(&mut kernel, &call, &cancel).map_err(|e| e.to_string())?
    };
    let phases = kernel
        .list_tool_journal(None)
        .map_err(kerr)?
        .into_iter()
        .map(|e| e.phase)
        .collect();
    let verified = kernel.verify_tool_journal().map_err(kerr)?;
    Ok(OfflineReport {
        authority: if mutating {
            "offline-test (ephemeral kernel; write scope SELF-approved, NOT independent; NOT Controller-authorized)"
        } else {
            "offline-test (ephemeral kernel; NOT Controller-authorized)"
        },
        controller_authorized: false,
        ai_initiated: false,
        result: outcome.result,
        journal_phases: phases,
        journal_verified_entries: verified,
    })
}
