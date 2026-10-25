//! Preparation -> authorization -> execution -> recorded result.
//!
//! These are four separate steps with distinct types so that "a request the
//! model asked for" can never be mistaken for "a call the Kernel allowed":
//!
//! * [`prepare`] validates untrusted JSON into typed, digested form and pins
//!   the workspace identity. No workspace content I/O.
//! * [`authorize`] asks the Kernel to seal a grant for exactly that call.
//! * [`execute`] has the Kernel re-verify and journal `started`, only then
//!   touches the workspace, then journals `completed`.

use crate::contract::{
    ToolArgs, ToolBudgets, ToolId, ToolRequestV1, TOOL_CONTRACT_VERSION, TOOL_VERSION,
};
pub use crate::exec::CancellationToken;
use crate::exec::ExecCtx;
use crate::result::{ResultStatus, ToolError, ToolErrorCode, ToolResultV1, ToolStats};
use crate::workspace::{Workspace, WorkspacePolicy, POLICY_VERSION};
use nexus_contracts::sha256_hex;
use nexus_kernel::{
    Kernel, ProcessScopeBinding, SealedToolGrant, ToolAuthorizationRequest, VerifiedToolGrant,
    WorkspaceBinding, WriteScopeBinding,
};
use nexus_store::ToolJournalEntry;

#[derive(Debug)]
pub struct PreparedToolRequest {
    request: ToolRequestV1,
    tool: ToolId,
    args: ToolArgs,
    budgets: ToolBudgets,
    workspace: Workspace,
    args_digest: String,
    budget_digest: String,
    root_digest: String,
    /// A5.5: set only for a model-proposed read call (see `with_ai_origin`).
    ai_origin: Option<String>,
    /// Filesystem scope of a process call, taken from the Kernel-verified process scope by
    /// `prepare_process` (always `Scratch` for every other tool).
    fs_scope: crate::exec_contract::FsScope,
    /// Identity of the standing grant sealed in the process scope (recorded in the journal).
    grant: Option<GrantRef>,
}

/// The standing grant a process call runs under, as sealed by the Kernel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRef {
    pub grant_id: String,
    pub version: u64,
    pub digest: String,
    pub fs: String,
    pub net: String,
    pub approval: String,
}

impl PreparedToolRequest {
    pub fn grant(&self) -> Option<&GrantRef> {
        self.grant.as_ref()
    }

    /// Mark this call as proposed by a model within a repo-inspect command.
    /// The Kernel independently refuses it unless the command's published
    /// intent is `repo-inspect`, its model turn was dispatched, the pilot is
    /// enabled and the tool is read-only.
    pub fn with_ai_origin(mut self, origin: String) -> Self {
        self.ai_origin = Some(origin);
        self
    }

    pub fn fs_scope(&self) -> crate::exec_contract::FsScope {
        self.fs_scope
    }

    pub fn request(&self) -> &ToolRequestV1 {
        &self.request
    }
    pub fn tool(&self) -> ToolId {
        self.tool
    }
    pub fn args_digest(&self) -> &str {
        &self.args_digest
    }
    pub fn budget_digest(&self) -> &str {
        &self.budget_digest
    }
    pub fn budgets(&self) -> &ToolBudgets {
        &self.budgets
    }
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }
    pub fn workspace_root_digest(&self) -> &str {
        &self.root_digest
    }
    fn authorization_request(&self) -> ToolAuthorizationRequest {
        ToolAuthorizationRequest {
            request_id: self.request.request_id.clone(),
            command_id: self.request.command_id.clone(),
            task_instance_id: self.request.task_instance_id.clone(),
            attempt_id: self.request.attempt_id.clone(),
            lease_epoch: self.request.lease_epoch,
            store_incarnation: self.request.store_incarnation.clone(),
            tool_id: self.tool.as_str().to_owned(),
            tool_version: TOOL_VERSION,
            args_digest: self.args_digest.clone(),
            workspace_root_digest: self.root_digest.clone(),
            workspace_root_dev: self.workspace.root_dev(),
            workspace_root_ino: self.workspace.root_ino(),
            budget_digest: self.budget_digest.clone(),
            cancellation_id: self.request.cancellation_id.clone(),
            ai_origin: self.ai_origin.clone(),
        }
    }
}

/// Validate and pin. Performs only open/fstat of the authorized root
/// directory itself.
pub fn prepare(
    request: ToolRequestV1,
    binding: &WorkspaceBinding,
) -> Result<PreparedToolRequest, ToolError> {
    prepare_inner(request, binding, None, false)
}

/// Preparation for sandboxed process execution. Requires the independent
/// process scope; the command is validated by the policy *before* any grant
/// can exist, and the wall-clock budget is capped by the approval.
pub fn prepare_process(
    request: ToolRequestV1,
    binding: &WorkspaceBinding,
    scope: &ProcessScopeBinding,
    policy: &crate::process::CommandPolicy,
) -> Result<PreparedToolRequest, ToolError> {
    if scope.command_id != request.command_id
        || scope.root_digest != binding.root_digest
        || scope.lease_epoch != request.lease_epoch
    {
        return Err(ToolError::new(
            ToolErrorCode::WorkspaceMismatch,
            "process scope does not belong to this request",
        ));
    }
    let tool = ToolId::parse(&request.tool_id);
    if tool != Some(ToolId::ProcRun) {
        return Err(ToolError::new(
            ToolErrorCode::UnsupportedTool,
            "process scope applies only to proc.run",
        ));
    }
    let args = ToolArgs::parse(ToolId::ProcRun, &request.args)?;
    if let ToolArgs::Proc(a) = &args {
        let resolved = policy.resolve(a)?;
        // Standing grant: a command that needs the network must be inside the network axis sealed in
        // the process scope (a scope without a grant keeps the long-standing project-level rule).
        if !scope.grant_id.is_empty() && resolved.install && scope.net_scope != "install" {
            return Err(ToolError::new(
                ToolErrorCode::CommandRefused,
                "installing dependencies needs network access, which this project's permissions do not allow",
            ));
        }
    }
    let fs_scope = match crate::exec_contract::FsScope::parse(&scope.fs_scope) {
        Some(f) if f.is_implemented() => f,
        _ => {
            return Err(ToolError::new(
                ToolErrorCode::SandboxUnavailable,
                "the process scope names a filesystem scope this build does not provide; nothing was run",
            ))
        }
    };
    if fs_scope != crate::exec_contract::FsScope::Scratch && !policy.is_workbench() {
        return Err(ToolError::new(
            ToolErrorCode::CommandRefused,
            "in-place execution is only available with the workbench command policy",
        ));
    }
    let mut p = prepare_inner(request, binding, None, true)?;
    p.fs_scope = fs_scope;
    if !scope.grant_id.is_empty() {
        p.grant = Some(GrantRef {
            grant_id: scope.grant_id.clone(),
            version: scope.grant_version,
            digest: scope.grant_digest.clone(),
            fs: scope.fs_scope.clone(),
            net: scope.net_scope.clone(),
            approval: scope.approval.clone(),
        });
    }
    // Clamp BEFORE the budget digest is sealed.
    p.budgets.proc_wall_ms = p.budgets.proc_wall_ms.min(scope.max_wall_ms).max(1);
    p.budget_digest = p.budgets.digest();
    Ok(p)
}

/// Preparation for mutating tools. Requires the independent write scope;
/// the sealed byte budget can never exceed what the approver allowed.
pub fn prepare_write(
    request: ToolRequestV1,
    binding: &WorkspaceBinding,
    scope: &WriteScopeBinding,
) -> Result<PreparedToolRequest, ToolError> {
    if scope.command_id != request.command_id
        || scope.root_digest != binding.root_digest
        || scope.lease_epoch != request.lease_epoch
    {
        return Err(ToolError::new(
            ToolErrorCode::WorkspaceMismatch,
            "write scope does not belong to this request",
        ));
    }
    prepare_inner(request, binding, Some(scope), false)
}

fn prepare_inner(
    request: ToolRequestV1,
    binding: &WorkspaceBinding,
    scope: Option<&WriteScopeBinding>,
    allow_process: bool,
) -> Result<PreparedToolRequest, ToolError> {
    let inv = |m: &str| ToolError::new(ToolErrorCode::InvalidArguments, m);
    if request.schema_version != TOOL_CONTRACT_VERSION {
        return Err(inv("unsupported tool request schemaVersion"));
    }
    let tool = ToolId::parse(&request.tool_id)
        .ok_or_else(|| ToolError::new(ToolErrorCode::UnsupportedTool, "unknown tool identifier"))?;
    if request.tool_version != TOOL_VERSION {
        return Err(ToolError::new(
            ToolErrorCode::UnsupportedTool,
            "unsupported tool version",
        ));
    }
    for (n, v) in [
        ("requestId", &request.request_id),
        ("cancellationId", &request.cancellation_id),
        ("taskInstanceId", &request.task_instance_id),
        ("attemptId", &request.attempt_id),
        ("commandId", &request.command_id),
        ("storeIncarnation", &request.store_incarnation),
    ] {
        if v.is_empty() {
            return Err(inv(&["missing ", n].concat()));
        }
    }
    if tool.is_process() && !allow_process {
        return Err(ToolError::new(
            ToolErrorCode::AuthorizationRefused,
            "process execution requires an independently approved process scope",
        ));
    }
    match (tool.is_mutating(), scope.is_some()) {
        (true, false) => {
            return Err(ToolError::new(
                ToolErrorCode::AuthorizationRefused,
                "mutating tools require an independently approved write scope",
            ))
        }
        (false, true) => {
            return Err(ToolError::new(
                ToolErrorCode::InvalidArguments,
                "a write scope was supplied for a read-only tool",
            ))
        }
        _ => {}
    }
    let args = ToolArgs::parse(tool, &request.args)?;
    let mut budgets = request.budgets.clamped();
    if let Some(sc) = scope {
        budgets.max_write_bytes = budgets.max_write_bytes.min(sc.max_write_bytes).max(1);
    }
    // The root is taken ONLY from the Controller-sealed binding and must
    // still be the same directory the Controller authorized.
    if binding.command_id != request.command_id
        || binding.task_instance_id != request.task_instance_id
        || binding.attempt_id != request.attempt_id
    {
        return Err(ToolError::new(
            ToolErrorCode::WorkspaceMismatch,
            "workspace binding does not belong to this request",
        ));
    }
    let workspace = Workspace::open_root(&binding.root_path, WorkspacePolicy::default())?;
    let root_digest = sha256_hex(workspace.root_path());
    if workspace.root_dev() != binding.root_dev
        || workspace.root_ino() != binding.root_ino
        || root_digest != binding.root_digest
    {
        return Err(ToolError::new(
            ToolErrorCode::WorkspaceMismatch,
            "workspace root was replaced since Controller authorization",
        ));
    }
    Ok(PreparedToolRequest {
        args_digest: args.digest(),
        budget_digest: budgets.digest(),
        root_digest,
        ai_origin: None,
        fs_scope: crate::exec_contract::FsScope::Scratch,
        grant: None,
        request,
        tool,
        args,
        budgets,
        workspace,
    })
}

#[derive(Debug)]
pub struct AuthorizedToolCall {
    prepared: PreparedToolRequest,
    grant: SealedToolGrant,
}

impl AuthorizedToolCall {
    /// Pair a prepared call with a presented grant. Pairing grants no
    /// authority: `execute` makes the Kernel verify the seal and bindings.
    pub fn from_parts(prepared: PreparedToolRequest, grant: SealedToolGrant) -> Self {
        Self { prepared, grant }
    }
    pub fn grant(&self) -> &SealedToolGrant {
        &self.grant
    }
    pub fn prepared(&self) -> &PreparedToolRequest {
        &self.prepared
    }
}

fn kernel_refusal(e: &nexus_contracts::KernelError) -> ToolError {
    ToolError::new(
        ToolErrorCode::AuthorizationRefused,
        format!(
            "kernel refused tool authority ({}): {}",
            e.code.as_str(),
            e.message
        ),
    )
}

/// Ask the Kernel to seal a grant for this exact prepared call.
pub fn authorize(
    kernel: &mut Kernel,
    prepared: PreparedToolRequest,
) -> Result<AuthorizedToolCall, ToolError> {
    let grant = kernel
        .authorize_tool(&prepared.authorization_request())
        .map_err(|e| kernel_refusal(&e))?;
    Ok(AuthorizedToolCall { prepared, grant })
}

#[derive(Debug, Clone)]
pub struct ToolExecutionOutcome {
    pub result: ToolResultV1,
    pub journal: ToolJournalEntry,
}

/// A call whose grant the Kernel verified and journaled as `started`.
#[derive(Debug)]
pub struct StartedToolCall {
    verified: VerifiedToolGrant,
}

impl StartedToolCall {
    pub fn verified(&self) -> &VerifiedToolGrant {
        &self.verified
    }
}

struct KernelWriteHooks<'a> {
    kernel: &'a mut Kernel,
    verified: &'a VerifiedToolGrant,
    last: Option<nexus_store::ToolJournalEntry>,
}

impl crate::write::WriteHooks for KernelWriteHooks<'_> {
    fn journal(&mut self, phase: &str, payload: serde_json::Value) -> Result<(), ToolError> {
        let e = self
            .kernel
            .record_write_phase(self.verified, phase, payload)
            .map_err(|e| kernel_refusal(&e))?;
        self.last = Some(e);
        Ok(())
    }
    fn fence(&mut self) -> Result<(), ToolError> {
        self.kernel
            .check_tool_fence_for(self.verified.grant())
            .map_err(|e| {
                ToolError::new(
                    ToolErrorCode::Revoked,
                    format!("authority revoked ({})", e.code.as_str()),
                )
            })
    }
}

/// Drive a started write call through the lifecycle on the given hooks.
pub fn run_write_call(
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
    hooks: &mut dyn crate::write::WriteHooks,
) -> Result<ToolResultV1, ToolError> {
    let p = &call.prepared;
    crate::write::run_write(
        &p.workspace,
        &p.args,
        &p.budgets,
        &call.grant.execution_id,
        cancel,
        hooks,
    )
}

/// In-process composition for trusted callers (tests, offline harness).
pub fn execute_write(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
) -> Result<ToolExecutionOutcome, ToolError> {
    let started = begin(kernel, call, cancel)?;
    let mut hooks = KernelWriteHooks {
        kernel,
        verified: &started.verified,
        last: None,
    };
    let result = run_write_call(call, cancel, &mut hooks)?;
    let journal = hooks.last.ok_or_else(|| {
        ToolError::new(ToolErrorCode::IoError, "write produced no journal record")
    })?;
    Ok(ToolExecutionOutcome { result, journal })
}

/// Startup reconciliation for write requests that have `planned` but no
/// terminal record. Observes each target (never modifies it, never
/// replays), removes abandoned temp files, and records `interrupted` with
/// the explicit observed state.
pub fn reconcile_writes(kernel: &mut Kernel) -> Result<u64, ToolError> {
    let open = kernel.open_writes().map_err(|e| kernel_refusal(&e))?;
    let mut observations: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for ow in open {
        let obs = match kernel.workspace_binding(&ow.command_id) {
            Ok(Some(b)) => match Workspace::open_root(&b.root_path, WorkspacePolicy::default()) {
                Ok(ws) => crate::write::observe_for_recovery(
                    &ws,
                    &ow.planned,
                    &ow.prepared.clone().unwrap_or_default(),
                ),
                Err(_) => serde_json::json!({"observed": "unobservable", "mutation": "uncertain",
                    "reason": "workspace unavailable at recovery"}),
            },
            _ => serde_json::json!({"observed": "unobservable", "mutation": "uncertain",
                "reason": "workspace binding unavailable at recovery"}),
        };
        observations.insert(ow.request_id.clone(), obs);
    }
    kernel
        .reconcile_open_writes(&mut |ow| {
            observations.remove(&ow.request_id).unwrap_or_else(
                || serde_json::json!({"observed": "unobservable", "mutation": "uncertain"}),
            )
        })
        .map_err(|e| kernel_refusal(&e))
}

fn local_bindings_ok(
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
) -> Result<(), ToolError> {
    let p = &call.prepared;
    let g = &call.grant;
    let mismatch = g.request_id != p.request.request_id
        || g.tool_id != p.tool.as_str()
        || g.tool_version != TOOL_VERSION
        || g.workspace_root_digest != p.root_digest
        || g.workspace_root_dev != p.workspace.root_dev()
        || g.workspace_root_ino != p.workspace.root_ino()
        || g.cancellation_id != p.request.cancellation_id
        || g.task_instance_id != p.request.task_instance_id
        || g.attempt_id != p.request.attempt_id
        || g.command_id != p.request.command_id
        || g.lease_epoch != p.request.lease_epoch;
    if mismatch {
        return Err(ToolError::new(
            ToolErrorCode::WorkspaceMismatch,
            "grant does not describe this prepared call",
        ));
    }
    if cancel.id() != g.cancellation_id {
        return Err(ToolError::new(
            ToolErrorCode::AuthorizationRefused,
            "cancellation identity differs from the authorized identity",
        ));
    }
    if cancel.is_cancelled() {
        return Err(ToolError::new(
            ToolErrorCode::Cancelled,
            "cancelled before start; nothing executed",
        ));
    }
    Ok(())
}

/// Step 1: verify and journal `started`. Nothing on the workspace is
/// touched by this step.
pub fn begin(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
) -> Result<StartedToolCall, ToolError> {
    local_bindings_ok(call, cancel)?;
    let verified = kernel
        .begin_tool_execution(
            &call.grant,
            &call.prepared.args_digest,
            &call.prepared.budget_digest,
        )
        .map_err(|e| kernel_refusal(&e))?;
    Ok(StartedToolCall { verified })
}

/// Step 2: run the tool. `probe` is the authoritative fence check, called
/// at bounded intervals (<= 20 ms) during long operations in addition to
/// the caller's cancellation token.
pub fn run_started(
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
    probe: &mut dyn FnMut() -> Result<(), ToolError>,
) -> ToolResultV1 {
    let p = &call.prepared;
    let mut ctx = ExecCtx::new(&p.workspace, p.budgets.clone(), cancel).with_probe(probe);
    let outcome = run_tool(&mut ctx, &p.args);
    let tool_id = p.tool.as_str();
    match outcome {
        Ok(output) => {
            let stats = std::mem::take(&mut ctx.stats);
            let trunc = std::mem::take(&mut ctx.truncation);
            let red = std::mem::take(&mut ctx.redaction);
            ToolResultV1::success(tool_id, TOOL_VERSION, output, trunc, red, stats)
        }
        Err(e) => {
            let stats: ToolStats = std::mem::take(&mut ctx.stats);
            ToolResultV1::failure(tool_id, TOOL_VERSION, e, stats)
        }
    }
}

/// Step 3: journal `completed` with the redacted record.
pub fn finish(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    started: &StartedToolCall,
    result: ToolResultV1,
) -> Result<ToolExecutionOutcome, ToolError> {
    let p = &call.prepared;
    let g = &call.grant;
    let record = serde_json::json!({
        "toolId": p.tool.as_str(),
        "toolVersion": TOOL_VERSION,
        "args": p.args.journal_meta(),
        "resultStatus": match result.status {
            ResultStatus::Ok => "ok",
            ResultStatus::Truncated => "truncated",
            ResultStatus::Error => "error",
        },
        "errorCode": result.error.as_ref().map(|e| e.code.as_str()),
        "truncation": result.truncation,
        "redaction": result.redaction,
        "stats": result.stats,
        "outputDigest": result.output_digest,
        "outputBytes": result.output_bytes,
        "provenance": {
            "executor": "nexus-tools",
            "contractVersion": TOOL_CONTRACT_VERSION,
            "policyVersion": POLICY_VERSION,
            "authority": "kernel-sealed-grant",
            "workspaceRootDigest": p.root_digest,
            "leaseEpoch": g.lease_epoch,
            "aiInitiated": p.ai_origin.is_some(),
        },
    });
    let journal = kernel
        .complete_tool_execution(&started.verified, record)
        .map_err(|e| kernel_refusal(&e))?;
    Ok(ToolExecutionOutcome { result, journal })
}

/// Convenience composition for in-process trusted callers (tests,
/// offline harness). The daemon uses the three steps separately so it
/// never holds the Kernel lock during a long scan.
pub fn execute(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
) -> Result<ToolExecutionOutcome, ToolError> {
    let started = begin(kernel, call, cancel)?;
    let result = {
        let k: &Kernel = kernel;
        let v = &started.verified;
        let mut probe = || {
            k.check_tool_fence(v).map_err(|e| {
                ToolError::new(
                    ToolErrorCode::Revoked,
                    format!("authority revoked mid-execution ({})", e.code.as_str()),
                )
            })
        };
        run_started(call, cancel, &mut probe)
    };
    finish(kernel, call, &started, result)
}

fn run_tool(ctx: &mut ExecCtx<'_>, args: &ToolArgs) -> Result<serde_json::Value, ToolError> {
    match args {
        ToolArgs::List(a) => crate::list::run(ctx, a),
        ToolArgs::Read(a) => crate::read::run(ctx, a),
        ToolArgs::Search(a) => crate::search::run(ctx, a),
        ToolArgs::Write(_) | ToolArgs::Edit(_) => Err(ToolError::new(
            ToolErrorCode::UnsupportedTool,
            "mutating tools run only through the write lifecycle",
        )),
        ToolArgs::Proc(_) => Err(ToolError::new(
            ToolErrorCode::UnsupportedTool,
            "process execution runs only through the sandbox lifecycle",
        )),
    }
}

// ------------------------------------------------------------ A3.4

struct KernelProcessHooks<'a> {
    kernel: &'a mut Kernel,
    verified: &'a VerifiedToolGrant,
    last: Option<nexus_store::ToolJournalEntry>,
}

impl crate::process::ProcessHooks for KernelProcessHooks<'_> {
    fn journal(&mut self, phase: &str, payload: serde_json::Value) -> Result<(), ToolError> {
        let e = self
            .kernel
            .record_process_phase(self.verified, phase, payload)
            .map_err(|e| kernel_refusal(&e))?;
        self.last = Some(e);
        Ok(())
    }
    fn fence(&mut self) -> Result<(), ToolError> {
        self.kernel
            .check_tool_fence_for(self.verified.grant())
            .map_err(|e| {
                ToolError::new(
                    ToolErrorCode::Revoked,
                    format!("authority revoked ({})", e.code.as_str()),
                )
            })
    }
}

/// Run a started process call through the sandbox lifecycle on the given
/// hooks (the daemon passes hooks that lock the Kernel only briefly).
pub fn run_process_call(
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
    policy: &crate::process::CommandPolicy,
    run_root: &std::path::Path,
    scope_max_wall_ms: u64,
    env: Option<&crate::process::ProjectEnv>,
    hooks: &mut dyn crate::process::ProcessHooks,
) -> Result<ToolResultV1, ToolError> {
    let p = &call.prepared;
    let ToolArgs::Proc(args) = &p.args else {
        return Err(ToolError::new(
            ToolErrorCode::UnsupportedTool,
            "not a process call",
        ));
    };
    let ctx = crate::process::ProcessContext {
        ws: &p.workspace,
        env,
        run_root,
        execution_id: &call.grant.execution_id,
        policy,
        budgets: &p.budgets,
        scope_max_wall_ms,
        fs_scope: p.fs_scope,
        grant: p.grant.as_ref(),
        task_instance_id: &p.request.task_instance_id,
        command_id: &p.request.command_id,
    };
    crate::process::run_process(&ctx, args, cancel, hooks)
}

/// In-process composition (tests, offline harness).
pub fn execute_process(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
    policy: &crate::process::CommandPolicy,
    run_root: &std::path::Path,
    scope_max_wall_ms: u64,
) -> Result<ToolExecutionOutcome, ToolError> {
    execute_process_in(
        kernel,
        call,
        cancel,
        policy,
        run_root,
        scope_max_wall_ms,
        None,
    )
}

/// `execute_process` inside a project-scoped environment (workbench policy).
pub fn execute_process_in(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
    policy: &crate::process::CommandPolicy,
    run_root: &std::path::Path,
    scope_max_wall_ms: u64,
    env: Option<&crate::process::ProjectEnv>,
) -> Result<ToolExecutionOutcome, ToolError> {
    let started = begin(kernel, call, cancel)?;
    let mut hooks = KernelProcessHooks {
        kernel,
        verified: &started.verified,
        last: None,
    };
    let result = run_process_call(
        call,
        cancel,
        policy,
        run_root,
        scope_max_wall_ms,
        env,
        &mut hooks,
    )?;
    let journal = hooks.last.ok_or_else(|| {
        ToolError::new(ToolErrorCode::IoError, "process produced no journal record")
    })?;
    Ok(ToolExecutionOutcome { result, journal })
}

/// Startup reconciliation for process requests with `prepared` and no
/// terminal record: kill any leftover cgroup, remove run directories, and
/// record `interrupted`. Never restarts a process.
pub fn reconcile_processes(kernel: &mut Kernel) -> Result<u64, ToolError> {
    let open = kernel.open_processes().map_err(|e| kernel_refusal(&e))?;
    let mut obs: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for op in open {
        obs.insert(
            op.request_id.clone(),
            crate::process::observe_process_for_recovery(
                &op.prepared,
                op.running.as_ref(),
                (&op.execution_id, &op.task_instance_id, &op.command_id),
            ),
        );
    }
    kernel
        .reconcile_open_processes(&mut |op| {
            obs.remove(&op.request_id).unwrap_or_else(
                || serde_json::json!({"reason": "no terminal record", "outcome": "uncertain"}),
            )
        })
        .map_err(|e| kernel_refusal(&e))
}
