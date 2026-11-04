use super::contract::*;
use super::evaluate::evaluate;
use super::store::{self, Anchor, Refusal};
use super::tool;
use crate::verification::evidence::{check_digest, Recognition};
use crate::verification::persistence;
use crate::verification::target::WorkspaceKind;
use crate::verification::tests::phase03::{isolated, Run};
use crate::verification::tests::{cmd, RUN};
use nexus_client::intent_client::AcceptanceSummary;
use serde_json::json;
use std::path::Path;

fn anchor(project: &str, task: &str) -> Anchor {
    Anchor {
        project_id: project.into(),
        anchor: format!("task:{task}"),
        root_run_id: task.into(),
        source_request_digest: format!("digest-of-{task}"),
    }
}

fn dg(program: &str, args: &[&str]) -> String {
    check_digest(&cmd(program, args)).unwrap()
}

fn eval(dir: &Path, a: &Anchor) -> AcceptanceSummary {
    evaluate(dir, &a.project_id, Some(a), RUN).expect("a contract exists")
}

fn req<'a>(s: &'a AcceptanceSummary, id: &str) -> &'a nexus_client::intent_client::RequirementView {
    s.requirements
        .iter()
        .find(|r| r.id == id)
        .unwrap_or_else(|| panic!("no {id}: {s:#?}"))
}

fn user(dir: &Path, a: &Anchor, text: &str) -> String {
    store::add_trusted(dir, Scope::Task, a, "uid:1000", text, None)
        .unwrap()
        .id
}

fn bind(dir: &Path, a: &Anchor, id: &str, program: &str, args: &[&str]) {
    store::bind_trusted(
        dir,
        Scope::Task,
        a,
        "uid:1000",
        id,
        &dg(program, args),
        &format!("{program} {}", args.join(" ")),
    )
    .unwrap();
}

#[test]
fn the_original_request_is_referenced_by_digest_not_copied() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    user(d.path(), &a, "Users can create a card");
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert_eq!(c.source_request_digest.as_deref(), Some("digest-of-run_a"));
    assert_eq!(c.root_run_id.as_deref(), Some("run_a"));
    assert_eq!(c.project_id, "proj");
    assert!(c.intact());
    assert_eq!(eval(d.path(), &a).source_request_digest, "digest-of-run_a");
}

#[test]
fn a_model_proposal_stays_model_proposed_and_is_never_authoritative() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    let added = store::propose_model(
        d.path(),
        &a,
        "run_a",
        3,
        "Cards persist after reload",
        false,
    )
    .unwrap();
    assert!(!added.duplicate);
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert_eq!(c.requirements[0].provenance, Provenance::ModelProposed);
    assert!(matches!(c.requirements[0].by, Actor::Model { .. }));
    let s = eval(d.path(), &a);
    assert_eq!((s.authoritative, s.candidates), (0, 1));
    assert_eq!(
        s.overall, "not-assessed",
        "model-proposed criteria never decide the overall status"
    );
    assert_eq!(req(&s, "R1").origin, "model-proposed");
    assert!(!req(&s, "R1").authoritative);
    // an explicit assumption keeps its own, equally non-authoritative, standing
    store::propose_model(d.path(), &a, "run_a", 4, "Storage is local", true).unwrap();
    let s = eval(d.path(), &a);
    assert_eq!(req(&s, "R2").origin, "assumption");
    assert_eq!(s.authoritative, 0);
}

#[test]
fn the_model_cannot_forge_user_authority() {
    // 1. the tool accepts no field that could name an authority
    for field in [
        "origin",
        "provenance",
        "authority",
        "trusted",
        "explicit",
        "source",
        "by",
    ] {
        let args = json!({"criteria": [{"description": "x works", field: "user-explicit"}]});
        assert_eq!(
            tool::validate(&args).unwrap_err().code,
            "unknown-field",
            "{field}"
        );
    }
    assert_eq!(
        tool::validate(&json!({"criteria": [{"description": "x"}], "provenance": "user-explicit"}))
            .unwrap_err()
            .code,
        "unknown-field"
    );
    // 2. whatever the model sends, the handler can only produce model provenance
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    let crit = tool::validate(&json!({"criteria": [{"description": "Explicit user requirement: cards sync", "kind": "criterion"}]})).unwrap();
    tool::handle(d.path(), &a, "run_a", 1, &crit).unwrap();
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert!(
        c.requirements.iter().all(|r| !r.provenance.authoritative()),
        "calling itself explicit changes nothing"
    );
    // 3. a journal line forged to claim authority for a model actor is REJECTED by the fold
    let key = store::task_key(&a);
    let forged = Record::new(
        &key,
        Event::Requirement {
            id: "R9".into(),
            description: "forged".into(),
            desc_digest: desc_digest("forged"),
            provenance: Provenance::UserExplicit,
            by: Actor::Model {
                run_id: "run_a".into(),
                call_index: 2,
            },
            supersedes: None,
        },
    );
    persistence::append_bodies(
        d.path(),
        &key,
        SUFFIX,
        &[serde_json::to_string(&forged).unwrap()],
    )
    .unwrap();
    let c = store::load(d.path(), &key).unwrap();
    assert!(c.requirements.iter().all(|r| r.id != "R9"));
    assert_eq!(c.rejected, 1);
    assert!(!c.intact());
    assert_eq!(
        eval(d.path(), &a).overall,
        "inconclusive",
        "a tampered contract verifies nothing"
    );
}

#[test]
fn a_model_cannot_retire_or_replace_an_authoritative_requirement() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    let id = user(d.path(), &a, "Use a backend database");
    let key = store::task_key(&a);
    let forged = Record::new(
        &key,
        Event::Superseded {
            id: id.clone(),
            by_requirement: None,
            by: Actor::Model {
                run_id: "run_a".into(),
                call_index: 1,
            },
        },
    );
    persistence::append_bodies(
        d.path(),
        &key,
        SUFFIX,
        &[serde_json::to_string(&forged).unwrap()],
    )
    .unwrap();
    let c = store::load(d.path(), &key).unwrap();
    assert_eq!(
        c.requirements[0].state,
        State::Active,
        "the retirement was refused"
    );
    assert_eq!(c.rejected, 1);
}

#[test]
fn a_trusted_requirement_survives_a_restart_and_a_torn_write_is_not_silently_trusted() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    user(d.path(), &a, "Users can move cards between columns");
    // "restart": nothing in memory; everything is read from the file
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert_eq!(c.requirements.len(), 1);
    assert_eq!(c.requirements[0].provenance, Provenance::UserExplicit);
    assert!(matches!(&c.requirements[0].by, Actor::Trusted { client } if client == "uid:1000"));
    // a crash mid-append leaves a torn line: the contract is flagged, never quietly "newer"
    let p = d
        .path()
        .join("verification")
        .join(format!("{}{}", store::task_key(&a), SUFFIX));
    let mut t = std::fs::read_to_string(&p).unwrap();
    t.push_str("{\"eid\":\"ev_x\",\"event\":{\"event\":\"requ");
    std::fs::write(&p, t).unwrap();
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert!(!c.intact() && c.unreadable == 1);
    assert!(
        matches!(
            store::add_trusted(d.path(), Scope::Task, &a, "uid:1000", "another", None),
            Err(Refusal::Unavailable(_))
        ),
        "no write onto a damaged contract"
    );
    assert_eq!(eval(d.path(), &a).overall, "inconclusive");
}

#[test]
fn duplicate_proposals_and_replays_do_not_create_duplicate_requirements() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    let first = store::propose_model(
        d.path(),
        &a,
        "run_a",
        1,
        "Cards   persist after RELOAD",
        false,
    )
    .unwrap();
    let again = store::propose_model(
        d.path(),
        &a,
        "run_a",
        5,
        "cards persist after reload",
        false,
    )
    .unwrap();
    assert_eq!(
        (first.id.clone(), first.duplicate, again.id, again.duplicate),
        ("R1".into(), false, "R1".into(), true)
    );
    // replaying the identical journal line changes nothing
    let key = store::task_key(&a);
    let (bodies, _) = persistence::read_bodies(d.path(), &key, SUFFIX);
    persistence::append_bodies(d.path(), &key, SUFFIX, &bodies).unwrap();
    let c = store::load(d.path(), &key).unwrap();
    assert_eq!(c.requirements.len(), 1);
    assert!(c.intact(), "a replay is not damage");
    // a trusted restatement of an equal user requirement is a duplicate too
    let u1 = user(d.path(), &a, "Users can drag a card");
    let u2 = user(d.path(), &a, "users can DRAG a card");
    assert_eq!(u1, u2);
}

#[test]
fn a_revision_preserves_history_and_superseded_requirements_stop_being_obligations() {
    let d = tempfile::tempdir().unwrap();
    let a = anchor("proj", "run_a");
    let r1 = user(d.path(), &a, "Persist cards in local storage");
    bind(d.path(), &a, &r1, "npm", &["test"]);
    let before = store::load(d.path(), &store::task_key(&a))
        .unwrap()
        .revision;
    let r2 = store::add_trusted(
        d.path(),
        Scope::Task,
        &a,
        "uid:1000",
        "Persist cards in a backend database",
        Some(&r1),
    )
    .unwrap()
    .id;
    let c = store::load(d.path(), &store::task_key(&a)).unwrap();
    assert!(c.revision > before);
    let old = c.requirements.iter().find(|r| r.id == r1).unwrap();
    assert_eq!(
        old.description, "Persist cards in local storage",
        "history is immutable"
    );
    assert_eq!(
        old.state,
        State::Superseded {
            by: Some(r2.clone())
        }
    );
    assert_eq!(
        c.requirements
            .iter()
            .find(|r| r.id == r2)
            .unwrap()
            .supersedes
            .as_deref(),
        Some(r1.as_str())
    );
    assert_eq!(c.active().count(), 1);
    // the old requirement's binding does NOT verify the replacement
    let mut run = Run::new(isolated());
    run.check("npm", &["test"], 0, "pass");
    let s = evaluate(run.dir.path(), &a.project_id, Some(&a), RUN);
    assert!(s.is_none(), "different state dirs: no contract here");
    let s = {
        // same state dir as the ledger
        let (dir, a2) = (run.dir.path(), anchor("proj", "run_b"));
        let o = user(dir, &a2, "Persist cards in local storage");
        bind(dir, &a2, &o, "npm", &["test"]);
        let n = store::add_trusted(
            dir,
            Scope::Task,
            &a2,
            "uid:1000",
            "Persist cards in a backend database",
            Some(&o),
        )
        .unwrap()
        .id;
        let s = eval(dir, &a2);
        assert_eq!(req(&s, &o).status, "superseded");
        assert_eq!(req(&s, &o).superseded_by.as_deref(), Some(n.as_str()));
        assert_eq!(
            req(&s, &n).status,
            "unverified",
            "evidence for the old requirement does not verify its replacement"
        );
        s
    };
    assert_eq!(
        (s.authoritative, s.superseded, s.overall.as_str()),
        (1, 1, "unverified")
    );
    // withdrawing without a replacement also ends the obligation
    let r3 = user(d.path(), &a, "Show a changelog");
    store::withdraw_trusted(d.path(), Scope::Task, &a, "uid:1000", &r3).unwrap();
    assert_eq!(eval(d.path(), &a).superseded, 2);
}

#[test]
fn a_passing_build_proves_nothing_about_unrelated_ui_functionality() {
    let d = Run::new(isolated());
    let a = anchor("proj", "run_a");
    let r = user(d.dir.path(), &a, "A user can drag a card to another column");
    let mut run = d;
    run.edit_real("src/app.js", "x\n");
    run.check("npm", &["run", "build"], 0, "pass");
    run.finish(&["src/app.js"], false);
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &r).status, "unverified");
    assert!(
        req(&s, &r).evidence.is_empty(),
        "the build is not evidence for the requirement"
    );
    assert_eq!(s.overall, "unverified");
    // binding it to a check that never ran is still unverified, and says why
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &r).status, "unverified");
    assert!(req(&s, &r)
        .missing
        .as_deref()
        .unwrap()
        .contains("has not run"));
}

#[test]
fn model_claims_are_not_execution_evidence_and_model_associations_stay_advisory() {
    let mut run = Run::new(isolated());
    let a = anchor("proj", "run_a");
    let user_req = user(run.dir.path(), &a, "Cards persist after reload");
    run.edit_real("src/app.js", "x\n"); // call 1: an edit, not a check
    let build = run.check("npm", &["run", "build"], 0, "pass"); // call 2
                                                                // the model claims the edit and the build cover the (user) requirement it restates
    let crit = tool::validate(&json!({"criteria": [
        {"description": "cards persist after reload", "checkedByCalls": [1, 2, 99]}
    ]}))
    .unwrap();
    let out = tool::handle(run.dir.path(), &a, RUN, 3, &crit).unwrap();
    assert_eq!(
        out.recorded,
        vec![(user_req.clone(), false)],
        "it restated an existing requirement: nothing new"
    );
    assert_eq!(
        out.claims_recorded, 1,
        "only the real check (call {build}) resolves"
    );
    assert_eq!(
        out.claims_unresolved,
        vec![1, 99],
        "an edit and a missing call are not evidence"
    );
    let s = eval(run.dir.path(), &a);
    let v = req(&s, &user_req);
    assert_eq!(
        v.status, "unverified",
        "advisory coverage never verifies: {v:#?}"
    );
    assert_eq!(v.evidence.len(), 1);
    assert_eq!(
        (v.evidence[0].origin.as_str(), v.evidence[0].counted),
        ("model-asserted", false)
    );
    assert_eq!(
        v.evidence[0].result.as_deref(),
        Some("process-exited-zero"),
        "the underlying check really ran, and is shown"
    );
    assert!(v.missing.as_deref().unwrap().contains("advisory"));
    assert_eq!(s.overall, "unverified");
}

#[test]
fn a_trusted_acceptance_test_supports_exactly_its_requirement_within_scope() {
    let mut run = Run::new(isolated());
    let a = anchor("proj", "run_a");
    let persist = user(run.dir.path(), &a, "Card status persists after reload");
    let drag = user(run.dir.path(), &a, "A user can drag a card");
    bind(
        run.dir.path(),
        &a,
        &persist,
        "node",
        &["--test", "test/persist.test.js"],
    );
    run.edit_real("src/app.js", "x\n");
    run.check("node", &["--test", "test/persist.test.js"], 0, "pass");
    run.finish(&["src/app.js"], false);
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &persist).status, "verified-within-scope");
    assert!(req(&s, &persist).evidence[0].counted);
    assert_eq!(
        req(&s, &persist).evidence[0].freshness.as_deref(),
        Some("current")
    );
    assert_eq!(
        req(&s, &drag).status,
        "unverified",
        "the other requirement is untouched by that test"
    );
    assert_eq!(
        (s.verified, s.unverified, s.overall.as_str()),
        (1, 1, "partially-verified")
    );
    // once every authoritative requirement has a passing bound check the task reads verified-within-scope
    bind(
        run.dir.path(),
        &a,
        &drag,
        "node",
        &["--test", "test/persist.test.js"],
    );
    assert_eq!(eval(run.dir.path(), &a).overall, "verified-within-scope");
}

#[test]
fn stale_indeterminate_failed_and_missing_evidence_are_reported_as_what_they_are() {
    let a = anchor("proj", "run_a");
    // stale: the source changed after the passing acceptance test
    let mut run = Run::new(isolated());
    let r = user(run.dir.path(), &a, "Cards persist");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    run.check("npm", &["test"], 0, "pass");
    run.edit_real("src/app.js", "changed\n");
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &r).status, "inconclusive", "{s:#?}");
    assert_eq!(req(&s, &r).evidence[0].freshness.as_deref(), Some("stale"));
    assert_eq!(s.overall, "inconclusive");
    // rerun on the new source: current again
    run.check("npm", &["test"], 0, "pass");
    assert_eq!(eval(run.dir.path(), &a).overall, "verified-within-scope");
    // failed and current: reported as failed, and the overall status is failed
    let mut run = Run::new(isolated());
    let r = user(run.dir.path(), &a, "Cards persist");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    run.check("npm", &["test"], 1, "fail");
    let s = eval(run.dir.path(), &a);
    assert_eq!(
        (req(&s, &r).status.as_str(), s.overall.as_str(), s.failed),
        ("failed", "failed", 1)
    );
    // indeterminate: another writer was possible (Direct Workspace), so even a clean pass is not success
    let mut b = isolated();
    b.kind = WorkspaceKind::Direct;
    let mut run = Run::new(b);
    let r = user(run.dir.path(), &a, "Cards persist");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    run.check("npm", &["test"], 0, "pass");
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &r).status, "inconclusive");
    assert_eq!(
        req(&s, &r).evidence[0].freshness.as_deref(),
        Some("indeterminate")
    );
    assert_ne!(s.overall, "verified-within-scope");
    // missing: nothing ran at all
    let run = Run::new(isolated());
    let r = user(run.dir.path(), &a, "Cards persist");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    persistence::append_bodies(run.dir.path(), "noop", ".x", &[]).ok();
    let s = eval(run.dir.path(), &a);
    assert_eq!(req(&s, &r).status, "unverified");
}

#[test]
fn every_bound_check_must_hold_and_a_failure_wins() {
    let a = anchor("proj", "run_a");
    let mut run = Run::new(isolated());
    let r = user(run.dir.path(), &a, "Cards persist and sync");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    bind(
        run.dir.path(),
        &a,
        &r,
        "node",
        &["--test", "test/sync.test.js"],
    );
    run.check("npm", &["test"], 0, "pass");
    assert_eq!(
        req(&eval(run.dir.path(), &a), &r).status,
        "unverified",
        "one of two bound checks has not run"
    );
    run.check("node", &["--test", "test/sync.test.js"], 1, "fail");
    assert_eq!(req(&eval(run.dir.path(), &a), &r).status, "failed");
    run.check("node", &["--test", "test/sync.test.js"], 0, "pass");
    assert_eq!(
        req(&eval(run.dir.path(), &a), &r).status,
        "verified-within-scope",
        "the rerun supersedes the earlier failure"
    );
}

#[test]
fn project_policy_applies_to_every_task_of_the_project_only() {
    let mut run = Run::new(isolated());
    let (a1, a2) = (anchor("alpha", "run_a"), anchor("alpha", "run_b"));
    let other = anchor("beta", "run_a");
    let p1 = store::add_trusted(
        run.dir.path(),
        Scope::Project,
        &a1,
        "uid:1000",
        "Every change keeps the unit suite green",
        None,
    )
    .unwrap()
    .id;
    assert_eq!(p1, "P1");
    store::bind_trusted(
        run.dir.path(),
        Scope::Project,
        &a1,
        "uid:1000",
        &p1,
        &dg("npm", &["test"]),
        "npm test",
    )
    .unwrap();
    run.check("npm", &["test"], 0, "pass");
    for a in [&a1, &a2] {
        let s = eval(run.dir.path(), a);
        assert_eq!(req(&s, "P1").origin, "project-policy");
        assert_eq!(s.overall, "verified-within-scope");
    }
    // another project's task sees none of it, and its own contract is a different file
    assert!(evaluate(run.dir.path(), "beta", Some(&other), RUN).is_none());
    assert_ne!(store::task_key(&a1), store::task_key(&other));
    assert_ne!(store::project_key("alpha"), store::project_key("beta"));
    user(run.dir.path(), &other, "Only beta cares about this");
    let s = eval(run.dir.path(), &other);
    assert!(s.requirements.iter().all(|r| r.id != "P1"));
    assert_eq!(s.authoritative, 1);
}

#[test]
fn replay_and_evaluation_are_deterministic() {
    let mut run = Run::new(isolated());
    let a = anchor("proj", "run_a");
    let r = user(run.dir.path(), &a, "Cards persist");
    bind(run.dir.path(), &a, &r, "npm", &["test"]);
    store::propose_model(
        run.dir.path(),
        &a,
        "run_a",
        2,
        "Cards can be deleted",
        false,
    )
    .unwrap();
    run.check("npm", &["test"], 0, "pass");
    let key = store::task_key(&a);
    let c1 = store::load(run.dir.path(), &key).unwrap();
    let c2 = store::load(run.dir.path(), &key).unwrap();
    assert_eq!(c1, c2);
    let s1 = eval(run.dir.path(), &a);
    // duplicate the whole journal: the same contract, the same reading
    let (bodies, _) = persistence::read_bodies(run.dir.path(), &key, SUFFIX);
    persistence::append_bodies(run.dir.path(), &key, SUFFIX, &bodies).unwrap();
    assert_eq!(store::load(run.dir.path(), &key).unwrap(), c1);
    assert_eq!(eval(run.dir.path(), &a), s1);
    // deleting nothing, rebuilding from the records alone gives the same contract
    let recs: Vec<Record> = bodies
        .iter()
        .map(|b| serde_json::from_str(b).unwrap())
        .collect();
    assert_eq!(Contract::fold(&recs, 0), c1);
}

#[test]
fn a_task_without_a_contract_has_no_acceptance_reading_and_phase_01_to_05_are_untouched() {
    let mut run = Run::new(isolated());
    run.check("npm", &["test"], 0, "pass");
    let a = anchor("proj", "run_a");
    assert!(evaluate(run.dir.path(), "proj", Some(&a), RUN).is_none());
    // the verification reading of the same ledger is what it always was
    let v = crate::verification::reconcile::evaluate(
        run.dir.path(),
        RUN,
        &crate::verification::reconcile::RunFacts {
            code_run: true,
            tool_calls: 1,
        },
    );
    assert_eq!(v.acceptance, "not-assessed");
    assert_eq!(v.current_passing, 1);
    // creating a contract never touches the evidence ledger
    let before = std::fs::read(
        run.dir
            .path()
            .join("verification")
            .join(format!("{RUN}.jsonl")),
    )
    .unwrap();
    user(run.dir.path(), &a, "Cards persist");
    let after = std::fs::read(
        run.dir
            .path()
            .join("verification")
            .join(format!("{RUN}.jsonl")),
    )
    .unwrap();
    assert_eq!(before, after);
}

#[test]
fn the_tool_validates_strictly_and_never_trusts_free_form_input() {
    let ok = tool::validate(&json!({"criteria": [{"description": " Cards  persist ", "kind": "assumption", "checkedByCalls": [2, 3]}]})).unwrap();
    assert_eq!(ok[0].description, "Cards persist");
    assert!(ok[0].assumption);
    assert_eq!(ok[0].checked_by, vec![2, 3]);
    for bad in [
        json!({}),
        json!({"criteria": []}),
        json!({"criteria": "x"}),
        json!([1]),
        json!({"criteria": [{"description": ""}]}),
        json!({"criteria": [{"description": "a\u{0}b"}]}),
        json!({"criteria": [{"description": "x".repeat(401)}]}),
        json!({"criteria": [{"description": "x", "kind": "requirement"}]}),
        json!({"criteria": [{"description": "x", "checkedByCalls": [0]}]}),
        json!({"criteria": [{"description": "x", "checkedByCalls": ["1"]}]}),
        json!({"criteria": [{"description": "x", "checkedByCalls": [1,2,3,4,5,6,7,8,9]}]}),
        json!({"criteria": (0..13).map(|i| json!({"description": format!("c{i}")})).collect::<Vec<_>>()}),
    ] {
        assert!(tool::validate(&bad).is_err(), "{bad}");
    }
}

#[test]
fn an_acceptance_family_check_is_a_recognized_check_for_binding() {
    // what a user binds must be a command the Core can recognize, else it could never be evidence
    for (p, a) in [
        ("node", vec!["--test", "test/x.test.js"]),
        ("cargo", vec!["test", "persist"]),
        ("npm", vec!["test"]),
    ] {
        assert!(
            matches!(
                crate::verification::evidence::classify_command(&cmd(p, &a)),
                Recognition::Recognized { .. }
            ),
            "{p} {a:?}"
        );
    }
}
