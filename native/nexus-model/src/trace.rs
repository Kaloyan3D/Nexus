//! Opt-in provider-boundary trace (P0 DSH vs Native investigation).
//!
//! `NEXUS_PROVIDER_TRACE=<file>` appends ONE JSON line per provider exchange with the
//! STRUCTURE of what crossed the boundary: request shape (item kinds and roles, byte sizes,
//! tool-catalog digest, effort, flags), timings (connect, upload and how often the upload
//! was held back by the provider, first byte, total), the stream's event types, the
//! response's output item kinds (with message phase, reasoning size, call names), usage
//! including cached and reasoning tokens, and the error code and transport message.
//!
//! Never recorded: message or tool text, arguments, results, headers, the credential. The
//! file is created 0600 and the trace stops growing past [`MAX_TRACE_BYTES`]. Tracing never
//! changes what is sent and a trace failure never affects the exchange.

use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

/// The trace file stops growing past this size.
pub const MAX_TRACE_BYTES: u64 = 64 * 1024 * 1024;

/// What the transport observed during one exchange (filled only while tracing).
#[derive(Debug, Default)]
pub struct Exchange {
    pub enabled: bool,
    pub connect_ms: Option<u128>,
    pub upload_ms: Option<u128>,
    /// 100 ms write slices that timed out because the provider was not draining the body.
    pub held_slices: u32,
    pub first_byte_ms: Option<u128>,
    pub raw: Vec<u8>,
    started: Option<Instant>,
}

impl Exchange {
    pub fn start() -> Self {
        let enabled = std::env::var_os("NEXUS_PROVIDER_TRACE").is_some_and(|v| !v.is_empty());
        Self {
            enabled,
            started: Some(Instant::now()),
            ..Default::default()
        }
    }
    pub fn elapsed_ms(&self) -> u128 {
        self.started.map(|s| s.elapsed().as_millis()).unwrap_or(0)
    }
}

fn digest(v: &Value) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(v))[..16].to_owned()
}

/// Request shape: kinds, roles, sizes - never text.
pub fn request_shape(body: &[u8]) -> Value {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return json!({"bytes": body.len(), "parsed": false});
    };
    let mut seq = String::new();
    let mut bytes = serde_json::Map::new();
    let mut counts = serde_json::Map::new();
    for it in v["input"].as_array().cloned().unwrap_or_default() {
        let kind = match (
            it["type"].as_str(),
            it["role"].as_str(),
            it["phase"].as_str(),
        ) {
            (Some("function_call"), ..) => "C",
            (Some("function_call_output"), ..) => "O",
            (Some("reasoning"), ..) => "R",
            (_, Some("assistant"), Some(_)) => "P",
            (_, Some("assistant"), None) => "A",
            (_, Some("user"), _) => "U",
            _ => "?",
        };
        seq.push_str(kind);
        let n = it.to_string().len() as u64;
        *bytes.entry(kind).or_insert(json!(0)) =
            json!(bytes.get(kind).and_then(Value::as_u64).unwrap_or(0) + n);
        *counts.entry(kind).or_insert(json!(0)) =
            json!(counts.get(kind).and_then(Value::as_u64).unwrap_or(0) + 1);
    }
    // run-length encode the item sequence (U A C O C O ... -> "U1 A1 C1 O1 ...")
    let mut rle = String::new();
    let mut chars = seq.chars().peekable();
    while let Some(c) = chars.next() {
        let mut n = 1;
        while chars.peek() == Some(&c) {
            chars.next();
            n += 1;
        }
        rle.push_str(&format!("{c}{n} "));
    }
    let tools = v.get("tools").cloned().unwrap_or(Value::Null);
    json!({
        "bytes": body.len(),
        "model": v["model"],
        "effort": v["reasoning"]["effort"],
        "maxOutputTokens": v["max_output_tokens"],
        "toolChoice": v["tool_choice"],
        "parallelToolCalls": v["parallel_tool_calls"],
        "include": v["include"],
        "store": v["store"],
        "tools": tools.as_array().map(|a| a.len()),
        "toolsDigest": if tools.is_null() { Value::Null } else { json!(digest(&tools)) },
        "items": counts,
        "itemBytes": bytes,
        "sequence": rle.trim_end(),
    })
}

/// Response structure from the raw HTTP bytes: status, event types, output items, usage.
pub fn response_shape(raw: &[u8]) -> Value {
    if raw.is_empty() {
        return json!({"bytes": 0});
    }
    let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return json!({"bytes": raw.len(), "head": false});
    };
    let head = String::from_utf8_lossy(&raw[..pos]).to_ascii_lowercase();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok());
    let body = &raw[pos + 4..];
    let body = if head.contains("transfer-encoding: chunked") {
        crate::transport::dechunk_prefix(body)
            .map(|(d, _)| d)
            .unwrap_or_default()
    } else {
        body.to_vec()
    };
    let text = String::from_utf8_lossy(&body);
    let mut events: Vec<(String, u64)> = Vec::new();
    let mut terminal = Value::Null;
    for line in text.lines() {
        let Some(p) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(f) = serde_json::from_str::<Value>(p.trim()) else {
            continue;
        };
        let t = f["type"].as_str().unwrap_or("?").to_owned();
        match events.last_mut() {
            Some((k, n)) if *k == t => *n += 1,
            _ => events.push((t.clone(), 1)),
        }
        if matches!(
            t.as_str(),
            "response.completed" | "response.incomplete" | "response.failed"
        ) {
            terminal = f["response"].clone();
        }
    }
    let output: Vec<Value> = terminal["output"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|it| match it["type"].as_str() {
            Some("reasoning") => json!({"type": "reasoning",
                "encryptedBytes": it["encrypted_content"].as_str().map(str::len),
                "summaryParts": it["summary"].as_array().map(Vec::len)}),
            Some("message") => json!({"type": "message", "phase": it["phase"],
                "chars": it["content"].as_array().map(|c| c.iter()
                    .map(|p| p["text"].as_str().map(str::len).unwrap_or(0)).sum::<usize>())}),
            Some("function_call") => json!({"type": "function_call", "name": it["name"],
                "callId": it["call_id"], "argBytes": it["arguments"].as_str().map(str::len)}),
            other => json!({"type": other}),
        })
        .collect();
    let u = &terminal["usage"];
    json!({
        "status": status,
        "bytes": raw.len(),
        "events": events.iter().map(|(k, n)| format!("{k}x{n}")).collect::<Vec<_>>(),
        "responseStatus": terminal["status"],
        "incomplete": terminal["incomplete_details"]["reason"],
        "responseId": terminal["id"].as_str().map(|v| v.chars().take(80).collect::<String>()),
        "output": output,
        "usage": {
            "input": u["input_tokens"], "output": u["output_tokens"],
            "cached": u["input_tokens_details"]["cached_tokens"],
            "reasoning": u["output_tokens_details"]["reasoning_tokens"],
        },
    })
}

/// Append one record. Best effort: any failure is silently ignored.
pub fn record(
    prepared: &crate::prepare::PreparedModelRequest,
    ex: &Exchange,
    outcome: Result<(), (&str, &str, bool)>,
) {
    if !ex.enabled {
        return;
    }
    let Some(path) = std::env::var_os("NEXUS_PROVIDER_TRACE").filter(|v| !v.is_empty()) else {
        return;
    };
    let path = std::path::PathBuf::from(path);
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_TRACE_BYTES {
        return;
    }
    let rec = json!({
        "v": 1,
        "atMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "attemptId": prepared.attempt_id,
        "requestDigest": prepared.request_digest,
        "path": prepared.endpoint_path,
        "request": request_shape(&prepared.request_bytes),
        "timing": {
            "connectMs": ex.connect_ms, "uploadMs": ex.upload_ms, "heldSlices": ex.held_slices,
            "firstByteMs": ex.first_byte_ms, "totalMs": ex.elapsed_ms(),
        },
        "response": response_shape(&ex.raw),
        "error": match outcome {
            Ok(()) => Value::Null,
            Err((code, message, sent)) => json!({"code": code, "message": message, "bytesSent": sent}),
        },
    });
    // Never follow a symlink planted at the trace path, and only ever append to a regular
    // file (same discipline as the protected credential file).
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(crate::transport::o_nofollow())
        .open(&path)
    {
        if f.metadata().map(|m| m.is_file()).unwrap_or(false) {
            let _ = writeln!(f, "{rec}");
        }
    }
}
