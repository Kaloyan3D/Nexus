//! P0 diagnostic (not part of the product): rebuild the exact first user message a run
//! sent (harness preamble + conversation context + task) from a preserved thread record,
//! with the same functions `inspect.rs` uses.
//!
//!   p0_first_message <thread.json> <thread.log> <run.json> <out.txt>

use nexus_broker::threads::{build_context, fit_budget, Message, Thread, WorkspaceFacts};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let th: Thread = serde_json::from_str(&std::fs::read_to_string(&a[1]).expect("thread json"))
        .expect("thread parses");
    let msgs: Vec<Message> = std::fs::read_to_string(&a[2])
        .expect("thread log")
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let rec: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&a[3]).expect("run json")).expect("run");
    let run_id = rec["run"]["runId"].as_str().expect("runId");
    let prompt = rec["prompt"].as_str().expect("prompt");
    let pre = nexus_broker::guidance::code_preamble_body(&[], true);
    let reserve = pre.len() + prompt.len() + 256;
    let budget = fit_budget(nexus_broker::threads::CONTEXT_BUDGET_BYTES, reserve);
    let ws = WorkspaceFacts {
        relation: rec["run"]["workspaceRelation"]
            .as_str()
            .unwrap_or("fresh")
            .to_owned(),
        from_run_n: None,
        note: None,
        changed: Vec::new(),
    };
    let prior = build_context(&th, &msgs, run_id, &ws, budget);
    let mut c = pre;
    match &prior {
        Some(p) => {
            c.push('\n');
            c.push_str(p);
        }
        None => c.push_str("\nTask from the user:\n"),
    }
    c.push_str(prompt);
    std::fs::write(&a[4], &c).expect("write");
    eprintln!(
        "first message: {} bytes (context {} bytes, budget {budget})",
        c.len(),
        prior.map(|p| p.len()).unwrap_or(0)
    );
}
