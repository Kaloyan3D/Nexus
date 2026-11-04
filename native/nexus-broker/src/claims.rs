//! Reconciling a final answer with what the controller recorded.
//!
//! A model's closing text is a claim; the receipts are the record. This module compares the two for the
//! statements that matter and that the controller can check without trusting the model: whether files were
//! changed, whether checks passed or are still failing, whether any command ran, and (with `browser.rs`)
//! whether anyone looked at the page. It never rewrites the answer. A conflict makes the broker ask the model
//! once to restate itself against the facts; if the contradiction survives, the run is flagged and the stored
//! result carries Nexus's own record beneath the model's words.
//!
//! The phrase lists are deliberately narrow (first-person, unambiguous statements) so that a false alarm is
//! rare; a miss is covered by the facts being shown beside every coding answer in the app.

/// What the receipts say (controller-owned; no model text).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub edits_applied: u32,
    pub edited_paths: Vec<String>,
    /// Verification commands that ran (pass or fail).
    pub checks_run: u32,
    /// Failed checks not yet re-run successfully (including invalid-invocation ones, which stay open).
    pub checks_failing: u32,
    /// Checks that ran inside a compound command that cannot attest them and were never re-established.
    pub checks_unattested: u32,
    pub browser_runs: u32,
    /// A screenshot was shown to a model.
    pub seen_by_model: bool,
}

/// One contradiction between the answer and the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub code: &'static str,
    /// What the record shows, in one sentence for the model and the person.
    pub message: String,
}

fn has_any(t: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| t.contains(p))
}

/// Contradictions between `answer` and `facts`.
pub fn conflicts(answer: &str, facts: &Facts) -> Vec<Conflict> {
    let t = answer.to_lowercase().replace('’', "'");
    let mut out = Vec::new();
    if facts.edits_applied > 0
        && has_any(
            &t,
            &[
                "zero file edits",
                "zero edits",
                "made zero",
                "made no edits",
                "made no changes",
                "made no file changes",
                "no file was changed",
                "no files were changed",
                "no files were modified",
                "did not edit any",
                "didn't edit any",
                "did not modify any",
                "didn't modify any",
                "i changed nothing",
                "no changes were made to the project",
                "no change exists",
            ],
        )
    {
        let files = if facts.edited_paths.is_empty() {
            String::new()
        } else {
            format!(" ({})", facts.edited_paths.join(", "))
        };
        out.push(Conflict {
            code: "claims-no-edits",
            message: format!(
                "the answer says no files were changed, but {} file change(s) were applied{files}",
                facts.edits_applied
            ),
        });
    }
    if (facts.checks_failing > 0 || facts.checks_unattested > 0)
        && has_any(
            &t,
            &[
                "all checks pass",
                "all checks passed",
                "all tests pass",
                "all tests passed",
                "all verification passed",
                "verification passed",
                "everything passes",
                "no failures",
                "no failing checks",
                "all checks are green",
            ],
        )
    {
        out.push(Conflict {
            code: "claims-checks-pass",
            message: format!(
                "the answer says the checks pass, but {} failed check(s) have not been re-run successfully and {} check(s) ran inside compound commands that cannot attest them",
                facts.checks_failing, facts.checks_unattested
            ),
        });
    }
    if facts.checks_run == 0
        && has_any(
            &t,
            &[
                "i ran the tests",
                "i ran the test suite",
                "i ran the checks",
                "i ran the verification",
                "tests pass",
                "tests passed",
                "the test suite passes",
                "i verified by running",
            ],
        )
    {
        out.push(Conflict {
            code: "claims-checks-run",
            message: "the answer says tests or checks were run, but no verification command ran in this run"
                .to_owned(),
        });
    }
    if !facts.seen_by_model && crate::browser::claims_visual_observation(answer) {
        out.push(Conflict {
            code: "claims-visual",
            message: if facts.browser_runs == 0 {
                "the answer says the page was opened or looked at, but no browser inspection ran".to_owned()
            } else {
                "the answer says the page was looked at, but no screenshot was ever shown to the model"
                    .to_owned()
            },
        });
    }
    out
}

/// The nudge text for the model: only controller facts.
pub fn restate_message(conflicts: &[Conflict], facts: &Facts) -> String {
    let list = conflicts
        .iter()
        .map(|c| format!("- {}", c.message))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[Nexus] Your answer contradicts the run's record, which Nexus keeps from the tool receipts and which is not open to interpretation:\n{list}\nRecorded: {} file change(s) applied{}, {} verification command(s) run, {} failed check(s) and {} unattested check(s) still unresolved, {} browser inspection(s). Write your final answer again so that every statement about files changed, checks run and what you saw matches this record. If a check failed, say what the record says about it; do not claim a failure is unrelated to your changes unless you can show that from the receipts.",
        facts.edits_applied,
        if facts.edited_paths.is_empty() {
            String::new()
        } else {
            format!(" ({})", facts.edited_paths.join(", "))
        },
        facts.checks_run,
        facts.checks_failing,
        facts.checks_unattested,
        facts.browser_runs,
    )
}

/// The record Nexus attaches beneath an answer whose contradiction survived the restatement.
pub fn footer(conflicts: &[String], facts: &Facts) -> String {
    let mut s = String::from(
        "\n\n---\nNexus record (from the tool receipts, authoritative over the text above):\n",
    );
    for c in conflicts {
        s.push_str(&format!("- Conflict: {c}.\n"));
    }
    s.push_str(&format!(
        "- {} file change(s) applied{}; {} verification command(s) run; {} failed and {} unattested check(s) unresolved; {} browser inspection(s){}.",
        facts.edits_applied,
        if facts.edited_paths.is_empty() {
            String::new()
        } else {
            format!(" ({})", facts.edited_paths.join(", "))
        },
        facts.checks_run,
        facts.checks_failing,
        facts.checks_unattested,
        facts.browser_runs,
        if facts.seen_by_model {
            ", screenshots shown to the model"
        } else {
            ", no screenshot shown to a model"
        },
    ));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            edits_applied: 7,
            edited_paths: vec!["index.html".into()],
            checks_run: 6,
            checks_failing: 1,
            checks_unattested: 0,
            browser_runs: 7,
            seen_by_model: true,
        }
    }

    #[test]
    fn the_live_false_claim_is_caught_against_the_receipts() {
        let a = "**The failure was not caused by my change.** I made zero file edits in this entire run. The equivalent check passes.";
        let c = conflicts(a, &facts());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].code, "claims-no-edits");
        assert!(c[0].message.contains("7 file change(s)") && c[0].message.contains("index.html"));
    }

    #[test]
    fn a_truthful_answer_has_no_conflict() {
        let a = "I rewrote index.html and made six follow-up edits. One check failed because of how I invoked node; see the record.";
        assert!(conflicts(a, &facts()).is_empty());
        // a run that really made no edits may say so
        let none = Facts {
            edits_applied: 0,
            ..facts()
        };
        assert!(conflicts("I made no changes; nothing needed fixing.", &none).is_empty());
    }

    #[test]
    fn checks_claims_are_checked_against_failures_and_against_nothing_having_run() {
        let c = conflicts("All checks pass and everything passes.", &facts());
        assert_eq!(c[0].code, "claims-checks-pass");
        let none = Facts {
            checks_run: 0,
            checks_failing: 0,
            ..facts()
        };
        let c = conflicts("I ran the tests and the tests pass.", &none);
        assert_eq!(c[0].code, "claims-checks-run");
        assert!(conflicts("I ran the tests and the tests pass.", &facts()).is_empty());
    }

    #[test]
    fn an_unattested_check_contradicts_all_checks_pass_too() {
        let f = Facts {
            checks_failing: 0,
            checks_unattested: 2,
            ..facts()
        };
        let c = conflicts("Everything passes: all checks passed.", &f);
        assert_eq!(c[0].code, "claims-checks-pass");
        assert!(c[0]
            .message
            .contains("2 check(s) ran inside compound commands"));
        let clean = Facts {
            checks_failing: 0,
            checks_unattested: 0,
            ..facts()
        };
        assert!(conflicts("Everything passes: all checks passed.", &clean).is_empty());
    }

    #[test]
    fn visual_claims_need_a_screenshot_that_a_model_saw() {
        let a = "I opened the page in a browser and the screenshot shows a clean layout.";
        assert!(conflicts(a, &facts()).is_empty());
        let blind = Facts {
            seen_by_model: false,
            ..facts()
        };
        assert_eq!(conflicts(a, &blind)[0].code, "claims-visual");
        let none = Facts {
            seen_by_model: false,
            browser_runs: 0,
            ..facts()
        };
        assert!(conflicts(a, &none)[0]
            .message
            .contains("no browser inspection ran"));
    }

    #[test]
    fn the_messages_carry_only_controller_facts() {
        let a = "I made zero edits.";
        let c = conflicts(a, &facts());
        let m = restate_message(&c, &facts());
        assert!(m.starts_with("[Nexus]") && m.contains("7 file change(s) applied (index.html)"));
        assert!(
            !m.contains("zero edits"),
            "the model's own words are not echoed"
        );
        let f = footer(
            &c.iter().map(|c| c.message.clone()).collect::<Vec<_>>(),
            &facts(),
        );
        assert!(
            f.contains("authoritative")
                && f.contains("1 failed and 0 unattested check(s) unresolved")
        );
    }
}
