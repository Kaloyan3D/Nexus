//! M4.6 execution analytics: what a run measured about itself, kept beside the run and derived on read.
//!
//! One append-only JSONL record per run (`<state>/telemetry/<run id>.jsonl`, mode 0600) is written at the REAL
//! boundaries of the controller loop: one line per provider request (timings measured inside the client, normalized
//! usage plus the provider's raw numeric usage fields), per tool execution (execution time apart from the time spent
//! waiting for an approval or a permission decision), per phase change. Nothing else is stored: no prompt, no model
//! text, no headers, no ids beyond the run's own. Writing is best effort and can never change a run's outcome.
//!
//! The analytics themselves are DERIVED on read from this record plus the run record and its tool activity (the
//! existing sources of truth); nothing is duplicated except the per-request facts that were never persisted before.
//! A run without the record (any run from before this milestone) still gets analytics, with each per-request metric
//! reported as unavailable instead of invented.
//!
//! Definitions used everywhere below:
//! * **Mutually exclusive time categories** (they add up to the wall clock, the remainder is "controller"): model
//!   request time, tool execution time, approval/permission waiting time, controller (everything else).
//! * **Overlapping measures** (never added to the categories): time to first token (inside a request), build and test
//!   time (inside tool execution), per-request latency (the same time as the model category, listed individually).
//! * `cached input` is a subset of `input`; `reasoning` is a subset of `output` (OpenAI-style definitions). Providers
//!   that do not report them leave them unavailable (never zero by assumption).

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use nexus_client::intent_client::{IntentRun, ToolActivity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// v2 (M4.7) adds `efficiency` and the complete command list; every v1 key is unchanged.
pub const SCHEMA_VERSION: u32 = 2;
/// M4.7: a request counts toward the decode rate only with this many visible output tokens and this long a window.
pub const DECODE_MIN_TOKENS: u64 = 256;
pub const DECODE_MIN_WINDOW_MS: u64 = 1000;
/// Commands listed in `tools.commands` at most (a longer run says how many were omitted).
pub const MAX_COMMANDS: usize = 2000;
/// A run's record stops growing here (the rest of the run is still analysed from the run record).
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LIST: usize = 200;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn wall_now_ms() -> u64 {
    now_ms()
}

// ------------------------------------------------------------------ record

/// What the provider reported for one request (normalized; `raw` keeps its numeric fields verbatim).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRec {
    pub input: u64,
    pub output: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Provider-reported cost of this request, micro-USD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_micro_usd: Option<u64>,
    /// Provider-reported list-price equivalent of this request, nano-USD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_cost_nano_usd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRec {
    /// The controller attempt (1-based).
    pub ordinal: u32,
    pub turn: u32,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// Request latency as measured by the client, send to end of stream.
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    pub provider: String,
    /// The model the run asked for.
    pub model: String,
    /// The model the provider says served it (absent when it did not say).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_model: Option<String>,
    pub effort: String,
    /// `work` | `verification` | `recovery` (see `phase_of`).
    pub phase: String,
    /// `answered` | `truncated` | `failed` | `uncertain`
    pub outcome: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub finish_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageRec>,
    /// Tool calls this response asked for (a request, not an execution).
    pub tool_calls_requested: u32,
    /// M4.7: how this request's prompt relates to the previous one (digests and indices only, no content).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<PrefixRec>,
    /// M4.7: controller work between the previous answer's processing and this send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_send: Option<PreSendRec>,
}

/// M4.7: prompt-prefix stability of one request against the previous request of the run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixRec {
    /// Input items in this request.
    pub items: u32,
    /// Every item of the previous request is unchanged, in order, at the start of this one.
    pub stable: bool,
    /// First item index that differs from the previous request (absent when stable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diverge_at: Option<u32>,
    /// Why the provider's cache key or cached prefix can change here: `none` | `first-request` | `effort-change` |
    /// `reasoning-replay` | `context-compaction` | `memory-fold` | `request-format` | `unknown`. Several causes are
    /// joined with `+` (in that order).
    pub cause: String,
}

/// M4.7: where controller time goes before a provider request (milliseconds).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreSendRec {
    /// Registry attempt record (`attempt-add`).
    pub attempt_ms: u64,
    /// Controller shadow intent and Kernel intent for the attempt.
    pub intent_ms: u64,
    /// Engineering Mode consult before the request (Governor bridge included).
    pub engine_ms: u64,
    /// Attempt target: Registry issuance and Kernel seal when the effort's target is new.
    pub target_ms: u64,
    /// Request preparation (serialization, attestation inputs, request budget).
    pub prepare_ms: u64,
    /// Write-ahead attempt binding.
    pub bind_ms: u64,
    /// Bundle publish, Kernel accept, workspace bind and dispatch authorization.
    pub authorize_ms: u64,
    /// From the start of the turn to the send.
    pub total_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRec {
    /// The activity index (joins to the tool activity record).
    pub index: u32,
    pub tool: String,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// Time the operation itself took (after any approval).
    pub exec_ms: u64,
    /// Time spent waiting for an approval or permission decision before it ran.
    pub wait_ms: u64,
    pub class: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub verification_command: bool,
}

// Records are built, written and dropped one at a time; boxing the larger variants would only add allocations.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum Ev {
    Request(RequestRec),
    Tool(ToolRec),
    Phase {
        at_ms: u64,
        phase: String,
        #[serde(default)]
        detail: String,
    },
}

fn dir(state: &Path) -> PathBuf {
    state.join("telemetry")
}

fn file(state: &Path, run_id: &str) -> Option<PathBuf> {
    if run_id.is_empty()
        || !run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return None;
    }
    Some(dir(state).join(format!("{run_id}.jsonl")))
}

/// Append one event. Best effort: any failure is ignored (telemetry must never change a run).
pub fn append(state: &Path, run_id: &str, ev: &Ev) {
    let Some(p) = file(state, run_id) else { return };
    let _ = (|| -> std::io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir(state))?;
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) >= MAX_BYTES {
            return Ok(());
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&p)?;
        let mut line = serde_json::to_string(ev).map_err(std::io::Error::other)?;
        line.push('\n');
        f.write_all(line.as_bytes())
    })();
}

/// Read a run's record. A torn last line (crash mid-write) and unknown lines are skipped; `capped` says the size cap
/// was reached.
pub fn load(state: &Path, run_id: &str) -> (Vec<Ev>, bool) {
    let Some(p) = file(state, run_id) else {
        return (Vec::new(), false);
    };
    let Ok(f) = std::fs::File::open(&p) else {
        return (Vec::new(), false);
    };
    let capped = f.metadata().map(|m| m.len() >= MAX_BYTES).unwrap_or(false);
    let evs = std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Ev>(&l).ok())
        .collect();
    (evs, capped)
}

/// Normalize the client's usage detail into a record.
pub fn usage_rec(d: &nexus_client::UsageDetail) -> UsageRec {
    UsageRec {
        input: d.usage.input_tokens,
        output: d.usage.output_tokens,
        cached_input: d.usage.cached_input_tokens,
        cache_write: d.usage.cache_write_tokens,
        reasoning: d.usage.reasoning_tokens,
        total: d.usage.total_tokens,
        cost_micro_usd: d.usage.cost_micro_usd,
        list_cost_nano_usd: d.usage.list_cost_nano_usd,
        raw: d.raw.as_deref().and_then(|r| serde_json::from_str(r).ok()),
    }
}

/// What the loop knows when a request has ended.
pub struct ReqCtx<'a> {
    pub ordinal: u32,
    pub turn: u32,
    pub started_at_ms: u64,
    pub provider: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub phase: &'static str,
}

/// The record of one request from how its turn ended.
pub fn request_rec(c: &ReqCtx<'_>, end: &nexus_client::TurnEnd) -> RequestRec {
    use nexus_client::TurnEnd;
    let ended = now_ms();
    let base = RequestRec {
        ordinal: c.ordinal,
        turn: c.turn,
        started_at_ms: c.started_at_ms,
        ended_at_ms: ended,
        provider: c.provider.to_owned(),
        model: c.model.to_owned(),
        effort: c.effort.to_owned(),
        phase: c.phase.to_owned(),
        ..Default::default()
    };
    let from_output = |o: &nexus_client::TurnOutput, outcome: &str| RequestRec {
        latency_ms: o.latency_ms,
        ttft_ms: o.first_token_ms,
        actual_model: o.usage_detail.as_ref().and_then(|d| d.actual_model.clone()),
        outcome: outcome.to_owned(),
        finish_reason: o.finish_reason.chars().take(48).collect(),
        usage: o.usage_detail.as_ref().map(usage_rec).or_else(|| {
            o.usage.map(|(i, out)| UsageRec {
                input: i,
                output: out,
                ..Default::default()
            })
        }),
        tool_calls_requested: if outcome == "truncated" {
            0
        } else {
            o.tool_calls.len() as u32
        },
        ..base.clone()
    };
    match end {
        TurnEnd::Output(o) => from_output(o, "answered"),
        TurnEnd::Truncated(o) => from_output(o, "truncated"),
        TurnEnd::Ended {
            state, latency_ms, ..
        } => RequestRec {
            latency_ms: *latency_ms,
            outcome: if matches!(state, nexus_client::model_run::ModelRunState::Uncertain) {
                "uncertain"
            } else {
                "failed"
            }
            .to_owned(),
            ..base
        },
    }
}

/// The phase a request belongs to, from what the controller did just before it. `verification`: the previous turn ran
/// a verification command; `recovery`: the previous request or check failed, or the same turn is being asked again;
/// otherwise `work`.
pub fn phase_of(prev_turn_verified: bool, prev_failed: bool, reasked: bool) -> &'static str {
    if reasked || prev_failed {
        "recovery"
    } else if prev_turn_verified {
        "verification"
    } else {
        "work"
    }
}

// --------------------------------------------------------------- analytics

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub schema_version: u32,
    pub run_id: String,
    pub generated_at_ms: u64,
    /// Where each part comes from: `per-request-record` (this milestone's telemetry) or `run-record-only`.
    pub source: Value,
    pub identity: Value,
    pub runtime: Value,
    pub tokens: Value,
    pub routing: Value,
    pub tools: Value,
    pub verification: Value,
    pub cost: Value,
    /// M4.7 (schema v2): throughput by definition, cache-break attribution, controller and request timing,
    /// verification-loop efficiency.
    pub efficiency: Value,
    /// Metrics that could not be measured for this run, each with the reason.
    pub missing: Vec<Value>,
}

fn opt_sum(v: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    let mut sum = 0u64;
    let mut any = false;
    for x in v {
        // a request that did not report it makes the total unknowable, not smaller
        sum += x?;
        any = true;
    }
    any.then_some(sum)
}

fn rate(num: u64, den: u64) -> Option<f64> {
    (den > 0).then(|| ((num as f64 / den as f64) * 10_000.0).round() / 10_000.0)
}

#[derive(Default, Clone)]
struct Agg {
    requests: u32,
    input: u64,
    output: u64,
    cached: Option<u64>,
    reasoning: Option<u64>,
    cached_known: bool,
    reasoning_known: bool,
    latency_ms: u64,
}

fn add_agg(a: &mut Agg, r: &RequestRec) {
    a.requests += 1;
    a.latency_ms += r.latency_ms;
    if let Some(u) = &r.usage {
        a.input += u.input;
        a.output += u.output;
        if let Some(c) = u.cached_input {
            a.cached = Some(a.cached.unwrap_or(0) + c);
            a.cached_known = true;
        }
        if let Some(c) = u.reasoning {
            a.reasoning = Some(a.reasoning.unwrap_or(0) + c);
            a.reasoning_known = true;
        }
    }
}

fn agg_json(key: &str, name: &str, a: &Agg) -> Value {
    json!({
        key: name, "requests": a.requests, "inputTokens": a.input, "outputTokens": a.output,
        "cachedInputTokens": a.cached, "reasoningTokens": a.reasoning, "latencyMs": a.latency_ms,
        "cacheHitRate": a.cached.and_then(|c| rate(c, a.input)),
    })
}

/// Optional explicit pricing the person supplied (`<state>/pricing.json`); never shipped, never guessed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub provider: String,
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    #[serde(default)]
    pub cached_input_per_mtok: Option<f64>,
    #[serde(default)]
    pub cache_write_per_mtok: Option<f64>,
}

pub fn load_prices(state: &Path) -> Vec<Price> {
    #[derive(Deserialize)]
    struct F {
        prices: Vec<Price>,
    }
    std::fs::read_to_string(state.join("pricing.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<F>(&t).ok())
        .map(|f| f.prices)
        .unwrap_or_default()
}

/// M4.7: how efficiently the run turned requests and checks into verified work. Every figure is derived from the
/// sidecar and the activity; a figure the record cannot support is null and listed in `missing`.
fn efficiency(
    run: &IntentRun,
    activity: &[ToolActivity],
    reqs: &[&RequestRec],
    tool_ms: Option<u64>,
    controller_ms: Option<u64>,
    end_to_end_tps: Option<f64>,
    missing: &mut Vec<Value>,
) -> Value {
    let round1 = |x: f64| (x * 10.0).round() / 10.0;
    // decode window: first VISIBLE token to the end of the stream (hidden reasoning before it is outside the window).
    // Only responses long enough to measure: a short reply's window is a few milliseconds and inflates the rate
    // (found live: 873 tok/s over five two-line answers).
    let (dt, dm, dn) = reqs.iter().fold((0u64, 0u64, 0u32), |(t, m, n), r| {
        match (&r.usage, r.ttft_ms) {
            (Some(u), Some(f)) if r.latency_ms > f => {
                let visible = u.output.saturating_sub(u.reasoning.unwrap_or(0));
                let window = r.latency_ms - f;
                if visible >= DECODE_MIN_TOKENS && window >= DECODE_MIN_WINDOW_MS {
                    (t + visible, m + window, n + 1)
                } else {
                    (t, m, n)
                }
            }
            _ => (t, m, n),
        }
    });
    let decode = (dm > 0).then(|| round1(dt as f64 / (dm as f64 / 1000.0)));
    if decode.is_none() && !reqs.is_empty() {
        missing.push(json!({"metric": "efficiency.throughput.decode", "reason": "no request streamed enough visible output to measure a decode rate"}));
    }
    // cache breaks, attributed by the prefix record each request carries
    let with_prefix: Vec<&&RequestRec> = reqs.iter().filter(|r| r.prefix.is_some()).collect();
    let cache_breaks = if with_prefix.is_empty() {
        if !reqs.is_empty() {
            missing.push(json!({"metric": "efficiency.cacheBreaks", "reason": "the requests of this run carry no prefix record (they predate M4.7)"}));
        }
        Value::Null
    } else {
        let mut by: BTreeMap<String, (u32, u64)> = BTreeMap::new();
        for r in &with_prefix {
            let p = r.prefix.as_ref().unwrap();
            let unc = r
                .usage
                .as_ref()
                .and_then(|u| u.cached_input.map(|c| u.input.saturating_sub(c)));
            let e = by.entry(p.cause.clone()).or_default();
            e.0 += 1;
            e.1 += unc.unwrap_or(0);
        }
        json!({
            "requests": with_prefix.len(),
            "stablePrefix": with_prefix.iter().filter(|r| r.prefix.as_ref().is_some_and(|p| p.stable)).count(),
            "byCause": by.iter().map(|(c, (n, u))| json!({"cause": c, "requests": n, "uncachedInput": u})).collect::<Vec<_>>(),
            "note": "cause is what changed in the prompt or the provider's cache key since the previous request; uncached input is the provider's report for those requests",
        })
    };
    // controller work before each send
    let pre: Vec<&PreSendRec> = reqs.iter().filter_map(|r| r.pre_send.as_ref()).collect();
    let pre_sum = |f: fn(&PreSendRec) -> u64| pre.iter().map(|p| f(p)).sum::<u64>();
    let pre_send = (!pre.is_empty()).then(|| json!({
        "samples": pre.len(),
        "attemptMs": pre_sum(|p| p.attempt_ms), "intentMs": pre_sum(|p| p.intent_ms), "engineMs": pre_sum(|p| p.engine_ms),
        "targetMs": pre_sum(|p| p.target_ms), "prepareMs": pre_sum(|p| p.prepare_ms), "bindMs": pre_sum(|p| p.bind_ms),
        "authorizeMs": pre_sum(|p| p.authorize_ms), "totalMs": pre_sum(|p| p.total_ms),
    }));
    if pre_send.is_none() && !reqs.is_empty() {
        missing.push(json!({"metric": "efficiency.controller.preSend", "reason": "the requests of this run carry no pre-send timing (they predate M4.7)"}));
    }
    let pre_total = (!pre.is_empty()).then(|| pre_sum(|p| p.total_ms));
    // verification loop
    let first_final = reqs
        .iter()
        .position(|r| r.outcome == "answered" && r.tool_calls_requested == 0);
    let after_final = first_final.map(|i| reqs.len() - i - 1);
    let cls = |c: &str| {
        activity
            .iter()
            .filter(|a| a.check_class.as_deref() == Some(c))
            .count()
    };
    json!({
        "throughput": {
            "endToEndOutputTokensPerSecond": end_to_end_tps,
            "endToEndBasis": "output tokens (reasoning included) / total request latency (time to first token included)",
            "decodeOutputTokensPerSecond": decode,
            "decodeSamples": dn,
            "decodeBasis": "visible output tokens (reasoning excluded) / (end of stream - first visible token), over requests with at least 256 visible tokens and a decode window of at least 1 s",
            "comparableWithDsh": false,
            "comparabilityNote": "Nexus DSH reports output tokens / (completion - first streamed chunk of any kind); the windows differ, so the figures are not directly comparable",
        },
        "cacheBreaks": cache_breaks,
        "controller": {
            "controllerMs": controller_ms,
            "preSend": pre_send,
            "afterResponseAndOtherMs": match (controller_ms, pre_total) { (Some(c), Some(p)) => Some(c.saturating_sub(p)), _ => None },
            "note": "preSend: attempt record, intents, Engineering Mode consult, attempt target, preparation, write-ahead bind, publish/accept/authorize; the rest is processing of answers and tool results, persistence and guards",
        },
        "toolTime": {
            "foregroundMs": tool_ms,
            "backgroundMs": Value::Null,
            "note": "every command runs in the foreground under the Kernel; background jobs (job tools) run outside tool time and are not timed",
        },
        "verificationLoop": {
            "requestsAfterFirstFinalAnswer": after_final,
            "filterStatusCalls": cls("filter-status") + cls("filter-status-joined"),
            "obligationsOpened": cls("unattested-composition") + cls("filter-status"),
            "obligationsJoined": cls("unattested-joined") + cls("filter-status-joined"),
            "hazardsReestablished": activity.iter().map(|a| a.resolves_hazards.len()).sum::<usize>(),
            "failuresReestablished": activity.iter().map(|a| a.resolves_failed.len()).sum::<usize>(),
            "unresolvedFailed": run.unresolved_failed_checks,
            "unresolvedUnattested": run.unresolved_unattested_checks,
        },
    })
}

fn is_build_or_test(act: &ToolActivity) -> bool {
    act.tool == "proc_run" && matches!(act.verification.as_deref(), Some("pass" | "fail"))
}

/// Build the analytics of one run.
pub fn analyze(
    run: &IntentRun,
    activity: &[ToolActivity],
    evs: &[Ev],
    capped: bool,
    prices: &[Price],
    host: &Value,
    engine: &Value,
) -> Analytics {
    let reqs: Vec<&RequestRec> = evs
        .iter()
        .filter_map(|e| {
            if let Ev::Request(r) = e {
                Some(r)
            } else {
                None
            }
        })
        .collect();
    let tools: Vec<&ToolRec> = evs
        .iter()
        .filter_map(|e| if let Ev::Tool(t) = e { Some(t) } else { None })
        .collect();
    let have_requests = !reqs.is_empty();
    let have_tools = !tools.is_empty();
    let mut missing: Vec<Value> = Vec::new();
    let mut miss = |what: &str, why: &str| missing.push(json!({"metric": what, "reason": why}));

    // ---------------- runtime
    let started = run.created_at_ms;
    let ended = run.terminal.then_some(run.updated_at_ms);
    // M4.7: the monotonic duration when the run recorded one; the wall-clock stamps can jump (a guest clock resync)
    let wall_clock = ended.map(|e| e.saturating_sub(started));
    let wall = match (run.run_elapsed_ms, wall_clock) {
        (Some(m), Some(_)) => Some(m),
        (_, w) => w,
    };
    let clock_skew = match (run.run_elapsed_ms, wall_clock) {
        (Some(m), Some(w)) if w.abs_diff(m) > 5_000 => Some(w as i64 - m as i64),
        _ => None,
    };
    if clock_skew.is_some() {
        miss("runtime.wallClock", "the run's wall-clock stamps disagree with its monotonic duration (the engine clock moved during the run); wallMs is the monotonic duration");
    }
    let model_ms: Option<u64> = have_requests.then(|| reqs.iter().map(|r| r.latency_ms).sum());
    let tool_ms: Option<u64> = have_tools.then(|| tools.iter().map(|t| t.exec_ms).sum());
    let wait_ms: Option<u64> = have_tools.then(|| tools.iter().map(|t| t.wait_ms).sum());
    let measured = (have_requests && have_tools)
        .then(|| model_ms.unwrap_or(0) + tool_ms.unwrap_or(0) + wait_ms.unwrap_or(0));
    let controller_ms = match (wall, measured) {
        (Some(w), Some(m)) => Some(w.saturating_sub(m)),
        _ => None,
    };
    let lat: Vec<u64> = reqs.iter().map(|r| r.latency_ms).collect();
    let ttfts: Vec<u64> = reqs.iter().filter_map(|r| r.ttft_ms).collect();
    let avg = |v: &[u64]| (!v.is_empty()).then(|| v.iter().sum::<u64>() / v.len() as u64);
    // output tokens per second, end to end: output tokens divided by the time of the requests that reported usage.
    // (A generation-only window would need a first token for every request; a response that is only a tool call
    // streams no text, so its "first token" is the end of the stream and would inflate the rate.)
    let (gen_tokens, gen_ms) = reqs.iter().fold((0u64, 0u64), |(t, m), r| match &r.usage {
        Some(u) if r.latency_ms > 0 => (t + u.output, m + r.latency_ms),
        _ => (t, m),
    });
    let tps = (gen_ms > 0)
        .then(|| ((gen_tokens as f64 / (gen_ms as f64 / 1000.0)) * 10.0).round() / 10.0);
    if !have_requests {
        miss("runtime.requests", "this run has no per-request telemetry (it ran before execution analytics existed, or the record was removed)");
    } else if !ttfts.is_empty() && ttfts.len() < reqs.len() {
        miss(
            "runtime.ttft",
            "some requests did not stream a first token before they ended",
        );
    }
    if !have_tools {
        miss(
            "runtime.toolExecution",
            "no per-tool timing was recorded for this run",
        );
    }
    if run.terminal {
        // interrupted runs end where the record ends
    } else {
        miss("runtime.end", "the run has not ended");
    }
    let runtime = json!({
        "startedAtMs": started, "endedAtMs": ended, "wallMs": wall, "state": run.state, "terminal": run.terminal,
        "wallBasis": if run.run_elapsed_ms.is_some() { "monotonic" } else { "wall-clock" },
        "wallClockMs": wall_clock, "clockSkewMs": clock_skew,
        "categoriesExclusive": {
            "modelRequestMs": model_ms, "toolExecutionMs": tool_ms, "approvalWaitMs": wait_ms, "controllerMs": controller_ms,
            "note": "model + tool + approval wait + controller = wall clock; controller is the remainder (orchestration, context building, writes, anything not measured separately)",
        },
        "overlapping": {
            "timeToFirstTokenMs": {"avg": avg(&ttfts), "min": ttfts.iter().min(), "max": ttfts.iter().max(), "samples": ttfts.len(),
                "note": "inside each request's latency; not additive to the categories"},
            "buildAndTestMs": have_tools.then(|| tools.iter().zip(std::iter::repeat(())).filter(|(t, _)| t.verification_command).map(|(t, _)| t.exec_ms).sum::<u64>()),
        },
        "requests": {"count": reqs.len(), "avgLatencyMs": avg(&lat), "minLatencyMs": lat.iter().min(), "maxLatencyMs": lat.iter().max(),
            "latenciesMs": lat.iter().take(MAX_LIST).collect::<Vec<_>>()},
        "outputTokensPerSecond": tps,
        "outputTokensPerSecondBasis": "output tokens divided by the total latency of the requests that reported usage (end to end, time to first token included)",
        "recordCapped": capped,
    });

    // ---------------- tokens
    let usages: Vec<Option<&UsageRec>> = reqs.iter().map(|r| r.usage.as_ref()).collect();
    let per_request_usage = have_requests && usages.iter().all(|u| u.is_some());
    let (input, output): (Option<u64>, Option<u64>) = if per_request_usage {
        (
            Some(usages.iter().flatten().map(|u| u.input).sum()),
            Some(usages.iter().flatten().map(|u| u.output).sum()),
        )
    } else {
        // cumulative figures from the run record (the only source for older runs)
        (run.usage_input_tokens, run.usage_output_tokens)
    };
    let cached = per_request_usage
        .then(|| opt_sum(usages.iter().map(|u| u.and_then(|u| u.cached_input))))
        .flatten();
    let cache_write = per_request_usage
        .then(|| opt_sum(usages.iter().map(|u| u.and_then(|u| u.cache_write))))
        .flatten();
    let reasoning = per_request_usage
        .then(|| opt_sum(usages.iter().map(|u| u.and_then(|u| u.reasoning))))
        .flatten();
    let noncached = match (input, cached) {
        (Some(i), Some(c)) if c <= i => Some(i - c),
        _ => None,
    };
    let hit = match (input, cached) {
        (Some(i), Some(c)) if c <= i => rate(c, i),
        _ => None,
    };
    if input.is_none() {
        miss("tokens", "the provider reported no usage for this run");
    }
    if per_request_usage && cached.is_none() {
        miss(
            "tokens.cachedInput",
            "the provider did not report cached input tokens",
        );
    }
    if per_request_usage && cache_write.is_none() {
        miss(
            "tokens.cacheWrite",
            "the provider did not report cache-write tokens",
        );
    }
    if per_request_usage && reasoning.is_none() {
        miss(
            "tokens.reasoning",
            "the provider did not report reasoning tokens",
        );
    }
    if !per_request_usage && input.is_some() {
        miss("tokens.cachedInput", "only cumulative input/output totals exist for this run (no per-request usage was recorded)");
        miss("tokens.reasoning", "only cumulative input/output totals exist for this run (no per-request usage was recorded)");
    }
    // by attempt / model / phase
    let mut by_attempt = Vec::new();
    let mut by_model: BTreeMap<String, Agg> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, Agg> = BTreeMap::new();
    for r in &reqs {
        let u = r.usage.as_ref();
        by_attempt.push(json!({
            "ordinal": r.ordinal, "turn": r.turn, "model": r.model, "effort": r.effort, "phase": r.phase, "outcome": r.outcome,
            "inputTokens": u.map(|u| u.input), "outputTokens": u.map(|u| u.output),
            "cachedInputTokens": u.and_then(|u| u.cached_input), "reasoningTokens": u.and_then(|u| u.reasoning),
            "latencyMs": r.latency_ms, "ttftMs": r.ttft_ms,
            "costMicroUsd": u.and_then(|u| u.cost_micro_usd), "usageRaw": u.and_then(|u| u.raw.clone()),
        }));
        add_agg(
            by_model
                .entry(format!("{}/{}", r.provider, r.model))
                .or_default(),
            r,
        );
        add_agg(by_phase.entry(r.phase.clone()).or_default(), r);
    }
    let total = match (input, output) {
        (Some(i), Some(o)) => Some(i + o),
        _ => None,
    };
    // cumulative figure of the run record vs the per-request sum: a mismatch is reported, never hidden
    let reconcile = (per_request_usage && run.usage_input_tokens.is_some()).then(|| {
        json!({"runRecordInput": run.usage_input_tokens, "runRecordOutput": run.usage_output_tokens,
               "matches": run.usage_input_tokens == input && run.usage_output_tokens == output})
    });
    let tokens = json!({
        "source": if per_request_usage { "per-request" } else if input.is_some() { "run-record-cumulative" } else { "none" },
        "input": input, "output": output, "total": total,
        "cachedInput": cached, "cacheWrite": cache_write, "noncachedInput": noncached, "reasoning": reasoning,
        "cacheHitRate": hit,
        "definitions": {
            "cachedInput": "a subset of input (cached / input); unavailable unless every request reported it",
            "reasoning": "a subset of output; reported separately, never added to output",
            "noncachedInput": "input minus cached input; cache writes are billed separately by some providers and are not subtracted",
            "total": "input + output as normalized (not the provider's own total)",
        },
        "byAttempt": by_attempt.iter().take(MAX_LIST).collect::<Vec<_>>(),
        "byModel": by_model.iter().map(|(k, a)| agg_json("model", k, a)).collect::<Vec<_>>(),
        "byPhase": by_phase.iter().map(|(k, a)| agg_json("phase", k, a)).collect::<Vec<_>>(),
        "reconciliation": reconcile,
    });

    // ---------------- routing
    let mut models_in_order: Vec<String> = Vec::new();
    let mut switches = 0u32;
    for r in &reqs {
        let m = format!(
            "{}/{}",
            r.provider,
            r.actual_model.as_deref().unwrap_or(&r.model)
        );
        if models_in_order.last() != Some(&m) {
            if !models_in_order.is_empty() {
                switches += 1;
            }
            models_in_order.push(m);
        }
    }
    let configured = json!({"provider": run.provider_id, "model": run.remote_model_id, "logicalModel": run.logical_model_id, "route": run.route_id});
    let phases: Vec<Value> = evs
        .iter()
        .filter_map(|e| match e {
            Ev::Phase {
                at_ms,
                phase,
                detail,
            } => Some(json!({"atMs": at_ms, "phase": phase, "detail": detail})),
            _ => None,
        })
        .take(MAX_LIST)
        .collect();
    let mut efforts: BTreeMap<String, u32> = BTreeMap::new();
    for r in &reqs {
        *efforts.entry(r.effort.clone()).or_default() += 1;
    }
    let routing = json!({
        "configured": configured,
        "requests": reqs.iter().take(MAX_LIST).map(|r| json!({
            "ordinal": r.ordinal, "provider": r.provider, "model": r.model, "actualModel": r.actual_model,
            "effort": r.effort, "phase": r.phase, "outcome": r.outcome,
            "routedAsConfigured": r.actual_model.as_deref().map(|a| a == r.model),
        })).collect::<Vec<_>>(),
        "attemptsPerModel": by_model.iter().map(|(k, a)| json!({"model": k, "attempts": a.requests})).collect::<Vec<_>>(),
        "attemptsPerEffort": efforts,
        "modelSwitches": switches,
        "phaseTransitions": phases,
        "actualModelNote": "the model the provider names in its response; absent when the provider did not name one",
    });
    if have_requests && reqs.iter().all(|r| r.actual_model.is_none()) {
        miss(
            "routing.actualModel",
            "the provider did not name the serving model in any response",
        );
    }

    // ---------------- tools
    let mut by_tool: BTreeMap<String, (u32, u32, u32, u32)> = BTreeMap::new(); // calls, ok, failed, denied
    let (mut ok, mut failed, mut denied) = (0u32, 0u32, 0u32);
    let mut installs = (0u32, 0u32, 0u32, 0u32); // requests, approved, denied, auto
    let mut prompts = 0u32;
    let mut commands = Vec::new();
    let mut edits = (0u32, 0u32);
    for a in activity {
        let e = by_tool.entry(a.tool.clone()).or_default();
        e.0 += 1;
        match a.status.as_str() {
            "executed" => {
                ok += 1;
                e.1 += 1;
            }
            "refused" | "cancelled"
                if a.permission_decision.as_deref() == Some("denied")
                    || a.approval_outcome.as_deref() == Some("denied") =>
            {
                denied += 1;
                e.3 += 1;
            }
            "refused" => {
                denied += 1;
                e.3 += 1;
            }
            _ => {
                failed += 1;
                e.2 += 1;
            }
        }
        if a.tool == "fs_write" || a.tool == "fs_edit" {
            edits.0 += 1;
            if a.status == "executed" {
                edits.1 += 1;
            }
        }
        if a.op_class.as_deref() == Some("dependency-install") {
            installs.0 += 1;
            match a.permission_decision.as_deref() {
                Some("approved-once") | Some("approved-earlier") => installs.1 += 1,
                Some("denied") | Some("expired") => installs.2 += 1,
                Some("auto-full-access") | Some("auto") => installs.3 += 1,
                _ => {}
            }
        }
        if matches!(
            a.permission_decision.as_deref(),
            Some("approved-once" | "denied" | "expired")
        ) {
            prompts += 1;
        }
        if a.tool == "proc_run" && commands.len() < MAX_COMMANDS {
            let t = tools.iter().find(|t| t.index == a.index);
            commands.push(json!({
                "index": a.index, "command": a.args_summary, "status": a.status, "exitCode": a.exit_code,
                "verification": a.verification, "execMs": t.map(|t| t.exec_ms), "waitMs": t.map(|t| t.wait_ms),
            }));
        }
    }
    let requested: Option<u32> =
        have_requests.then(|| reqs.iter().map(|r| r.tool_calls_requested).sum());
    if !have_tools {
        miss(
            "tools.durations",
            "no per-tool timing was recorded for this run",
        );
    }
    let tools_json = json!({
        "modelRequested": requested, "recordedCalls": activity.len(), "succeeded": ok, "failed": failed, "refusedOrDenied": denied,
        "note": "a model request names a tool; a recorded call is what the controller authorized and tried; a controller attempt is one provider request",
        "byTool": by_tool.iter().map(|(k, v)| json!({"tool": k, "calls": v.0, "succeeded": v.1, "failed": v.2, "refusedOrDenied": v.3})).collect::<Vec<_>>(),
        "executionMs": tool_ms, "approvalWaitMs": wait_ms,
        "buildAndTestMs": have_tools.then(|| tools.iter().filter(|t| t.verification_command).map(|t| t.exec_ms).sum::<u64>()),
        "fileEdits": {"proposed": edits.0, "applied": edits.1, "conflicts": run.changed_files.iter().filter(|c| c.status.contains("conflict")).count()},
        "commandsTotal": activity.iter().filter(|a| a.tool == "proc_run").count(),
        "commandsOmitted": activity.iter().filter(|a| a.tool == "proc_run").count().saturating_sub(commands.len()),
        "commands": commands,
        "dependencyInstalls": {"requests": installs.0, "approved": installs.1, "denied": installs.2, "automatic": installs.3, "ledger": run.dependencies},
        "permissionPrompts": prompts,
    });

    // ---------------- verification
    let ver_cmds: Vec<&ToolActivity> = activity.iter().filter(|a| is_build_or_test(a)).collect();
    let failed_checks = ver_cmds
        .iter()
        .filter(|a| a.verification.as_deref() == Some("fail"))
        .count();
    let recovery_requests = reqs.iter().filter(|r| r.phase == "recovery").count();
    let co = run.coding_outcome.as_ref();
    let verification = json!({
        "cycles": ver_cmds.len(), "failedAttempts": failed_checks,
        "recoveryCycles": have_requests.then_some(recovery_requests),
        "providerRecoveries": run.recoveries,
        "finalVerification": co.map(|c| c.verification.clone()),
        "completion": run.completion,
        "lastTestVerification": run.last_test_verification,
        "unresolvedFailedChecks": run.unresolved_failed_checks,
        "evidence": ver_cmds.iter().take(MAX_LIST).map(|a| json!({"callIndex": a.index, "command": a.args_summary, "exitCode": a.exit_code, "verification": a.verification, "resultDigest": a.result_digest})).collect::<Vec<_>>(),
        "note": "derived from the controller's execution receipts, never from the model's final answer",
    });

    // ---------------- cost
    let actual: Option<u64> = (per_request_usage)
        .then(|| opt_sum(usages.iter().map(|u| u.and_then(|u| u.cost_micro_usd))))
        .flatten();
    let reporting = usages
        .iter()
        .filter(|u| u.is_some_and(|u| u.cost_micro_usd.is_some()))
        .count();
    let mut est_micro: Option<f64> = Some(0.0);
    let mut est_by_model: BTreeMap<String, f64> = BTreeMap::new();
    for r in &reqs {
        let price = prices.iter().find(|p| {
            p.provider == r.provider
                && (p.model == r.model || r.actual_model.as_deref() == Some(p.model.as_str()))
        });
        let line = match (price, &r.usage) {
            (Some(p), Some(u)) => {
                let cached = u.cached_input.unwrap_or(0).min(u.input);
                let billed_cached = p.cached_input_per_mtok.map(|c| (cached as f64, c));
                let (uncached, cached_cost) = match billed_cached {
                    Some((c, price)) => ((u.input - cached) as f64, c * price),
                    None if u.cached_input.is_some() => {
                        // a cached-token price was not given: the estimate cannot split billing, so it is unknown
                        est_micro = None;
                        break;
                    }
                    None => (u.input as f64, 0.0),
                };
                let write = u
                    .cache_write
                    .zip(p.cache_write_per_mtok)
                    .map(|(w, pr)| w as f64 * pr)
                    .unwrap_or(0.0);
                Some(
                    (uncached * p.input_per_mtok
                        + cached_cost
                        + write
                        + u.output as f64 * p.output_per_mtok)
                        / 1.0,
                )
            }
            _ => None,
        };
        match line {
            Some(c) => {
                est_micro = est_micro.map(|e| e + c);
                *est_by_model
                    .entry(format!("{}/{}", r.provider, r.model))
                    .or_default() += c;
            }
            None => {
                est_micro = None;
                break;
            }
        }
    }
    let est_usd = est_micro
        .filter(|_| have_requests)
        .map(|m| ((m / 1_000_000.0) * 1_000_000.0).round() / 1_000_000.0);
    if actual.is_none() {
        miss(
            "cost.actual",
            "the provider did not report a cost for every request",
        );
    }
    if est_usd.is_none() {
        miss(
            "cost.estimated",
            "no explicit pricing data covers every model used (pricing.json)",
        );
    }
    let list: Option<u64> = per_request_usage
        .then(|| opt_sum(usages.iter().map(|u| u.and_then(|u| u.list_cost_nano_usd))))
        .flatten();
    let cost = json!({
        "providerListPrice": {"usd": list.map(|n| n as f64 / 1_000_000_000.0), "source": "provider-reported list-price equivalent (usage.opencode.list_cost); what the tokens would cost at list price, not what was billed"},
        "actual": {"usd": actual.map(|m| m as f64 / 1_000_000.0), "source": "provider-reported", "requestsReporting": reporting, "requestsTotal": reqs.len()},
        "estimated": {"usd": est_usd, "source": "explicit pricing data (pricing.json), tokens x price", "byModel": est_by_model},
        "display": if actual.is_some() { "actual" } else if est_usd.is_some() { "estimated" } else { "unknown" },
        "note": "an estimate is never shown as an actual cost; unknown is not zero",
    });

    // ---------------- efficiency (schema v2)
    let efficiency = efficiency(
        run,
        activity,
        &reqs,
        have_tools.then_some(tools.iter().map(|t| t.exec_ms).sum()),
        controller_ms,
        tps,
        &mut missing,
    );

    let identity = json!({
        "runId": run.run_id, "threadId": run.thread_id, "intentType": run.intent_type,
        "reasoningReplay": if run.reasoning_replay.is_empty() { Value::Null } else { json!(run.reasoning_replay) },
        "engine": engine,
        "permissionMode": if run.permission_mode.is_empty() { Value::Null } else { json!(run.permission_mode) },
        "host": host,
        "controllerVersion": env!("CARGO_PKG_VERSION"),
    });
    Analytics {
        schema_version: SCHEMA_VERSION,
        run_id: run.run_id.clone(),
        generated_at_ms: now_ms(),
        source: json!({"perRequestRecord": have_requests, "perToolRecord": have_tools, "runRecord": true, "toolActivity": !activity.is_empty()}),
        identity,
        runtime,
        tokens,
        routing,
        tools: tools_json,
        verification,
        cost,
        efficiency,
        missing,
    }
}

/// The versioned, machine-readable benchmark document of one run. Everything in it is also in the analytics; the
/// envelope adds the schema identifier and the rules of the format, so documents from different releases compare.
pub fn export_document(a: &Analytics, run: &IntentRun) -> Value {
    json!({
        "schema": "nexus.run-analytics",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAtMs": a.generated_at_ms,
        "generator": {"component": "nexus-broker", "version": env!("CARGO_PKG_VERSION")},
        "rules": [
            "a metric that could not be measured is null and listed in `missing` with its reason; it is never zero",
            "durations are milliseconds, timestamps are unix milliseconds, costs are US dollars",
            "runtime.categoriesExclusive add up to the wall clock; runtime.overlapping must not be added to them",
            "tokens.cachedInput is a subset of tokens.input; tokens.reasoning is a subset of tokens.output",
            "cost.estimated is never an actual cost",
        ],
        "run": {
            "runId": run.run_id, "state": run.state, "terminal": run.terminal,
            "startedAtMs": run.created_at_ms, "endedAtMs": run.terminal.then_some(run.updated_at_ms),
        },
        "identity": a.identity,
        "source": a.source,
        "runtime": a.runtime,
        "tokens": a.tokens,
        "routing": a.routing,
        "tools": a.tools,
        "verification": a.verification,
        "cost": a.cost,
        "efficiency": a.efficiency,
        "missing": a.missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn usage(i: u64, o: u64, cached: Option<u64>, reasoning: Option<u64>) -> UsageRec {
        UsageRec {
            input: i,
            output: o,
            cached_input: cached,
            reasoning,
            ..Default::default()
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn req(
        ord: u32,
        model: &str,
        phase: &str,
        outcome: &str,
        lat: u64,
        ttft: Option<u64>,
        u: Option<UsageRec>,
        calls: u32,
    ) -> Ev {
        Ev::Request(RequestRec {
            ordinal: ord,
            turn: ord,
            started_at_ms: 1_000 * ord as u64,
            ended_at_ms: 1_000 * ord as u64 + lat,
            latency_ms: lat,
            ttft_ms: ttft,
            provider: "opencode-go".into(),
            model: model.into(),
            effort: "high".into(),
            phase: phase.into(),
            outcome: outcome.into(),
            usage: u,
            tool_calls_requested: calls,
            ..Default::default()
        })
    }

    fn tool(index: u32, exec: u64, wait: u64, verify: bool) -> Ev {
        Ev::Tool(ToolRec {
            index,
            tool: "proc_run".into(),
            exec_ms: exec,
            wait_ms: wait,
            status: "executed".into(),
            verification_command: verify,
            ..Default::default()
        })
    }

    fn run(terminal: bool) -> IntentRun {
        IntentRun {
            run_id: "run_t".into(),
            created_at_ms: 10_000,
            updated_at_ms: 70_000,
            terminal,
            state: if terminal {
                "completed".into()
            } else {
                "tool-running".into()
            },
            ..Default::default()
        }
    }

    fn act(
        index: u32,
        status: &str,
        exit: Option<i64>,
        verification: Option<&str>,
    ) -> ToolActivity {
        ToolActivity {
            index,
            tool: "proc_run".into(),
            status: status.into(),
            exit_code: exit,
            verification: verification.map(str::to_owned),
            args_summary: format!("cmd{index}"),
            ..Default::default()
        }
    }

    fn a(r: &IntentRun, acts: &[ToolActivity], evs: &[Ev]) -> Analytics {
        analyze(r, acts, evs, false, &[], &Value::Null, &Value::Null)
    }

    #[test]
    fn cache_accounting_counts_cached_once_and_keeps_reasoning_inside_output() {
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                4000,
                Some(500),
                Some(usage(200, 50, Some(100), Some(20))),
                1,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                3000,
                Some(400),
                Some(usage(100, 30, Some(50), Some(10))),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs);
        let t = &x.tokens;
        assert_eq!(
            (
                t["input"].as_u64(),
                t["output"].as_u64(),
                t["total"].as_u64()
            ),
            (Some(300), Some(80), Some(380))
        );
        assert_eq!(t["cachedInput"], 150);
        assert_eq!(t["noncachedInput"], 150);
        assert_eq!(t["cacheHitRate"], 0.5);
        assert_eq!(t["reasoning"], 30);
        assert_eq!(
            t["total"], 380,
            "reasoning is a subset of output: not added again"
        );
        assert_eq!(t["source"], "per-request");
    }

    #[test]
    fn partial_cache_reporting_makes_the_total_unknown_not_smaller() {
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1000,
                None,
                Some(usage(200, 50, Some(100), None)),
                0,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                1000,
                None,
                Some(usage(100, 30, None, None)),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs);
        assert!(
            x.tokens["cachedInput"].is_null()
                && x.tokens["cacheHitRate"].is_null()
                && x.tokens["noncachedInput"].is_null()
        );
        assert_eq!(x.tokens["input"], 300);
        assert!(x
            .missing
            .iter()
            .any(|m| m["metric"] == "tokens.cachedInput"));
    }

    #[test]
    fn a_request_without_usage_falls_back_to_the_run_records_cumulative_figures() {
        let evs = vec![req(1, "m1", "work", "failed", 1000, None, None, 0)];
        let mut r = run(true);
        r.usage_input_tokens = Some(900);
        r.usage_output_tokens = Some(90);
        let x = a(&r, &[], &evs);
        assert_eq!(x.tokens["source"], "run-record-cumulative");
        assert_eq!(x.tokens["input"], 900);
        assert!(
            x.tokens["cachedInput"].is_null(),
            "no per-request usage: cache is unknown, not zero"
        );
    }

    #[test]
    fn mixed_models_are_broken_down_and_switches_counted_with_the_serving_model_preferred() {
        let mut r2 = req(
            2,
            "m2",
            "work",
            "answered",
            2000,
            None,
            Some(usage(50, 10, None, None)),
            0,
        );
        if let Ev::Request(x) = &mut r2 {
            x.actual_model = Some("m2-served".into());
        }
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1000,
                Some(100),
                Some(usage(100, 20, Some(0), None)),
                1,
            ),
            r2,
            req(
                3,
                "m1",
                "recovery",
                "answered",
                1000,
                None,
                Some(usage(10, 5, None, None)),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs);
        let bm = x.tokens["byModel"].as_array().unwrap();
        assert_eq!(bm.len(), 2);
        let m1 = bm.iter().find(|m| m["model"] == "opencode-go/m1").unwrap();
        assert_eq!(
            (m1["requests"].as_u64(), m1["inputTokens"].as_u64()),
            (Some(2), Some(110))
        );
        assert_eq!(x.routing["modelSwitches"], 2);
        assert_eq!(x.routing["requests"][1]["actualModel"], "m2-served");
        assert_eq!(x.routing["requests"][1]["routedAsConfigured"], false);
    }

    #[test]
    fn retries_and_failed_requests_still_count_their_tokens_and_phases_split_the_totals() {
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "truncated",
                3000,
                Some(200),
                Some(usage(500, 400, None, None)),
                0,
            ),
            req(
                2,
                "m1",
                "recovery",
                "answered",
                2000,
                Some(200),
                Some(usage(520, 100, None, None)),
                1,
            ),
            req(
                3,
                "m1",
                "verification",
                "answered",
                1500,
                Some(150),
                Some(usage(540, 40, None, None)),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs);
        assert_eq!(x.tokens["input"], 1560);
        let ph = x.tokens["byPhase"].as_array().unwrap();
        let sum: u64 = ph.iter().map(|p| p["inputTokens"].as_u64().unwrap()).sum();
        assert_eq!(
            sum, 1560,
            "phases partition the requests: nothing counted twice"
        );
        assert_eq!(x.verification["recoveryCycles"], 1);
        assert_eq!(
            x.tools["modelRequested"], 1,
            "a request names a tool; that is not an execution"
        );
    }

    #[test]
    fn timing_categories_add_up_to_the_wall_clock_and_overlaps_are_kept_apart() {
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                10_000,
                Some(1_000),
                Some(usage(10, 90, None, None)),
                1,
            ),
            tool(1, 5_000, 2_000, true),
            req(
                2,
                "m1",
                "work",
                "answered",
                20_000,
                Some(2_000),
                Some(usage(10, 180, None, None)),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs); // wall = 70_000 - 10_000 = 60_000
        let c = &x.runtime["categoriesExclusive"];
        assert_eq!(
            (
                c["modelRequestMs"].as_u64(),
                c["toolExecutionMs"].as_u64(),
                c["approvalWaitMs"].as_u64()
            ),
            (Some(30_000), Some(5_000), Some(2_000))
        );
        assert_eq!(c["controllerMs"], 60_000 - 37_000);
        assert_eq!(x.runtime["wallMs"], 60_000);
        let o = &x.runtime["overlapping"];
        assert_eq!(o["buildAndTestMs"], 5_000);
        assert_eq!(o["timeToFirstTokenMs"]["avg"], 1_500);
        // end to end: 270 output tokens over 30_000 ms of request time
        assert_eq!(x.runtime["outputTokensPerSecond"], 9.0);
        assert_eq!(x.runtime["requests"]["avgLatencyMs"], 15_000);
    }

    #[test]
    fn an_interrupted_run_is_analysed_up_to_where_it_stopped_and_says_it_has_not_ended() {
        let evs = vec![req(
            1,
            "m1",
            "work",
            "answered",
            1000,
            None,
            Some(usage(5, 5, None, None)),
            0,
        )];
        let x = a(&run(false), &[], &evs);
        assert!(x.runtime["wallMs"].is_null() && x.runtime["endedAtMs"].is_null());
        assert!(x.missing.iter().any(|m| m["metric"] == "runtime.end"));
        assert_eq!(x.tokens["input"], 5);
    }

    #[test]
    fn a_historical_run_gets_what_its_record_holds_and_unavailable_for_the_rest() {
        let mut r = run(true);
        r.usage_input_tokens = Some(1000);
        r.usage_output_tokens = Some(100);
        let acts = vec![
            act(1, "executed", Some(0), Some("pass")),
            act(2, "refused", None, None),
        ];
        let x = a(&r, &acts, &[]);
        assert_eq!(x.source["perRequestRecord"], false);
        assert!(x.runtime["categoriesExclusive"]["modelRequestMs"].is_null());
        assert!(x.runtime["categoriesExclusive"]["controllerMs"].is_null());
        assert_eq!(
            x.runtime["wallMs"], 60_000,
            "the run record has a start and an end"
        );
        assert_eq!(x.tokens["source"], "run-record-cumulative");
        assert_eq!(x.tools["recordedCalls"], 2);
        assert_eq!(x.tools["succeeded"], 1);
        assert_eq!(x.tools["refusedOrDenied"], 1);
        assert!(x.tools["executionMs"].is_null());
        assert_eq!(x.cost["display"], "unknown");
        assert!(x.missing.len() >= 4);
    }

    #[test]
    fn verification_comes_from_receipts_never_from_the_answer() {
        let acts = vec![
            act(1, "executed", Some(101), Some("fail")),
            act(2, "executed", Some(0), Some("pass")),
            act(3, "executed", Some(0), Some("run-pass")),
        ];
        let mut r = run(true);
        r.completion = Some("fulfilled".into());
        let x = a(&r, &acts, &[]);
        assert_eq!(x.verification["cycles"], 2);
        assert_eq!(x.verification["failedAttempts"], 1);
        assert_eq!(x.verification["evidence"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn cost_is_unknown_unless_reported_or_priced_and_an_estimate_is_never_an_actual() {
        let u = |c: Option<u64>| UsageRec {
            input: 1_000_000,
            output: 100_000,
            cached_input: Some(900_000),
            cost_micro_usd: c,
            ..Default::default()
        };
        let all = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(u(Some(2_500_000))),
                0,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(u(Some(500_000))),
                0,
            ),
        ];
        let x = a(&run(true), &[], &all);
        assert_eq!(x.cost["actual"]["usd"], 3.0);
        assert_eq!(x.cost["display"], "actual");
        assert!(x.cost["estimated"]["usd"].is_null());
        // one request without a reported cost: no actual total (unknown, not smaller)
        let part = vec![
            req(1, "m1", "work", "answered", 1, None, Some(u(Some(1))), 0),
            req(2, "m1", "work", "answered", 1, None, Some(u(None)), 0),
        ];
        let y = a(&run(true), &[], &part);
        assert!(y.cost["actual"]["usd"].is_null());
        assert_eq!(y.cost["actual"]["requestsReporting"], 1);
        assert_eq!(y.cost["display"], "unknown");
        // explicit pricing gives an estimate, labelled as one
        let prices = vec![Price {
            provider: "opencode-go".into(),
            model: "m1".into(),
            input_per_mtok: 1.0,
            output_per_mtok: 4.0,
            cached_input_per_mtok: Some(0.1),
            cache_write_per_mtok: None,
        }];
        let z = analyze(
            &run(true),
            &[],
            &part,
            false,
            &prices,
            &Value::Null,
            &Value::Null,
        );
        // per request: 100k uncached * 1 + 900k cached * 0.1 + 100k out * 4 = 100k + 90k + 400k = 590k micro-USD
        assert_eq!(z.cost["estimated"]["usd"], 1.18);
        assert_eq!(z.cost["display"], "estimated");
        assert!(z.cost["actual"]["usd"].is_null());
    }

    #[test]
    fn the_providers_list_price_equivalent_is_reported_beside_a_plan_billed_cost_of_zero() {
        let u = |list: Option<u64>| UsageRec {
            input: 10,
            output: 5,
            cost_micro_usd: Some(0),
            list_cost_nano_usd: list,
            ..Default::default()
        };
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(u(Some(457_100))),
                0,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(u(Some(97_610))),
                0,
            ),
        ];
        let x = a(&run(true), &[], &evs);
        assert_eq!(
            x.cost["actual"]["usd"], 0.0,
            "the provider's own cost is zero (plan billed) and is shown as reported"
        );
        assert_eq!(x.cost["providerListPrice"]["usd"], 0.00055471);
        let partial = vec![
            req(1, "m1", "work", "answered", 1, None, Some(u(Some(1))), 0),
            req(2, "m1", "work", "answered", 1, None, Some(u(None)), 0),
        ];
        assert!(
            a(&run(true), &[], &partial).cost["providerListPrice"]["usd"].is_null(),
            "one request without it: unknown, not smaller"
        );
    }

    #[test]
    fn the_record_survives_a_restart_a_torn_last_line_and_a_cap() {
        let d = tempfile::tempdir().unwrap();
        let ev = req(
            1,
            "m1",
            "work",
            "answered",
            1000,
            None,
            Some(usage(5, 5, None, None)),
            0,
        );
        append(d.path(), "run_p", &ev);
        append(d.path(), "run_p", &tool(1, 10, 0, false));
        // a crash in the middle of the next write leaves half a line
        let p = d.path().join("telemetry/run_p.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"k\":\"request\",\"ordinal\":2,\"tu")
            .unwrap();
        drop(f);
        let (evs, capped) = load(d.path(), "run_p");
        assert_eq!(evs.len(), 2);
        assert!(!capped);
        assert_eq!(evs[0], ev);
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // unusable run ids never touch the filesystem
        append(d.path(), "../escape", &ev);
        assert!(!d.path().join("escape.jsonl").exists());
        assert!(load(d.path(), "run_none").0.is_empty());
    }

    #[test]
    fn the_export_is_versioned_complete_and_carries_no_secret() {
        let secret = "sk-LEAK-CHECK-123";
        let (u, raw) = nexus_model::parse_usage(
            &json!({"input_tokens": 10, "output_tokens": 5, "api_key": secret, "authorization": secret}),
        );
        let d = nexus_client::UsageDetail {
            usage: u,
            raw: Some(raw),
            actual_model: Some("m1-served".into()),
        };
        let evs = vec![Ev::Request(RequestRec {
            ordinal: 1,
            turn: 1,
            provider: "p".into(),
            model: "m1".into(),
            effort: "high".into(),
            phase: "work".into(),
            outcome: "answered".into(),
            usage: Some(usage_rec(&d)),
            ..Default::default()
        })];
        let mut r = run(true);
        r.permission_mode = "ask".into();
        let an = a(&r, &[], &evs);
        let doc = export_document(&an, &r);
        let text = doc.to_string();
        assert!(
            !text.contains(secret) && !text.contains("authorization") && !text.contains("api_key")
        );
        assert_eq!(doc["schema"], "nexus.run-analytics");
        // M4.7: schema v2 is additive: every v1 section is still present, `efficiency` is new
        assert_eq!(doc["schemaVersion"], 2);
        for k in [
            "efficiency",
            "run",
            "identity",
            "runtime",
            "tokens",
            "routing",
            "tools",
            "verification",
            "cost",
            "missing",
            "rules",
            "generator",
        ] {
            assert!(doc.get(k).is_some(), "missing section {k}");
        }
        assert_eq!(doc["identity"]["permissionMode"], "ask");
        // round trip: nothing is lost or fabricated by serialization
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn no_double_counting_between_the_run_record_and_the_per_request_sum() {
        let evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(usage(100, 10, None, None)),
                0,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                1,
                None,
                Some(usage(50, 5, None, None)),
                0,
            ),
        ];
        let mut r = run(true);
        r.usage_input_tokens = Some(150);
        r.usage_output_tokens = Some(15);
        let x = a(&r, &[], &evs);
        assert_eq!(
            x.tokens["input"], 150,
            "the per-request sum, not summed with the cumulative figure"
        );
        assert_eq!(x.tokens["reconciliation"]["matches"], true);
        r.usage_input_tokens = Some(999);
        let y = a(&r, &[], &evs);
        assert_eq!(
            y.tokens["reconciliation"]["matches"], false,
            "a mismatch is reported, never hidden"
        );
        assert_eq!(y.tokens["input"], 150);
    }

    #[test]
    fn telemetry_costs_little_per_request_and_the_record_stays_small() {
        let d = tempfile::tempdir().unwrap();
        let n = 500u32;
        let t0 = std::time::Instant::now();
        for i in 1..=n {
            let mut u = usage(4000 + i as u64, 90, Some(3500), Some(10));
            u.raw = Some(
                json!({"input_tokens": 4000, "output_tokens": 90, "input_tokens_details": {"cached_tokens": 3500}, "output_tokens_details": {"reasoning_tokens": 10}, "opencode": {"tokens": {"input": 500, "output": 90}}}),
            );
            append(
                d.path(),
                "run_o",
                &req(i, "m1", "work", "answered", 1500, Some(300), Some(u), 1),
            );
            append(d.path(), "run_o", &tool(i, 120, 0, i % 3 == 0));
        }
        let append_us = t0.elapsed().as_micros() as f64 / (2.0 * n as f64);
        let size = std::fs::metadata(d.path().join("telemetry/run_o.jsonl"))
            .unwrap()
            .len();
        let t1 = std::time::Instant::now();
        let (evs, _) = load(d.path(), "run_o");
        let x = a(&run(true), &[], &evs);
        let derive_ms = t1.elapsed().as_secs_f64() * 1000.0;
        println!("TELEMETRY-OVERHEAD append={append_us:.0}us/record record={}B/request analyze({n} requests)={derive_ms:.1}ms", size / n as u64);
        assert!(append_us < 5_000.0, "an append took {append_us} us");
        assert!(derive_ms < 2_000.0, "deriving took {derive_ms} ms");
        assert!(size / (n as u64) < 2_000, "{size} bytes for {n} requests");
        assert_eq!(x.runtime["requests"]["count"], 500);
    }

    #[test]
    fn phases_are_labelled_from_what_the_controller_just_did() {
        assert_eq!(phase_of(false, false, false), "work");
        assert_eq!(phase_of(true, false, false), "verification");
        assert_eq!(phase_of(true, true, false), "recovery");
        assert_eq!(phase_of(false, false, true), "recovery");
    }

    /// M4.7: cache-break attribution, the decode throughput (by its own definition), pre-send timing, and no
    /// fabricated figure for a request that carries none of it.
    #[test]
    fn m47_efficiency_attributes_cache_breaks_and_names_its_definitions() {
        let mut evs = vec![
            req(
                1,
                "m1",
                "work",
                "answered",
                1100,
                Some(100),
                Some(usage(1000, 10, Some(0), Some(2))),
                1,
            ),
            req(
                2,
                "m1",
                "work",
                "answered",
                1100,
                Some(100),
                Some(usage(2000, 10, Some(900), Some(2))),
                1,
            ),
            req(
                3,
                "m1",
                "work",
                "answered",
                // the only request long enough for a decode sample: 400 visible tokens over 2 s
                2100,
                Some(100),
                Some(usage(3000, 402, Some(1100), Some(2))),
                0,
            ),
        ];
        let causes = ["first-request", "none", "reasoning-replay"];
        for (e, c) in evs.iter_mut().zip(causes) {
            if let Ev::Request(r) = e {
                r.prefix = Some(PrefixRec {
                    items: 3,
                    stable: c != "reasoning-replay",
                    diverge_at: None,
                    cause: c.into(),
                });
                r.pre_send = Some(PreSendRec {
                    attempt_ms: 5,
                    total_ms: 20,
                    ..Default::default()
                });
            }
        }
        let r = run(true);
        let an = a(&r, &[], &evs);
        let e = &an.efficiency;
        let by = e["cacheBreaks"]["byCause"].as_array().unwrap();
        let get = |c: &str| {
            by.iter().find(|x| x["cause"] == c).unwrap()["uncachedInput"]
                .as_u64()
                .unwrap()
        };
        assert_eq!(get("reasoning-replay"), 1900);
        assert_eq!(get("none"), 1100);
        assert_eq!(e["cacheBreaks"]["stablePrefix"], 2);
        assert_eq!(e["controller"]["preSend"]["totalMs"], 60);
        assert_eq!(e["throughput"]["comparableWithDsh"], false);
        assert_eq!(e["throughput"]["decodeSamples"], 1);
        assert!(
            e["throughput"]["decodeOutputTokensPerSecond"]
                .as_f64()
                .unwrap()
                == 200.0
        );
        // a historical run (no prefix, no pre-send records): null with a reason, never zero
        let old = a(
            &r,
            &[],
            &[req(
                1,
                "m1",
                "work",
                "answered",
                1000,
                Some(100),
                Some(usage(1000, 10, Some(0), None)),
                0,
            )],
        );
        assert!(old.efficiency["cacheBreaks"].is_null());
        assert!(old
            .missing
            .iter()
            .any(|m| m["metric"] == "efficiency.cacheBreaks"));
        assert!(old.efficiency["controller"]["preSend"].is_null());
    }

    /// M4.7: a guest clock that jumps during a run is reported, and the durations use the monotonic figure.
    #[test]
    fn m47_a_wall_clock_jump_is_reported_and_does_not_inflate_controller_time() {
        let mut r = run(true);
        r.updated_at_ms = r.created_at_ms + 1_719_289;
        r.run_elapsed_ms = Some(154_797);
        let an = a(&r, &[], &[]);
        assert_eq!(an.runtime["wallMs"], 154_797);
        assert_eq!(an.runtime["wallBasis"], "monotonic");
        assert_eq!(an.runtime["clockSkewMs"], 1_719_289 - 154_797);
        assert!(an
            .missing
            .iter()
            .any(|m| m["metric"] == "runtime.wallClock"));
        // a run without the monotonic record keeps the wall clock, and says so
        let old = a(&run(true), &[], &[]);
        assert_eq!(old.runtime["wallBasis"], "wall-clock");
        assert!(old.runtime["clockSkewMs"].is_null());
    }
}
