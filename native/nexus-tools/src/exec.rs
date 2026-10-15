//! Shared execution context: budgets, cancellation, deadline, stats.

use crate::contract::ToolBudgets;
use crate::redact::Redaction;
use crate::result::{ToolError, ToolErrorCode, ToolStats, Truncation};
use crate::workspace::Workspace;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Cooperative cancellation bound to a cancellation identity. The identity
/// is sealed into the Kernel grant; a token with a different identity can
/// never cancel (or be mistaken for) the authorized execution.
#[derive(Debug, Clone)]
pub struct CancellationToken {
    id: String,
    flag: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            flag: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

pub struct ExecCtx<'a> {
    pub ws: &'a Workspace,
    pub budgets: ToolBudgets,
    pub cancel: &'a CancellationToken,
    pub stats: ToolStats,
    pub truncation: Truncation,
    pub redaction: Redaction,
    deadline: Instant,
}

impl<'a> ExecCtx<'a> {
    pub fn new(ws: &'a Workspace, budgets: ToolBudgets, cancel: &'a CancellationToken) -> Self {
        let deadline = Instant::now() + Duration::from_millis(budgets.deadline_ms);
        Self {
            ws,
            budgets,
            cancel,
            stats: ToolStats::default(),
            truncation: Truncation::default(),
            redaction: Redaction::default(),
            deadline,
        }
    }

    pub fn check_cancel(&self) -> Result<(), ToolError> {
        if self.cancel.is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "execution cancelled",
            ));
        }
        Ok(())
    }

    pub fn deadline_exceeded(&self) -> bool {
        Instant::now() >= self.deadline
    }
}
