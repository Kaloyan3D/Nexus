//! A4.4 versioned production security profile.
//!
//! `--security-profile production-v1` turns the individually opt-in
//! controls of A3.1-A4.3 into ONE explicit, fail-closed startup contract.
//! Validation runs before the DataRoot is touched, so a fresh store cannot
//! start any privileged class without the whole profile. The profile is
//! also latched per store (`security_profile`), so a later start without
//! it cannot enable writes/process execution (read-only stays available).
//!
//! Limits (see A4.4-EVIDENCE.md): a launcher running as the same user can
//! simply not pass the flag on a *fresh* store. The profile therefore makes
//! downgrades explicit and detectable; enforcing that the flag is always
//! present requires an authority the user cannot edit (root-owned unit
//! file), which is a deployment requirement, not something this binary can
//! provide against its own launcher.

pub const PRODUCTION_V1: &str = "production-v1";

/// Flags that must be present (with a value unless listed as boolean).
const REQUIRED_VALUED: &[&str] = &[
    "--trust-mode",
    "--allowed-uids",
    "--socket-group",
    "--witness",
    "--cap-handoff",
    "--cap-handoff-gid",
    "--approver-cap",
    "--approver-uids",
    "--approver-cap-gid",
    "--workspace-bases",
    "--external-witness",
    "--external-witness-uid",
];

const REQUIRED_BOOL: &[&str] = &[
    "--require-independent-approver",
    "--require-human-approval",
    "--require-external-witness",
];

/// Flags that are never valid under the profile.
const FORBIDDEN: &[&str] = &[
    "--allow-nonindependent-approver-test-only",
    "--witness-adopt-legacy",
    // A5.1 development pilot: model inference is never part of the
    // production-v1 contract; it needs its own reviewed profile.
    "--enable-model-pilot",
    // A5.5 development pilot: model-driven read tools are not part of the
    // production-v1 contract either.
    "--enable-repo-inspect",
    // A5.6 development pilot: autonomous coding is not part of production-v1.
    "--enable-repo-code",
    "--worktree-root",
    "--project-registry",
    "--autonomous-workspace-policy",
    "--standing-grants",
    "--project-registry-owner-uid",
];

/// Environment variables that arm test-only behaviour.
const FORBIDDEN_ENV: &[&str] = &[
    "NEXUS_TEST_WRITE_CRASH_AT",
    "NEXUS_WITNESS_FAULT",
    "NEXUS_TOOLS_OFFLINE_TEST",
    "NEXUS_TOOLS_OFFLINE_WRITE_TEST",
    "NEXUS_TOOLS_OFFLINE_PROCESS_TEST",
];

fn flag_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn uid_list(v: Option<&str>) -> Vec<u32> {
    v.unwrap_or("")
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}

/// Validate `args` against production-v1. `env` reads an environment
/// variable; `euid` is the daemon's effective uid. Returns every violation.
pub fn validate_production_v1(
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    euid: u32,
) -> Result<(), Vec<String>> {
    let mut v: Vec<String> = Vec::new();
    for f in REQUIRED_VALUED {
        match flag_value(args, f) {
            Some(x) if !x.starts_with("--") && !x.is_empty() => {}
            _ => v.push(format!("{f} is required")),
        }
    }
    for f in REQUIRED_BOOL {
        if !has(args, f) {
            v.push(format!("{f} is required"));
        }
    }
    for f in FORBIDDEN {
        if has(args, f) {
            v.push(format!(
                "{f} is not permitted (test-only or migration flag)"
            ));
        }
    }
    for e in FORBIDDEN_ENV {
        if env(e).is_some() {
            v.push(format!("environment variable {e} must not be set"));
        }
    }
    if flag_value(args, "--trust-mode") != Some("shadow-test") {
        v.push("--trust-mode must be shadow-test (issuer capability model)".to_owned());
    }
    if has(args, "--enable-process") && !has(args, "--require-kernel-resource-limits") {
        v.push(
            "--enable-process requires --require-kernel-resource-limits (polling is not equivalent)"
                .to_owned(),
        );
    }
    if !(has(args, "--enable-writes") || has(args, "--enable-process")) {
        // Not a violation: a read-only profile start is valid.
    }
    if euid == 0 {
        v.push("the daemon must not run as root".to_owned());
    }
    let issuers = uid_list(flag_value(args, "--allowed-uids"));
    let approvers = uid_list(flag_value(args, "--approver-uids"));
    if issuers.is_empty() {
        v.push("--allowed-uids must list at least one issuer uid".to_owned());
    }
    if approvers.is_empty() {
        v.push("--approver-uids must list at least one approver uid".to_owned());
    }
    if issuers.iter().any(|u| approvers.contains(u)) {
        v.push("issuer and approver uids must be disjoint".to_owned());
    }
    if let Some(w) = flag_value(args, "--external-witness-uid").and_then(|s| s.parse::<u32>().ok())
    {
        if w == euid || issuers.contains(&w) || approvers.contains(&w) {
            v.push(
                "the witness uid must differ from the daemon, issuer and approver uids".to_owned(),
            );
        }
    }
    if issuers.contains(&euid) || approvers.contains(&euid) {
        v.push("the daemon uid must not be an issuer or approver uid".to_owned());
    }
    if v.is_empty() {
        Ok(())
    } else {
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> Vec<String> {
        let s = "--db /d/k.db --socket /s/n.sock --witness /d/w.db --trust-mode shadow-test \
                 --allowed-uids 2002 --socket-group 2002 --cap-handoff /c/h --cap-handoff-gid 2006 \
                 --approver-cap /a/a.cap --approver-uids 2005 --approver-cap-gid 2005 \
                 --workspace-bases /w --external-witness /run/w.sock --external-witness-uid 2007 \
                 --require-independent-approver --require-human-approval \
                 --require-external-witness --enable-writes";
        s.split_whitespace().map(str::to_owned).collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn complete_configuration_is_accepted() {
        assert!(validate_production_v1(&good(), &no_env, 2001).is_ok());
    }

    #[test]
    fn every_required_flag_is_enforced() {
        for f in REQUIRED_VALUED.iter().chain(REQUIRED_BOOL.iter()) {
            let mut a = good();
            if let Some(i) = a.iter().position(|x| x == f) {
                if REQUIRED_VALUED.contains(f) {
                    a.drain(i..=i + 1);
                } else {
                    a.remove(i);
                }
            }
            let e = validate_production_v1(&a, &no_env, 2001).unwrap_err();
            assert!(e.iter().any(|m| m.contains(f)), "{f}: {e:?}");
        }
    }

    #[test]
    fn development_model_pilot_cannot_be_activated_under_production_v1() {
        let mut a = good();
        a.push("--enable-model-pilot".into());
        let errs = validate_production_v1(&a, &no_env, 2001).expect_err("pilot refused");
        assert!(
            errs.iter().any(|e| e.contains("--enable-model-pilot")),
            "{errs:?}"
        );
        assert!(validate_production_v1(&good(), &no_env, 2001).is_ok());
    }

    #[test]
    fn repo_inspect_pilot_cannot_be_activated_under_production_v1() {
        let mut a = good();
        a.push("--enable-repo-inspect".into());
        let errs = validate_production_v1(&a, &no_env, 2001).expect_err("pilot refused");
        assert!(
            errs.iter().any(|e| e.contains("--enable-repo-inspect")),
            "{errs:?}"
        );
    }

    #[test]
    fn repo_code_pilot_cannot_be_activated_under_production_v1() {
        for f in ["--enable-repo-code", "--worktree-root"] {
            let mut a = good();
            a.push(f.into());
            let errs = validate_production_v1(&a, &no_env, 2001).expect_err("pilot refused");
            assert!(errs.iter().any(|e| e.contains(f)), "{f}: {errs:?}");
        }
    }

    #[test]
    fn forbidden_flags_env_and_identities_are_refused() {
        let mut a = good();
        a.push("--allow-nonindependent-approver-test-only".into());
        assert!(validate_production_v1(&a, &no_env, 2001).is_err());
        let mut a = good();
        a.push("--witness-adopt-legacy".into());
        assert!(validate_production_v1(&a, &no_env, 2001).is_err());
        let env = |k: &str| (k == "NEXUS_WITNESS_FAULT").then(|| "fail-persist".to_owned());
        assert!(validate_production_v1(&good(), &env, 2001).is_err());
        // root, uid collisions
        assert!(validate_production_v1(&good(), &no_env, 0).is_err());
        assert!(validate_production_v1(&good(), &no_env, 2007).is_err());
        let mut a = good();
        let i = a.iter().position(|x| x == "--approver-uids").unwrap();
        a[i + 1] = "2002".into();
        assert!(validate_production_v1(&a, &no_env, 2001).is_err());
        // process execution needs kernel-enforced limits
        let mut a = good();
        a.push("--enable-process".into());
        assert!(validate_production_v1(&a, &no_env, 2001).is_err());
        a.push("--require-kernel-resource-limits".into());
        assert!(validate_production_v1(&a, &no_env, 2001).is_ok());
    }
}
