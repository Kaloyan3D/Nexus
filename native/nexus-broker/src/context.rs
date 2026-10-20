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
/// The transport refuses more than 480 input items; this leaves room for the next turns.
/// (It used to be 160: far below any model's window, it made a long task forget what it had
/// read every few turns and re-read the same files for hundreds of turns.)
pub const COMPACT_ITEMS: usize = 440;
pub const COMPACT_BYTES: usize = 1_200_000;
/// The latest items that are never compacted.
pub const KEEP_TAIL: usize = 36;
/// Old outputs larger than this become stubs.
pub const STUB_ABOVE: usize = 600;

fn size(it: &InputItem) -> usize {
    match it {
        InputItem::Message { content, .. } | InputItem::AssistantPhase { content, .. } => {
            content.len()
        }
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

/// When the conversation reaches this many items the model is asked to write its own
/// working memory (see `inspect.rs`), BEFORE the oldest steps are dropped.
pub const SUMMARY_AT_ITEMS: usize = 330;
pub const SUMMARY_AT_BYTES: usize = 800_000;
pub const MEMORY_MAX_CHARS: usize = 12_000;

pub const MEMORY_PROMPT: &str = "[Nexus] This conversation is about to be shortened to save context. Before that, write your WORKING MEMORY as plain text and make NO tool call in this reply. Include: (1) the task as you understand it and what counts as done; (2) the facts you learned that you will need again - exact file paths, function and type names, line numbers, signatures, how the test harness is set up - dense enough that you will not have to re-read those files except to edit them; (3) every change made so far (files) and every command run with its result; (4) decisions taken and why; (5) the exact next steps, in order. Be concrete and compact (under 6000 characters).";

/// Does the conversation need its working memory written now?
pub fn wants_memory(items: &[InputItem], budget: usize) -> bool {
    items.len() >= SUMMARY_AT_ITEMS || total_bytes(items) >= SUMMARY_AT_BYTES.min(budget / 2)
}

/// Replace everything between the task message and the most recent steps with the model's own
/// working memory (a user message) - the understanding survives, the raw tool output does not.
/// The memory request (last item) is removed. Never splits a call from its output.
pub fn fold_into_memory(items: &mut Vec<InputItem>, memory: &str, receipts: &str) -> bool {
    if matches!(items.last(), Some(InputItem::Message { role, content }) if role == "user" && content.starts_with("[Nexus] This conversation is about to be shortened"))
    {
        items.pop();
    }
    if items.len() <= KEEP_TAIL + 2 {
        return false;
    }
    let mut cut = items.len() - KEEP_TAIL;
    while cut > 1 && matches!(items[cut], InputItem::FunctionCallOutput { .. }) {
        cut -= 1;
    }
    if cut <= 1 {
        return false;
    }
    items.drain(1..cut);
    let mem: String = memory.chars().take(MEMORY_MAX_CHARS).collect();
    items.insert(
        1,
        InputItem::Message {
            role: "user".into(),
            content: format!(
                "[Nexus] Your working memory (written by you just before the earlier steps were removed from this conversation). Continue from its next steps; do not re-read what it already states, re-read a file only to edit it.\n\n{mem}\n\n[Nexus] The runtime's own record of what happened so far: {receipts} Re-read files before editing them again."
            ),
        },
    );
    true
}

/// Returns true when something was compacted. `receipts` is the runtime's own summary of
/// effects so far (never model text).
pub fn compact(items: &mut Vec<InputItem>, receipts: &str, budget: usize) -> bool {
    if !over(items, budget) || items.len() <= KEEP_TAIL + 1 {
        return false;
    }
    let tail_start = items.len() - KEEP_TAIL;
    let mut changed = false;
    // 1. stub old, large outputs and long old assistant messages (never the task message) -
    //    OLDEST FIRST and only as many as the byte budget requires. (Stubbing everything older
    //    than the tail at once left the model a working memory of twelve turns.) A conversation
    //    that is over only by item count gains nothing from stubbing: step 2 handles it.
    if total_bytes(items) > budget {
        for i in 1..tail_start {
            match &mut items[i] {
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
                InputItem::AssistantPhase { content, .. } if content.len() > STUB_ABOVE => {
                    *content = content.chars().take(240).collect::<String>() + " [shortened]";
                    changed = true;
                }
                _ => continue,
            }
            if total_bytes(items) <= budget {
                break;
            }
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
            InputItem::Message { .. } | InputItem::AssistantPhase { .. } => {}
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

    fn steps(n: usize) -> Vec<InputItem> {
        let mut v = vec![InputItem::Message {
            role: "user".into(),
            content: "task".into(),
        }];
        for i in 0..n {
            v.push(InputItem::Message {
                role: "assistant".into(),
                content: format!("a{i}"),
            });
            v.push(InputItem::FunctionCall {
                call_id: format!("c{i}"),
                name: "fs_read".into(),
                arguments: "{}".into(),
            });
            v.push(InputItem::FunctionCallOutput {
                call_id: format!("c{i}"),
                output: "x".repeat(900),
            });
        }
        v
    }

    #[test]
    fn the_models_working_memory_replaces_old_steps_without_splitting_a_call_from_its_output() {
        let mut v = steps(130);
        assert!(wants_memory(&v, COMPACT_BYTES));
        v.push(InputItem::Message {
            role: "user".into(),
            content: MEMORY_PROMPT.into(),
        });
        assert!(fold_into_memory(
            &mut v,
            "MEM: engine.ts:967 is the turn check",
            "files changed: none;"
        ));
        assert!(v.len() <= KEEP_TAIL + 4, "{}", v.len());
        assert!(matches!(&v[0], InputItem::Message { content, .. } if content == "task"));
        assert!(
            matches!(&v[1], InputItem::Message { content, .. } if content.contains("MEM: engine.ts:967"))
        );
        // every output still has its call right before it
        for (i, it) in v.iter().enumerate() {
            if let InputItem::FunctionCallOutput { call_id, .. } = it {
                assert!(
                    matches!(&v[i - 1], InputItem::FunctionCall { call_id: c, .. } if c == call_id),
                    "{i}"
                );
            }
        }
        // the memory request itself is gone
        assert!(!v.iter().any(|i| matches!(i, InputItem::Message { content, .. } if content.starts_with("[Nexus] This conversation is about to be shortened"))));
        // a short conversation is left alone
        let mut short = steps(5);
        assert!(!wants_memory(&short, COMPACT_BYTES));
        assert!(!fold_into_memory(&mut short, "m", "r"));
    }

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
    fn old_results_are_stubbed_oldest_first_and_only_as_far_as_the_budget_requires() {
        // 3.6 MB; a 2.4 MB budget needs only the oldest ~40% stubbed: the newer old results stay
        let mut v = convo(120, 30_000);
        let last = v.last().cloned();
        let budget = 2_400_000;
        assert!(compact(&mut v, "r", budget));
        assert!(total_bytes(&v) <= budget + 5_000, "{}", total_bytes(&v));
        assert!(matches!(&v[0], InputItem::Message { content, .. } if content == "TASK"));
        assert_eq!(v.last().cloned(), last, "the latest step is untouched");
        assert!(pairs_ok(&v), "a call and its output stay together");
        let stubbed: Vec<usize> = v
            .iter()
            .enumerate()
            .filter(|(_, i)| matches!(i, InputItem::FunctionCallOutput { output, .. } if output.contains("\"compacted\":true")))
            .map(|(k, _)| k)
            .collect();
        let intact_old = v
            .iter()
            .enumerate()
            .take(v.len() - KEEP_TAIL)
            .filter(|(_, i)| matches!(i, InputItem::FunctionCallOutput { output, .. } if output.len() == 30_000))
            .count();
        assert!(
            !stubbed.is_empty() && intact_old > 20,
            "stubbed {} intact-old {}",
            stubbed.len(),
            intact_old
        );
        // every stub is older than every intact old result
        let first_intact = v
            .iter()
            .position(|i| matches!(i, InputItem::FunctionCallOutput { output, .. } if output.len() == 30_000))
            .unwrap();
        assert!(stubbed.iter().all(|k| *k < first_intact));
    }

    #[test]
    fn when_stubbing_is_not_enough_whole_old_steps_go_and_the_note_carries_the_receipts() {
        let mut v = convo(120, 30_000);
        let last = v.last().cloned();
        assert!(compact(
            &mut v,
            "edited src/a.rs (applied); last command cargo test: pass.",
            300_000
        ));
        assert!(matches!(&v[0], InputItem::Message { content, .. } if content == "TASK"));
        assert_eq!(v.last().cloned(), last);
        assert!(pairs_ok(&v));
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
