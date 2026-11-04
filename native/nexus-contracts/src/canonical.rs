//! Canonical JSON and digest layering.
//! Matches JS resolver.canonicalize: sorted keys, JSON scalar encoding.
//! Lease and timestamps are excluded from identity digests.

use std::collections::BTreeMap;

pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_owned(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => serde_json::to_string(s).expect("string serializes"),
        serde_json::Value::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(canonical_json(item));
            }
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut parts = Vec::with_capacity(keys.len());
            for k in keys {
                let key = serde_json::to_string(k).expect("key serializes");
                parts.push(format!("{}:{}", key, canonical_json(&map[k])));
            }
            format!("{{{}}}", parts.join(","))
        }
    }
}

pub fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(text.as_bytes()))
}

pub fn digest_value(value: &serde_json::Value) -> String {
    sha256_hex(&canonical_json(value))
}

pub fn payload_digest_of(payload: &serde_json::Value) -> String {
    digest_value(payload)
}

#[allow(clippy::too_many_arguments)]
pub fn intent_digest_of(
    task: &str,
    attempt: &str,
    command: &str,
    backend: &str,
    revision: u64,
    role: &str,
    mode: &str,
    mode_rev: &serde_json::Value,
    payload_digest: &str,
) -> String {
    let mut m = BTreeMap::new();
    m.insert("attemptId", serde_json::Value::String(attempt.to_owned()));
    m.insert("backend", serde_json::Value::String(backend.to_owned()));
    m.insert("commandId", serde_json::Value::String(command.to_owned()));
    m.insert("controllerRevision", serde_json::Value::from(revision));
    m.insert("modeConfigRevision", mode_rev.clone());
    m.insert("modeId", serde_json::Value::String(mode.to_owned()));
    m.insert(
        "payloadDigest",
        serde_json::Value::String(payload_digest.to_owned()),
    );
    m.insert("role", serde_json::Value::String(role.to_owned()));
    m.insert("taskInstanceId", serde_json::Value::String(task.to_owned()));
    let obj = serde_json::Value::Object(m.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
    digest_value(&obj)
}

pub fn command_digest_of(
    intent_digest: &str,
    target_digest: &str,
    snapshot_digest: &str,
    lease_epoch: u64,
    incarnation: &str,
) -> String {
    let mut m = BTreeMap::new();
    m.insert(
        "intentDigest",
        serde_json::Value::String(intent_digest.to_owned()),
    );
    m.insert("leaseEpoch", serde_json::Value::from(lease_epoch));
    m.insert(
        "snapshotDigest",
        serde_json::Value::String(snapshot_digest.to_owned()),
    );
    m.insert(
        "storeIncarnation",
        serde_json::Value::String(incarnation.to_owned()),
    );
    m.insert(
        "targetDigest",
        serde_json::Value::String(target_digest.to_owned()),
    );
    let obj = serde_json::Value::Object(m.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
    digest_value(&obj)
}

pub fn snapshot_digest_of(snapshot: &serde_json::Value) -> String {
    digest_value(snapshot)
}
pub fn target_digest_of(target: &serde_json::Value) -> String {
    digest_value(target)
}
