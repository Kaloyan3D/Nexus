//! The Nexus Desktop data contract (A5.3.1).
//!
//! Everything the Desktop shows for a model run comes from here, and these
//! are the SAME functions the Tauri commands call (and the CLI exposes as
//! `nexus intent desktop ...` so the real multi-UID harness can exercise the
//! exact contract as the Desktop's own UID).
//!
//! Model runs started through the broker are read through the broker
//! (`intent-conversation`, `intent-list`, `intent-cancel`): the Desktop
//! identity never needs read access to the issuer-private transcript files.
//! Only when the broker has no such run (an operator-started CLI run in a
//! single-user lab) or is unreachable does a call fall back to the caller's
//! OWN local transcript directory - which, under distinct UIDs, contains
//! nothing of the broker's and therefore reveals nothing.

use crate::config::ClientConfig;
use crate::conversation::conversation;
use crate::error::ClientError;
use crate::intent_client::{self as ic, IntentRun};
use crate::model_run::{
    list_model_conversations as local_list, request_model_cancel,
    status_from_store as local_status, ModelConversationSummary, ModelRunStatus,
    MODEL_CONVERSATION_PREFIX,
};
use nexus_transcript::PageSpec;
use std::path::Path;

fn fall_back(e: &ClientError) -> bool {
    matches!(e.code, "not-found" | "disconnected")
}

/// `ConversationView` JSON for one conversation id.
pub fn conversation_read(
    cfg: &ClientConfig,
    broker: &Path,
    id: &str,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<u32>,
) -> Result<serde_json::Value, ClientError> {
    if id.starts_with(MODEL_CONVERSATION_PREFIX) {
        match ic::conversation(broker, id, after_seq, before_seq, limit) {
            Ok(v) if !v.is_null() => return Ok(v),
            Ok(_) => {}
            Err(e) if fall_back(&e) => {}
            Err(e) => return Err(e),
        }
    }
    let spec = PageSpec {
        after_seq,
        before_seq,
        limit: limit.unwrap_or(200).clamp(1, 500),
    };
    let view = conversation(cfg, id, spec)?;
    serde_json::to_value(view).map_err(|e| ClientError::internal(e.to_string()))
}

fn status_from_run(r: &IntentRun) -> ModelRunStatus {
    ModelRunStatus {
        conversation_id: r.conversation_id.clone().unwrap_or_default(),
        state: r.state.clone(),
        terminal: r.terminal,
        provider_id: r.provider_id.clone(),
        remote_model_id: r.remote_model_id.clone(),
        logical_model_id: r.logical_model_id.clone(),
        endpoint_kind: r.endpoint_kind.clone(),
        attempt_id: r.attempt_id.clone(),
        command_id: r.command_id.clone(),
        request_digest: r.request_digest.clone(),
        http_status: r.http_status,
        usage_input_tokens: r.usage_input_tokens,
        usage_output_tokens: r.usage_output_tokens,
        finish_reason: r.finish_reason.clone(),
        latency_ms: r.latency_ms,
        error_code: r.error_code.clone(),
        cancel_requested: r.cancel_requested,
        // Text is delivered through the conversation view, not duplicated here.
        text: String::new(),
    }
}

pub fn model_run_status(
    cfg: &ClientConfig,
    broker: &Path,
    conversation_id: &str,
) -> Result<ModelRunStatus, ClientError> {
    match ic::run_for_conversation(broker, conversation_id) {
        Ok(Some(r)) => Ok(status_from_run(&r)),
        Ok(None) => local_status(cfg, conversation_id),
        Err(e) if fall_back(&e) => local_status(cfg, conversation_id),
        Err(e) => Err(e),
    }
}

pub fn list_model_conversations(
    cfg: &ClientConfig,
    broker: &Path,
) -> Vec<ModelConversationSummary> {
    let mut out: Vec<ModelConversationSummary> = Vec::new();
    if let Ok(runs) = ic::list(broker, 100) {
        for r in runs {
            if let Some(conv) = r.conversation_id.clone() {
                out.push(ModelConversationSummary {
                    conversation_id: conv,
                    first_prompt: r.prompt_preview.clone().unwrap_or_default(),
                    started_at_ms: Some(r.created_at_ms),
                    state: r.state.clone(),
                    terminal: r.terminal,
                    provider_id: r.provider_id.clone(),
                    remote_model_id: r.remote_model_id.clone(),
                    endpoint_kind: r.endpoint_kind.clone(),
                });
            }
        }
    }
    for l in local_list(cfg) {
        if !out.iter().any(|o| o.conversation_id == l.conversation_id) {
            out.push(l);
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.started_at_ms));
    out.truncate(100);
    out
}

/// Stop a run. Broker runs are cancelled through the broker; otherwise the
/// fail-safe local stop marker is used. It can only STOP, never start.
pub fn cancel_model_run(
    cfg: &ClientConfig,
    broker: &Path,
    conversation_id: &str,
) -> Result<(), ClientError> {
    match ic::run_for_conversation(broker, conversation_id) {
        Ok(Some(run)) => ic::cancel(broker, &run.run_id).map(|_| ()),
        Ok(None) => request_model_cancel(cfg, conversation_id),
        Err(e) if fall_back(&e) => request_model_cancel(cfg, conversation_id),
        Err(e) => Err(e),
    }
}
