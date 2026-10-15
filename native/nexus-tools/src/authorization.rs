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
use nexus_kernel::{Kernel, SealedToolGrant, ToolAuthorizationRequest};
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
}

impl PreparedToolRequest {
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
        }
    }
}

/// Validate and pin. Performs only open/fstat of the authorized root
/// directory itself.
pub fn prepare(request: ToolRequestV1) -> Result<PreparedToolRequest, ToolError> {
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
    let args = ToolArgs::parse(tool, &request.args)?;
    let budgets = request.budgets.clamped();
    let workspace = Workspace::open_root(&request.workspace_root, WorkspacePolicy::default())?;
    let root_digest = sha256_hex(workspace.root_path());
    Ok(PreparedToolRequest {
        args_digest: args.digest(),
        budget_digest: budgets.digest(),
        root_digest,
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

fn run_tool(ctx: &mut ExecCtx<'_>, args: &ToolArgs) -> Result<serde_json::Value, ToolError> {
    match args {
        ToolArgs::List(a) => crate::list::run(ctx, a),
        ToolArgs::Read(a) => crate::read::run(ctx, a),
        ToolArgs::Search(a) => crate::search::run(ctx, a),
    }
}

/// Execute an authorized call. Every refusal path returns before any
/// workspace content access (the workspace access counter stays 0).
pub fn execute(
    kernel: &mut Kernel,
    call: &AuthorizedToolCall,
    cancel: &CancellationToken,
) -> Result<ToolExecutionOutcome, ToolError> {
    let p = &call.prepared;
    let g = &call.grant;
    // Cheap local bindings first: grant must describe *this* prepared call.
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
    let verified = kernel
        .begin_tool_execution(g, &p.args_digest, &p.budget_digest)
        .map_err(|e| kernel_refusal(&e))?;

    let mut ctx = ExecCtx::new(&p.workspace, p.budgets.clone(), cancel);
    let outcome = run_tool(&mut ctx, &p.args);
    let tool_id = p.tool.as_str();
    let result = match outcome {
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
    };
    let record = serde_json::json!({
        "toolId": tool_id,
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
            "aiInitiated": false,
        },
    });
    let journal = kernel
        .complete_tool_execution(&verified, record)
        .map_err(|e| kernel_refusal(&e))?;
    Ok(ToolExecutionOutcome { result, journal })
}
