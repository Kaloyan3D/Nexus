use crate::canonical::{canonical_json, command_digest_of, intent_digest_of, payload_digest_of};
use crate::errors::KernelErrorCode;
use crate::target::ExecutionTargetCoreV1;
use crate::types::ControllerIntentV1;

#[test]
fn canonical_sorts_keys() {
    let v = serde_json::json!({"b": 1, "a": [3, 2, {"y": "q", "x": 1}]});
    assert_eq!(
        canonical_json(&v),
        "{\"a\":[3,2,{\"x\":1,\"y\":\"q\"}],\"b\":1}"
    );
}

#[test]
fn scalars_match_json_encoding() {
    assert_eq!(canonical_json(&serde_json::json!(1.5)), "1.5");
    assert_eq!(canonical_json(&serde_json::json!(null)), "null");
    assert_eq!(canonical_json(&serde_json::json!(true)), "true");
    assert_eq!(canonical_json(&serde_json::json!(-2)), "-2");
}

#[test]
fn digest_layering_is_stable() {
    let payload = serde_json::json!({"op": "engineer-turn"});
    let pd = payload_digest_of(&payload);
    let id = intent_digest_of(
        "t",
        "a",
        "c",
        "native",
        1,
        "r",
        "m",
        &serde_json::json!(3),
        &pd,
    );
    let cd = command_digest_of(&id, "td", "sd", 1, "incarnation");
    assert_eq!(pd.len(), 64);
    assert_eq!(id.len(), 64);
    assert_eq!(cd.len(), 64);
    assert_eq!(payload_digest_of(&payload), pd);
}

#[test]
fn incomplete_target_fails_closed() {
    let mut target =
        ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(3));
    target.route_id = String::new();
    assert_eq!(
        target.validate_complete().unwrap_err().code,
        KernelErrorCode::TargetIncomplete
    );
}

#[test]
fn unsupported_target_schema_refused() {
    let mut target =
        ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(3));
    target.schema_version = 99;
    assert_eq!(
        target.validate_complete().unwrap_err().code,
        KernelErrorCode::UnsupportedSchema
    );
}

#[test]
fn tampered_payload_detected() {
    let mut intent = ControllerIntentV1::build(
        "t",
        "a",
        "c",
        "native",
        1,
        "r",
        "m",
        serde_json::json!(0),
        serde_json::json!({"op": "x"}),
    );
    intent.intent_payload = serde_json::json!({"op": "smuggled"});
    assert_eq!(
        intent.verify_integrity().unwrap_err().code,
        KernelErrorCode::PayloadTamper
    );
}

#[test]
fn cross_language_canonical_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test-vectors/canonical-vectors.json"
    );
    let text = std::fs::read_to_string(path).expect("vectors file must exist");
    let doc: serde_json::Value = serde_json::from_str(&text).expect("vectors parse");
    let cases = doc.as_array().expect("array");
    assert!(!cases.is_empty(), "at least one vector");
    for case in cases {
        let input = &case["input"];
        let expected = case["canonical"].as_str().expect("canonical str");
        let expected_digest = case["sha256"].as_str().expect("sha256 str");
        assert_eq!(canonical_json(input), expected, "canonical mismatch");
        assert_eq!(
            crate::canonical::sha256_hex(&canonical_json(input)),
            expected_digest
        );
    }
}
