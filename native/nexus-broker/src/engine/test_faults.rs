//! TEST-ONLY fault injection for EM-03 recovery tests (feature `test-engines`; absent from
//! production builds). A test arms a fault for ONE run, identified by its intent idempotency key,
//! so parallel tests never interfere (no environment variables).
//!
//! * `crash(run, point)` panics at a transaction boundary: the run's worker unwinds without any
//!   further write (the pipeline turns the panic into a terminal `internal-panic`), so the durable
//!   engine state is exactly what was committed before `point`, as after a process crash.
//! * `fail_persist(task)` makes every engine state commit of that task fail.

use std::collections::HashMap;
use std::sync::Mutex;

static ARMED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static TASKS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with<T>(
    m: &Mutex<Option<HashMap<String, String>>>,
    f: impl FnOnce(&mut HashMap<String, String>) -> T,
) -> T {
    let mut g = m.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/// Arm `point` for the run whose intent carries `idempotency_key` (first hit).
pub fn arm(idempotency_key: &str, point: &str) {
    arm_nth(idempotency_key, point, 1);
}

/// Arm `point` to fire on its `nth` hit (1-based) in that run.
pub fn arm_nth(idempotency_key: &str, point: &str, nth: u32) {
    with(&ARMED, |a| {
        a.insert(idempotency_key.to_owned(), format!("{point}#{nth}"))
    });
}

/// Associate a run with its task generation (called by the broker when the task exists).
pub fn bind(idempotency_key: &str, task_instance_id: &str) {
    with(&TASKS, |t| {
        t.insert(task_instance_id.to_owned(), idempotency_key.to_owned())
    });
}

/// Panic here if `point` is armed for this run and this is its armed hit (fires once).
pub fn crash(idempotency_key: &str, point: &str) {
    let hit = with(&ARMED, |a| {
        let Some(v) = a.get(idempotency_key).cloned() else {
            return false;
        };
        let Some((p, n)) = v.split_once('#') else {
            return false;
        };
        if p != point {
            return false;
        }
        let n: u32 = n.parse().unwrap_or(1);
        if n <= 1 {
            a.remove(idempotency_key);
            true
        } else {
            a.insert(idempotency_key.to_owned(), format!("{p}#{}", n - 1));
            false
        }
    });
    if hit {
        panic!("[injected crash at {point}]");
    }
}

/// Whether `point` is armed (without consuming it) for the run that owns `task`.
pub fn armed_for_task(task_instance_id: &str, point: &str) -> bool {
    let Some(key) = with(&TASKS, |t| t.get(task_instance_id).cloned()) else {
        return false;
    };
    with(&ARMED, |a| {
        a.get(&key)
            .is_some_and(|v| v.split_once('#').map(|x| x.0) == Some(point))
    })
}

/// Whether engine state commits of `task` must fail (armed point `persist`).
pub fn fail_persist(task_instance_id: &str) -> bool {
    let Some(key) = with(&TASKS, |t| t.get(task_instance_id).cloned()) else {
        return false;
    };
    with(&ARMED, |a| {
        a.get(&key).is_some_and(|v| v.starts_with("persist#"))
    })
}
