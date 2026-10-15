#![allow(dead_code)]
use nexus_contracts::{
    ControllerIntentV1, ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1,
    CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::{AcceptRequest, Kernel, WorkspaceBinding, WriteScopeBinding};
use nexus_tools::{
    authorize, execute, prepare, AuthorizedToolCall, CancellationToken, ToolBudgets, ToolError,
    ToolExecutionOutcome, ToolRequestV1, TOOL_CONTRACT_VERSION, TOOL_VERSION,
};
use std::path::{Path, PathBuf};

static BINDINGS: std::sync::Mutex<Vec<WorkspaceBinding>> = std::sync::Mutex::new(Vec::new());

/// Look up the Controller binding the fixture published for this request's
/// command (or take it from the child-process environment).
pub fn prepare_b(r: ToolRequestV1) -> Result<nexus_tools::PreparedToolRequest, ToolError> {
    let b = {
        let g = BINDINGS.lock().unwrap();
        g.iter().find(|b| b.command_id == r.command_id).cloned()
    }
    .or_else(|| {
        std::env::var("AUDIT_BINDING")
            .ok()
            .and_then(|j| serde_json::from_str(&j).ok())
    })
    .expect("binding for command");
    prepare(r, &b)
}

pub struct Fx {
    pub kernel: Kernel,
    pub dir: tempfile::TempDir,
    pub db: PathBuf,
    pub witness: PathBuf,
    /// Authorized workspace (canonical path).
    pub ws: PathBuf,
    /// Sibling directory outside the workspace holding secrets.
    pub outside: PathBuf,
    pub task: String,
    pub attempt: String,
    pub command: String,
    pub epoch: u64,
    pub incarnation: String,
    next: u32,
    pub base: PathBuf,
}

pub const OUTSIDE_SECRET: &str = "OUTSIDE-SECRET-MARKER-9f31";

fn make_issued(
    kernel: &mut Kernel,
    task: &str,
    snapshot: &serde_json::Value,
) -> RegistryResolutionV1 {
    let rev = serde_json::json!(3);
    let target = ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", rev.clone());
    let tv = serde_json::to_value(&target).unwrap();
    let mut issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target,
        provenance: RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(snapshot),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: rev,
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    kernel.seal_issuance(&issued).unwrap();
    issued
}

pub fn fixture(tag: &str) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let ws = base.join("workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), format!("{OUTSIDE_SECRET}\n")).unwrap();
    let db = base.join(format!("{tag}.db"));
    let witness = base.join(format!("{tag}.witness.db"));
    let mut kernel = Kernel::open(&db, Some(&witness)).unwrap();
    let task = format!("task-{tag}");
    let attempt = "attempt-1".to_owned();
    let command = format!("cmd-{tag}");
    let lease = kernel.acquire_generation(&task, "native").unwrap();
    let intent = ControllerIntentV1::build(
        &task,
        &attempt,
        &command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        serde_json::json!(3),
        serde_json::json!({"op": "engineer-turn", "workspaceRootDigest": nexus_contracts::sha256_hex(ws.to_str().unwrap())}),
    )
    .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snapshot = serde_json::json!({"schemaVersion": 1, "tag": "tools-fixture", "modes": []});
    let issued = make_issued(&mut kernel, &task, &snapshot);
    kernel
        .accept_command(&AcceptRequest {
            intent,
            issued,
            snapshot,
        })
        .unwrap();
    // Controller publishes the workspace authority for this command.
    let binding = kernel
        .bind_workspace(&command, ws.to_str().unwrap(), std::slice::from_ref(&base))
        .unwrap();
    BINDINGS.lock().unwrap().push(binding);
    Fx {
        kernel,
        dir,
        db,
        witness,
        ws,
        outside,
        task,
        attempt,
        command,
        epoch: lease.lease_epoch,
        incarnation: lease.store_incarnation,
        next: 0,
        base,
    }
}

impl Fx {
    pub fn write(&self, rel: &str, content: &[u8]) {
        let p = self.ws.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    pub fn request(&mut self, tool: &str, args: serde_json::Value) -> ToolRequestV1 {
        self.next += 1;
        ToolRequestV1 {
            schema_version: TOOL_CONTRACT_VERSION,
            request_id: format!("req-{}-{}", self.command, self.next),
            cancellation_id: format!("cancel-{}-{}", self.command, self.next),
            task_instance_id: self.task.clone(),
            attempt_id: self.attempt.clone(),
            command_id: self.command.clone(),
            lease_epoch: self.epoch,
            store_incarnation: self.incarnation.clone(),
            tool_id: tool.to_owned(),
            tool_version: TOOL_VERSION,
            args,
            budgets: ToolBudgets::default(),
        }
    }

    /// prepare + authorize + execute (the full trusted path).
    pub fn run(
        &mut self,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<ToolExecutionOutcome, ToolError> {
        let r = self.request(tool, args);
        self.run_request(r)
    }

    /// Independent approver grants write scope for this command's workspace.
    pub fn approve_write(&mut self, max_bytes: u64) -> WriteScopeBinding {
        let root = self.binding().root_digest;
        self.kernel
            .bind_write_scope(
                &self.command.clone(),
                "test-approver",
                false,
                &root,
                max_bytes,
            )
            .unwrap()
    }

    pub fn scope(&mut self) -> WriteScopeBinding {
        self.kernel
            .write_scope_binding(&self.command.clone())
            .unwrap()
            .expect("write scope")
    }

    pub fn prepare_w(
        &mut self,
        r: ToolRequestV1,
    ) -> Result<nexus_tools::PreparedToolRequest, ToolError> {
        let b = self.binding();
        let sc = self.scope();
        nexus_tools::prepare_write(r, &b, &sc)
    }

    /// prepare_write + authorize + execute_write (trusted full path).
    pub fn run_write(
        &mut self,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<ToolExecutionOutcome, ToolError> {
        let r = self.request(tool, args);
        let cancel = CancellationToken::new(&r.cancellation_id);
        let p = self.prepare_w(r)?;
        let call = authorize(&mut self.kernel, p)?;
        nexus_tools::execute_write(&mut self.kernel, &call, &cancel)
    }

    pub fn disk(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.ws.join(rel)).ok()
    }

    pub fn tmp_leftovers(&self) -> Vec<String> {
        let mut v = Vec::new();
        for e in std::fs::read_dir(&self.ws).unwrap().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with(".nexus-tmp-") {
                v.push(n);
            }
        }
        v
    }

    pub fn binding(&mut self) -> WorkspaceBinding {
        self.kernel
            .workspace_binding(&self.command)
            .unwrap()
            .expect("binding")
    }

    pub fn prepare_req(
        &mut self,
        r: ToolRequestV1,
    ) -> Result<nexus_tools::PreparedToolRequest, ToolError> {
        let b = self.binding();
        prepare(r, &b)
    }

    pub fn run_request(&mut self, r: ToolRequestV1) -> Result<ToolExecutionOutcome, ToolError> {
        let cancel = CancellationToken::new(&r.cancellation_id);
        let p = self.prepare_req(r)?;
        let call = authorize(&mut self.kernel, p)?;
        execute(&mut self.kernel, &call, &cancel)
    }

    pub fn authorized(
        &mut self,
        tool: &str,
        args: serde_json::Value,
    ) -> (AuthorizedToolCall, CancellationToken) {
        let r = self.request(tool, args);
        let cancel = CancellationToken::new(&r.cancellation_id);
        let p = self.prepare_req(r).unwrap();
        (authorize(&mut self.kernel, p).unwrap(), cancel)
    }

    pub fn journal_phases(&self) -> Vec<String> {
        self.kernel
            .list_tool_journal(None)
            .unwrap()
            .into_iter()
            .map(|e| e.phase)
            .collect()
    }
}

pub fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

pub fn err_code(r: &Result<ToolExecutionOutcome, ToolError>) -> String {
    match r {
        Ok(o) => match &o.result.error {
            Some(e) => e.code.as_str().to_owned(),
            None => "ok".to_owned(),
        },
        Err(e) => e.code.as_str().to_owned(),
    }
}
