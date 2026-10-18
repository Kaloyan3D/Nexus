//! A6.1.4 P4: automatic context management for long coding loops.
//!
//! The provider conversation is stateless: every turn re-sends everything. A real task
//! can run for dozens of turns, so before each request the broker keeps the conversation
//! inside a budget WITHOUT silently changing what the model is told about effects:
//!
//! 1. oversized OLD tool results are replaced by a short stub (the model can re-read);
//! 2. if still over budget, the oldest complete steps (a call and its output together,
//!    never half a pair) are dropped and one note says what the runtime's own receipts
//!    recorded about them (files edited, last command and its verdict).
//!
//! The task message and the most recent steps are never touched.

use nexus_model::request::InputItem;

/// Start compacting beyond this many items or bytes.
pub const COMPACT_ITEMS: usize = 160;
pub const COMPACT_BYTES: usize = 1_200_000;
/// The latest items that are never compacted.
pub const KEEP_TAIL: usize = 36;
/// Old outputs larger than this become stubs.
pub const STUB_ABOVE: usize = 600;

fn size(it: &InputItem) -> usize {
    match it {
        InputItem::Message { content, .. } => content.len(),
        InputItem::FunctionCall {
            arguments, name, ..
        } => arguments.len() + name.len() + 40,
        InputItem::FunctionCallOutput { output, .. } => output.len() + 40,
    }
}

pub fn total_bytes(items: &[InputItem]) -> usize {
    items.iter().map(size).sum()
}

fn over(items: &[InputItem], budget: usize) -> bool {
    items.len() > COMPACT_ITEMS || total_bytes(items) > budget
}

/// Returns true when something was compacted. `receipts` is the runtime's own summary of
/// effects so far (never model text).
pub fn compact(items: &mut Vec<InputItem>, receipts: &str, budget: usize) -> bool {
    if !over(items, budget) || items.len() <= KEEP_TAIL + 1 {
        return false;
    }
    let tail_start = items.len() - KEEP_TAIL;
    let mut changed = false;
    // 1. stub old, large outputs and long old assistant messages (never the task message)
    for it in items.iter_mut().take(tail_start).skip(1) {
        match it {
            InputItem::FunctionCallOutput { output, .. } if output.len() > STUB_ABOVE => {
                *output = format!(
                    "{{\"compacted\":true,\"originalBytes\":{},\"note\":\"an older tool result was omitted to keep the conversation short; call the tool again if you need it\"}}",
                    output.len()
                );
                changed = true;
            }
            InputItem::Message { role, content }
                if role == "assistant" && content.len() > STUB_ABOVE =>
            {
                *content = content.chars().take(240).collect::<String>() + " [shortened]";
                changed = true;
            }
            _ => {}
        }
    }
    if !over(items, budget) {
        return changed;
    }
    // 2. drop the oldest whole steps until within budget, leaving the task and the tail
    let mut note_at: Option<usize> = None;
    while over(items, budget) && items.len() > KEEP_TAIL + 2 {
        let i = if note_at.is_some() { 2 } else { 1 };
        if i >= items.len() - KEEP_TAIL {
            break;
        }
        match items.remove(i) {
            InputItem::FunctionCall { call_id, .. } => {
                if let Some(j) = items
                    .iter()
                    .position(|x| matches!(x, InputItem::FunctionCallOutput { call_id: c, .. } if *c == call_id))
                {
                    items.remove(j);
                }
            }
            InputItem::FunctionCallOutput { call_id, .. } => {
                // an output must never outlive its call: it was removed with its call; a lone
                // output here means its call was already gone - nothing more to do
                let _ = call_id;
            }
            InputItem::Message { .. } => {}
        }
        changed = true;
        if note_at.is_none() {
            items.insert(
                1,
                InputItem::Message {
                    role: "user".into(),
                    content: String::new(),
                },
            );
            note_at = Some(1);
        }
    }
    if let Some(n) = note_at {
        items[n] = InputItem::Message {
            role: "user".into(),
            content: format!(
                "[Nexus note] Earlier steps of this task were removed from the conversation to keep it short. The runtime's own record of what happened so far: {receipts} Re-read files before editing them again."
            ),
        };
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(n: usize, out_len: usize) -> Vec<InputItem> {
        vec![
            InputItem::FunctionCall {
                call_id: format!("c{n}"),
                name: "fs_read".into(),
                arguments: "{\"path\":\"a\"}".into(),
            },
            InputItem::FunctionCallOutput {
                call_id: format!("c{n}"),
                output: "x".repeat(out_len),
            },
        ]
    }

    fn convo(steps: usize, out_len: usize) -> Vec<InputItem> {
        let mut v = vec![InputItem::Message {
            role: "user".into(),
            content: "TASK".into(),
        }];
        for n in 0..steps {
            v.extend(step(n, out_len));
        }
        v
    }

    fn pairs_ok(items: &[InputItem]) -> bool {
        let mut open: Vec<&str> = Vec::new();
        for it in items {
            match it {
                InputItem::FunctionCall { call_id, .. } => open.push(call_id),
                InputItem::FunctionCallOutput { call_id, .. }
                    if !open.contains(&call_id.as_str()) =>
                {
                    return false;
                }
                _ => {}
            }
        }
        true
    }

    #[test]
    fn a_short_conversation_is_never_touched() {
        let mut v = convo(20, 5000);
        let before = v.clone();
        assert!(!compact(&mut v, "r", COMPACT_BYTES));
        assert_eq!(v, before);
    }

    #[test]
    fn big_old_results_become_stubs_first_and_the_tail_and_task_survive() {
        let mut v = convo(120, 30_000); // ~3.6 MB
        let last = v.last().cloned();
        assert!(compact(
            &mut v,
            "edited src/a.rs (applied); last command cargo test: pass.",
            COMPACT_BYTES
        ));
        assert!(
            total_bytes(&v) <= COMPACT_BYTES + 10_000,
            "{}",
            total_bytes(&v)
        );
        assert!(matches!(&v[0], InputItem::Message { content, .. } if content == "TASK"));
        assert_eq!(v.last().cloned(), last, "the latest step is untouched");
        assert!(pairs_ok(&v), "a call and its output stay together");
        // the tail outputs are intact (full size)
        let tail_big = v.iter().rev().take(KEEP_TAIL).filter(|i| matches!(i, InputItem::FunctionCallOutput { output, .. } if output.len() == 30_000)).count();
        assert_eq!(tail_big, KEEP_TAIL / 2);
        let note = v.iter().find_map(|i| match i {
            InputItem::Message { content, .. } if content.contains("[Nexus note]") => {
                Some(content.clone())
            }
            _ => None,
        });
        assert!(
            note.as_deref()
                .is_some_and(|n| n.contains("edited src/a.rs (applied)")),
            "the note carries the runtime's receipts"
        );
    }

    #[test]
    fn many_small_steps_are_trimmed_by_count_and_stay_valid() {
        let mut v = convo(300, 100); // 601 items, tiny bytes
        assert!(compact(&mut v, "r", COMPACT_BYTES));
        assert!(v.len() <= COMPACT_ITEMS + 2, "{}", v.len());
        assert!(pairs_ok(&v));
        assert!(compact(&mut v, "r", COMPACT_BYTES) || v.len() <= COMPACT_ITEMS + 2);
    }
}
