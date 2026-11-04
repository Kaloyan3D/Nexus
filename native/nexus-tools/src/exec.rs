//! Shared execution context: budgets, cancellation, deadline, stats.

use crate::contract::ToolBudgets;
use crate::redact::Redaction;
use crate::result::{ToolError, ToolErrorCode, ToolStats, Truncation};
use crate::workspace::Workspace;
use std::cell::{Cell, RefCell};
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
    /// Authoritative fence probe (Kernel lease/generation/revocation).
    /// Independent of the caller-controlled cancellation token.
    probe: RefCell<Option<&'a mut (dyn FnMut() -> Result<(), ToolError> + 'a)>>,
    last_probe: Cell<Option<Instant>>,
}

/// Upper bound between authoritative fence probes during long scans.
pub const PROBE_INTERVAL: Duration = Duration::from_millis(20);

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
            probe: RefCell::new(None),
            last_probe: Cell::new(None),
        }
    }

    pub fn with_probe(self, probe: &'a mut (dyn FnMut() -> Result<(), ToolError> + 'a)) -> Self {
        *self.probe.borrow_mut() = Some(probe);
        self
    }

    pub fn check_cancel(&self) -> Result<(), ToolError> {
        if self.cancel.is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "execution cancelled",
            ));
        }
        let due = match self.last_probe.get() {
            None => true,
            Some(t) => t.elapsed() >= PROBE_INTERVAL,
        };
        if due {
            self.last_probe.set(Some(Instant::now()));
            if let Some(p) = self.probe.borrow_mut().as_mut() {
                (p)()?;
            }
        }
        Ok(())
    }

    pub fn deadline_exceeded(&self) -> bool {
        Instant::now() >= self.deadline
    }
}
