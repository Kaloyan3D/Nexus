//! EM-04A RequestBudgetV1: an exact byte budget for ONE serialized provider request.
//!
//! The context manager (`context.rs`) bounds the conversation with an approximation and never
//! touches its newest 36 items. That is the right policy for working memory, but it says nothing
//! about the bytes that actually go on the wire: A614's long loop reaches 449,944 B with a
//! 300,000 B conversation budget because the protected tail alone is ~430 KB. A mode that adds
//! request content (the future Muse signals tool: 2,882 B) needs a bound on the REAL request.
//!
//! This module is that bound. It is measured, not estimated:
//! * the caller passes the exact length of the request `nexus_model::prepare` serialized;
//! * every input item is sized with `nexus_model::prepare::responses_input_item_bytes`, the same
//!   canonical serialization `prepare` uses, so `fixed overhead = total - items - separators` is
//!   exact (model, tool schemas, reasoning effort, stream/limit fields);
//! * the caller re-prepares after a reduction and checks the real length again (authoritative).
//!
//! Reductions happen only at boundaries that keep the request valid, oldest first, and only as
//! far as the limit requires:
//! 1. a replayed `reasoning` item is dropped WHOLE (never edited; encrypted content stays intact
//!    in every item that remains) - never one of the latest response;
//! 2. an old tool result is replaced by the same valid JSON stub the context manager writes (its
//!    `function_call` stays, so call and result remain paired); an old assistant message is
//!    shortened at a character boundary and keeps its provider phase label.
//!
//! Never touched: every user message (the task, guidance, working memory, runtime notes - the
//! instructions and authorization-relevant content), every `function_call` (its arguments are the
//! model's request), and the latest step (the latest response's reasoning, text and calls, and
//! the results that answer them). If the request still does not fit, nothing is sent: the run fails
//! with `request-budget-exceeded`. On failure the conversation is left exactly as it was.
//!
//! Without a configured budget (`BrokerConfig::request_budget_bytes = None`, every production
//! configuration in EM-04A) this module is never called and requests are byte-identical to EM-03.

use crate::context::{shortened, stub_output, STUB_ABOVE};
use nexus_model::prepare::responses_input_item_bytes;
use nexus_model::request::InputItem;

/// Version of this budget contract.
pub const REQUEST_BUDGET_VERSION: u32 = 1;

/// The ceiling for one request and the bytes held back inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestBudget {
    /// Ceiling of the serialized request (bytes on the wire).
    pub target_bytes: usize,
    /// Bytes reserved for content the mode adds outside the conversation (measured, e.g. a
    /// mode-scoped tool schema). The conversation may use `target_bytes - reserve_bytes`.
    pub reserve_bytes: usize,
}

impl RequestBudget {
    /// The bound the prepared request must meet, or `None` if the reserve alone exceeds the target
    /// (a configuration that can never fit: fail closed).
    pub fn limit(&self) -> Option<usize> {
        self.target_bytes.checked_sub(self.reserve_bytes)
    }
}

/// What a fit did (all byte values exact).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetReport {
    pub request_bytes_before: usize,
    pub request_bytes_after: usize,
    /// Everything that is not an input item: model, tools, effort, stream and limit fields.
    /// Measured only when a reduction was needed (`None` = the request fit as prepared, so
    /// nothing beyond its exact length was computed).
    pub fixed_overhead_bytes: Option<usize>,
    pub reasoning_dropped: u32,
    pub outputs_stubbed: u32,
    pub messages_shortened: u32,
}

impl BudgetReport {
    pub fn changed(&self) -> bool {
        self.reasoning_dropped + self.outputs_stubbed + self.messages_shortened > 0
    }
}

/// The request cannot be brought under the limit at a safe boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetExceeded {
    /// The smallest request the safe reductions could reach.
    pub smallest_bytes: usize,
    pub limit: usize,
    pub fixed_overhead_bytes: usize,
}

impl BudgetExceeded {
    pub fn message(&self) -> String {
        format!(
            "the next model request needs at least {} bytes but the request budget allows {} ({} of them are fixed request content: model, tool definitions, settings); nothing was sent",
            self.smallest_bytes, self.limit, self.fixed_overhead_bytes
        )
    }
}

/// Exact wire bytes of the `input` array's items plus their separators.
pub fn items_bytes(items: &[InputItem]) -> usize {
    items.iter().map(responses_input_item_bytes).sum::<usize>() + items.len().saturating_sub(1)
}

/// Exact bytes of a prepared request that are not conversation items.
pub fn fixed_overhead(items: &[InputItem], request_bytes: usize) -> usize {
    request_bytes.saturating_sub(items_bytes(items))
}

/// First index of the latest step: the latest response's reasoning, text and calls, the results
/// answering them and any user message after them. Everything from here on is never reduced.
pub fn latest_step_start(items: &[InputItem]) -> usize {
    let mut i = items.len();
    while i > 0 && is_result_or_user(&items[i - 1]) {
        i -= 1;
    }
    while i > 0 && is_model_item(&items[i - 1]) {
        i -= 1;
    }
    i.max(1)
}

fn is_result_or_user(it: &InputItem) -> bool {
    match it {
        InputItem::FunctionCallOutput { .. } => true,
        InputItem::Message { role, .. } => role == "user",
        _ => false,
    }
}

/// An item of a model response (replayed): reasoning, text or a call.
fn is_model_item(it: &InputItem) -> bool {
    match it {
        InputItem::FunctionCall { .. }
        | InputItem::AssistantPhase { .. }
        | InputItem::Reasoning { .. } => true,
        InputItem::Message { role, .. } => role == "assistant",
        InputItem::FunctionCallOutput { .. } => false,
    }
}

/// Bring the conversation under `limit` given the exact length of its prepared request. Returns
/// the report (with the predicted exact length, which the caller re-checks by preparing again) or
/// `BudgetExceeded` with the conversation unchanged.
pub fn fit(
    items: &mut Vec<InputItem>,
    request_bytes: usize,
    limit: usize,
) -> Result<BudgetReport, BudgetExceeded> {
    let mut report = BudgetReport {
        request_bytes_before: request_bytes,
        request_bytes_after: request_bytes,
        ..Default::default()
    };
    // the exact prepared length decides; a request that fits costs nothing more
    if request_bytes <= limit {
        return Ok(report);
    }
    let fixed = fixed_overhead(items, request_bytes);
    report.fixed_overhead_bytes = Some(fixed);
    let mut work = items.clone();
    let mut total = request_bytes;
    // 1. older replayed reasoning, whole items, oldest first
    let mut i = 1;
    while total > limit && i < latest_step_start(&work) {
        if matches!(work[i], InputItem::Reasoning { .. }) {
            total -= responses_input_item_bytes(&work[i]) + 1;
            work.remove(i);
            report.reasoning_dropped += 1;
        } else {
            i += 1;
        }
    }
    // 2. older tool results and assistant messages, oldest first, at their item boundary
    let protected = latest_step_start(&work);
    let mut i = 1;
    while total > limit && i < protected {
        let before = responses_input_item_bytes(&work[i]);
        let reduced = match &mut work[i] {
            InputItem::FunctionCallOutput { output, .. }
                if output.len() > STUB_ABOVE && !is_stub(output) =>
            {
                *output = stub_output(output.len());
                report.outputs_stubbed += 1;
                true
            }
            InputItem::Message { role, content }
                if role == "assistant" && content.len() > STUB_ABOVE =>
            {
                *content = shortened(content);
                report.messages_shortened += 1;
                true
            }
            InputItem::AssistantPhase { content, .. } if content.len() > STUB_ABOVE => {
                *content = shortened(content);
                report.messages_shortened += 1;
                true
            }
            _ => false,
        };
        if reduced {
            let after = responses_input_item_bytes(&work[i]);
            total = total - before + after;
        }
        i += 1;
    }
    if total > limit {
        return Err(BudgetExceeded {
            smallest_bytes: total,
            limit,
            fixed_overhead_bytes: fixed,
        });
    }
    report.request_bytes_after = total;
    *items = work;
    Ok(report)
}

fn is_stub(output: &str) -> bool {
    output.starts_with("{\"compacted\":true,")
}

/// Every `function_call_output` follows its own `function_call` (the protocol invariant the
/// reductions must keep).
pub fn pairs_intact(items: &[InputItem]) -> bool {
    let mut open: Vec<&str> = Vec::new();
    for it in items {
        match it {
            InputItem::FunctionCall { call_id, .. } => open.push(call_id),
            InputItem::FunctionCallOutput { call_id, .. } if !open.contains(&call_id.as_str()) => {
                return false
            }
            _ => {}
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(t: &str) -> InputItem {
        InputItem::Message {
            role: "user".into(),
            content: t.into(),
        }
    }
    fn reasoning(n: usize, pad: usize) -> InputItem {
        let v = serde_json::json!({
            "type": "reasoning", "id": format!("rs_{n}"),
            "encrypted_content": "e".repeat(pad), "summary": [],
        });
        InputItem::Reasoning {
            item: nexus_contracts::canonical_json(&v),
        }
    }
    fn call(n: usize) -> InputItem {
        InputItem::FunctionCall {
            call_id: format!("c{n}"),
            name: "fs_read".into(),
            arguments: format!("{{\"path\":\"f{n}.txt\"}}"),
        }
    }
    fn out(n: usize, body: &str) -> InputItem {
        InputItem::FunctionCallOutput {
            call_id: format!("c{n}"),
            output: body.into(),
        }
    }
    fn phase(t: &str) -> InputItem {
        InputItem::AssistantPhase {
            phase: "commentary".into(),
            content: t.into(),
        }
    }

    /// A long conversation: task, then `steps` steps of reasoning + commentary + call + result.
    fn convo(steps: usize, result: &str) -> Vec<InputItem> {
        let mut v = vec![user("TASK: read everything")];
        for n in 0..steps {
            v.push(reasoning(n, 300));
            v.push(phase(&format!("reading f{n}")));
            v.push(call(n));
            v.push(out(n, result));
        }
        v
    }

    /// The exact request length for these items with a fixed overhead (as `prepare` would give).
    fn wire(items: &[InputItem], overhead: usize) -> usize {
        overhead + items_bytes(items)
    }

    /// Ground truth: serialize the items exactly as the request's `input` array and measure it.
    fn real_items_bytes(items: &[InputItem]) -> usize {
        let arr: Vec<serde_json::Value> = items
            .iter()
            .map(nexus_model::prepare::responses_input_item)
            .collect();
        nexus_contracts::canonical_json(&serde_json::Value::Array(arr)).len() - 2
    }

    #[test]
    fn item_sizes_are_the_exact_wire_bytes_including_multibyte_and_escapes() {
        let tricky = "naïve 日本語 🚀 \"quoted\" \\ back\nslash \u{0007} tab\t";
        let v = vec![
            user(tricky),
            reasoning(1, 10),
            phase(tricky),
            call(1),
            out(1, tricky),
            InputItem::Message {
                role: "assistant".into(),
                content: tricky.into(),
            },
        ];
        assert_eq!(items_bytes(&v), real_items_bytes(&v));
        // multibyte: wire bytes, not chars
        assert!(items_bytes(&v[..1]) > tricky.chars().count());
    }

    #[test]
    fn a_request_at_the_limit_is_untouched_and_one_byte_over_is_reduced_exactly() {
        let mut v = convo(30, &"r".repeat(5_000));
        let overhead = 12_345;
        let total = wire(&v, overhead);
        let before = v.clone();
        // exactly at the limit: nothing changes
        let r = fit(&mut v, total, total).unwrap();
        assert!(!r.changed());
        assert_eq!(v, before);
        assert_eq!(
            r.fixed_overhead_bytes, None,
            "nothing measured when it fits"
        );
        assert_eq!(fixed_overhead(&v, total), overhead);
        // one byte over: the smallest reduction that fits, and the prediction is exact
        let r = fit(&mut v, total, total - 1).unwrap();
        assert!(r.changed());
        assert_eq!(r.fixed_overhead_bytes, Some(overhead));
        assert_eq!(r.request_bytes_after, wire(&v, overhead));
        assert!(r.request_bytes_after < total);
        // one old reasoning item (the oldest) was enough
        assert_eq!(r.reasoning_dropped, 1);
        assert_eq!(r.outputs_stubbed, 0);
        assert!(!v
            .iter()
            .any(|i| matches!(i, InputItem::Reasoning { item } if item.contains("rs_0\""))));
    }

    #[test]
    fn crossing_the_boundary_step_by_step_is_monotonic_and_always_exact() {
        let base = convo(20, &"x".repeat(3_000));
        let overhead = 9_000;
        let total = wire(&base, overhead);
        let mut last_after = total;
        for cut in [0, 1, 500, 5_000, 20_000, 40_000, 60_000] {
            let mut v = base.clone();
            match fit(&mut v, total, total - cut) {
                Ok(r) => {
                    assert_eq!(r.request_bytes_after, wire(&v, overhead), "cut {cut}");
                    assert!(r.request_bytes_after <= total - cut);
                    assert!(r.request_bytes_after <= last_after);
                    last_after = r.request_bytes_after;
                    assert!(pairs_intact(&v));
                }
                Err(e) => panic!("cut {cut}: {e:?}"),
            }
        }
    }

    #[test]
    fn long_tool_results_are_stubbed_oldest_first_as_valid_json_and_calls_stay_paired() {
        let mut v = convo(12, &"y".repeat(40_000));
        let overhead = 150_000;
        let total = wire(&v, overhead);
        let limit = total - 200_000;
        let r = fit(&mut v, total, limit).unwrap();
        assert!(r.outputs_stubbed >= 5, "{r:?}");
        assert!(pairs_intact(&v));
        let stubs: Vec<usize> = v
            .iter()
            .enumerate()
            .filter(|(_, i)| matches!(i, InputItem::FunctionCallOutput { output, .. } if is_stub(output)))
            .map(|(k, _)| k)
            .collect();
        let first_intact = v
            .iter()
            .position(
                |i| matches!(i, InputItem::FunctionCallOutput { output, .. } if !is_stub(output)),
            )
            .unwrap();
        assert!(stubs.iter().all(|k| *k < first_intact), "oldest first");
        for i in &v {
            if let InputItem::FunctionCallOutput { output, .. } = i {
                if is_stub(output) {
                    let j: serde_json::Value = serde_json::from_str(output).unwrap();
                    assert_eq!(j["compacted"], true);
                }
            }
        }
        // every function_call survives, arguments untouched
        let calls = v
            .iter()
            .filter(|i| matches!(i, InputItem::FunctionCall { .. }))
            .count();
        assert_eq!(calls, 12);
    }

    #[test]
    fn the_latest_step_task_and_user_messages_are_never_reduced() {
        let mut v = convo(10, &"z".repeat(30_000));
        // guidance and runtime note (user messages) somewhere in the middle, large
        v.insert(9, user(&format!("[Nexus note] {}", "n".repeat(10_000))));
        // the latest step: reasoning + commentary + call + a big result + guidance
        v.push(reasoning(99, 2_000));
        v.push(phase(&"p".repeat(2_000)));
        v.push(call(99));
        v.push(out(99, &"L".repeat(50_000)));
        v.push(user("Continue."));
        let start = latest_step_start(&v);
        let latest: Vec<InputItem> = v[start..].to_vec();
        assert_eq!(latest.len(), 5);
        let users: Vec<InputItem> = v
            .iter()
            .filter(|i| matches!(i, InputItem::Message { role, .. } if role == "user"))
            .cloned()
            .collect();
        let overhead = 100_000;
        let total = wire(&v, overhead);
        // squeeze as far as possible
        // whether it fits or not, the protected items are byte-identical afterwards
        let _ = fit(&mut v, total, overhead + 90_000);
        let v2 = v.clone();
        assert_eq!(v2[latest_step_start(&v2)..].to_vec(), latest);
        let users2: Vec<InputItem> = v2
            .iter()
            .filter(|i| matches!(i, InputItem::Message { role, .. } if role == "user"))
            .cloned()
            .collect();
        assert_eq!(users2, users);
    }

    #[test]
    fn a_request_that_cannot_fit_fails_explicitly_and_leaves_the_conversation_unchanged() {
        let mut v = convo(6, &"q".repeat(20_000));
        v.push(call(50));
        v.push(out(50, &"big".repeat(30_000)));
        let before = v.clone();
        let overhead = 150_000;
        let total = wire(&v, overhead);
        let e = fit(&mut v, total, overhead + 50_000).unwrap_err();
        assert_eq!(v, before, "nothing changed on failure");
        assert!(e.smallest_bytes > e.limit);
        assert_eq!(e.fixed_overhead_bytes, overhead);
        assert!(e.message().contains("nothing was sent"));
        // a reserve larger than the target can never fit
        assert_eq!(
            RequestBudget {
                target_bytes: 10,
                reserve_bytes: 11
            }
            .limit(),
            None
        );
    }

    #[test]
    fn reasoning_items_are_dropped_whole_and_the_latest_responses_reasoning_is_kept() {
        let mut v = convo(8, "small");
        let latest = reasoning(77, 50_000);
        v.push(latest.clone());
        v.push(call(77));
        v.push(out(77, "ok"));
        let overhead = 5_000;
        let total = wire(&v, overhead);
        let r = fit(&mut v, total, total - 1_500).unwrap();
        assert!(r.reasoning_dropped >= 1);
        assert!(
            v.contains(&latest),
            "the latest response's reasoning is never dropped"
        );
        for i in &v {
            if let InputItem::Reasoning { item } = i {
                // every remaining item is an unmodified, parseable original
                let j: serde_json::Value = serde_json::from_str(item).unwrap();
                assert_eq!(nexus_contracts::canonical_json(&j), *item);
            }
        }
    }

    #[test]
    fn phase_labels_survive_shortening_and_text_is_cut_on_a_char_boundary() {
        let long = "é".repeat(1_000) + &"🚀".repeat(300);
        let mut v = vec![user("TASK")];
        for n in 0..6 {
            v.push(phase(&long));
            v.push(call(n));
            v.push(out(n, "short"));
        }
        let overhead = 1_000;
        let total = wire(&v, overhead);
        let r = fit(&mut v, total, total - 5_000).unwrap();
        assert!(r.messages_shortened >= 1);
        for i in &v {
            if let InputItem::AssistantPhase { phase, content } = i {
                assert_eq!(phase, "commentary");
                assert!(content == &long || content.ends_with(" [shortened]"));
            }
        }
        assert_eq!(r.request_bytes_after, wire(&v, overhead));
    }

    #[test]
    fn fitting_is_deterministic_and_idempotent_for_a_retry_of_the_same_attempt() {
        // a retried attempt (lost answer) or a resumed loop re-prepares the SAME items: the
        // second fit must be a no-op and two independent fits must agree byte for byte
        let base = convo(25, &"w".repeat(8_000));
        let overhead = 40_000;
        let total = wire(&base, overhead);
        let limit = total - 70_000;
        let (mut a, mut b) = (base.clone(), base.clone());
        let ra = fit(&mut a, total, limit).unwrap();
        let rb = fit(&mut b, total, limit).unwrap();
        assert_eq!(a, b);
        assert_eq!(ra, rb);
        let again = fit(&mut a, ra.request_bytes_after, limit).unwrap();
        assert!(!again.changed());
        assert_eq!(a, b);
    }

    #[test]
    fn an_already_stubbed_result_is_not_stubbed_again() {
        let mut v = vec![user("TASK")];
        v.push(call(0));
        v.push(out(0, &stub_output(123_456)));
        v.push(call(1));
        v.push(out(1, "latest"));
        let total = wire(&v, 10);
        let e = fit(&mut v, total, total - 50).unwrap_err();
        assert_eq!(e.smallest_bytes, total);
    }
}

/// MEASUREMENT (run explicitly with `--ignored --nocapture em04a_measure`): the budget's own cost
/// on an A614-sized conversation (~450 KB, 110 items): exact sizing of every item, and a fit that
/// must reduce.
#[cfg(test)]
mod measure {
    use super::*;

    #[test]
    #[ignore]
    fn em04a_measure_budget_cost() {
        let mut v = vec![InputItem::Message {
            role: "user".into(),
            content: "TASK".into(),
        }];
        for n in 0..55 {
            v.push(InputItem::FunctionCall {
                call_id: format!("call_{n}"),
                name: "fs_read".into(),
                arguments: format!("{{\"path\":\"big.txt\",\"startLine\":{n}}}"),
            });
            v.push(InputItem::FunctionCallOutput {
                call_id: format!("call_{n}"),
                output: format!("line {n:05} {}\n", "x".repeat(100)).repeat(70),
            });
        }
        let overhead = 9_000;
        let total = overhead + items_bytes(&v);
        let (mut size_ms, mut fit_ms) = (Vec::new(), Vec::new());
        for _ in 0..50 {
            let t = std::time::Instant::now();
            let _ = std::hint::black_box(items_bytes(&v));
            size_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            let mut w = v.clone();
            let t = std::time::Instant::now();
            let r = fit(&mut w, total, total - 3_000).unwrap();
            fit_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            assert!(r.changed());
        }
        size_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        fit_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "EM-04A budget on {} B / {} items: exact sizing median {:.2} ms p95 {:.2} ms; fit (reduce) median {:.2} ms p95 {:.2} ms",
            total,
            v.len(),
            size_ms[25],
            size_ms[47],
            fit_ms[25],
            fit_ms[47]
        );
    }
}
