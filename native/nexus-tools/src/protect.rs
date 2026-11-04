//! Paths an autonomous agent may never create or change, shared by the broker's
//! early refusal and the daemon's automated workspace policy (one rule, two
//! independent enforcement points).

use crate::workspace::{NameClass, WorkspacePolicy};

/// Files that steer builds, toolchains or dependency resolution rather than
/// carry the requested change: a human changes them, not the agent.
pub const PROTECTED_NAMES: &[&str] = &[
    "build.rs",
    "cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "makefile",
    "justfile",
    "dockerfile",
    "docker-compose.yml",
    // build/dependency steering for other ecosystems (A6.1.4 profiles)
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "pipfile",
    "pipfile.lock",
    "poetry.lock",
    "go.mod",
    "go.sum",
    "package.json",
    "tsconfig.json",
    "directory.build.props",
    "directory.build.targets",
    "nuget.config",
    "global.json",
];

/// Why a write path is refused: `(code, reason)`.
pub type PathRefusal = (&'static str, &'static str);

/// Validate a normalized, repository-relative write path.
pub fn write_path_check(path: &str) -> Result<(), PathRefusal> {
    let pol = WorkspacePolicy::default();
    if path.is_empty() || path == "." {
        return Err(("invalid-arguments", "a file path is required"));
    }
    for c in path.split('/') {
        if c.is_empty() || c == "." || c == ".." {
            return Err((
                "invalid-arguments",
                "paths must be normalized and relative to the repository root",
            ));
        }
        if c.starts_with('.') {
            return Err((
                "protected-path",
                "hidden, VCS and internal paths are never writable",
            ));
        }
        if pol.classify_name(c) == NameClass::Sensitive {
            return Err((
                "protected-path",
                "credential or sensitive paths are never writable",
            ));
        }
        if pol.is_ignored_dir(c) {
            return Err((
                "protected-path",
                "dependency and build directories are not writable",
            ));
        }
        if PROTECTED_NAMES.contains(&c.to_ascii_lowercase().as_str()) {
            return Err((
                "protected-path",
                "build, toolchain and lock files are changed by a human, not the agent",
            ));
        }
    }
    Ok(())
}

/// Autonomy-first rule for the interactive profile (project-level trust, no per-operation
/// approval): ordinary project files are writable, INCLUDING manifests, lock files,
/// configuration and dotfiles such as `.eslintrc`. What stays out of reach is what could
/// act outside the sandbox or on the user's secrets: VCS internals, credentials, CI
/// definitions and git hooks (they execute later with the user's real privileges), and
/// generated dependency/build directories.
pub fn workbench_path_check(path: &str) -> Result<(), PathRefusal> {
    let pol = WorkspacePolicy::default();
    if path.is_empty() || path == "." {
        return Err(("invalid-arguments", "a file path is required"));
    }
    for c in path.split('/') {
        if c.is_empty() || c == "." || c == ".." {
            return Err((
                "invalid-arguments",
                "paths must be normalized and relative to the repository root",
            ));
        }
        let lc = c.to_ascii_lowercase();
        if lc == ".git"
            || lc.starts_with(".git")
                && matches!(lc.as_str(), ".gitmodules" | ".gitattributes_local")
        {
            return Err((
                "protected-path",
                "version-control internals are never writable",
            ));
        }
        if matches!(
            lc.as_str(),
            ".github"
                | ".gitlab-ci.yml"
                | ".circleci"
                | ".husky"
                | ".githooks"
                | ".ssh"
                | ".gnupg"
                | ".aws"
                | ".azure"
                | ".kube"
        ) {
            return Err((
                "protected-path",
                "CI definitions, git hooks and credential folders run or act outside the sandbox and are changed by a person",
            ));
        }
        if pol.classify_name(c) == NameClass::Sensitive {
            return Err((
                "protected-path",
                "credential or sensitive paths are never writable",
            ));
        }
        if pol.is_ignored_dir(c) {
            return Err((
                "protected-path",
                "dependency and build output directories are generated, not edited",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workbench_rule_allows_project_files_and_still_guards_what_acts_outside_the_sandbox() {
        for ok in [
            "src/lib.rs",
            "package.json",
            "Cargo.toml",
            "tsconfig.json",
            "package-lock.json",
            ".eslintrc.json",
            ".prettierignore",
            "build.rs",
            "Makefile",
            "docs/a.md",
        ] {
            assert!(workbench_path_check(ok).is_ok(), "{ok}");
        }
        for bad in [
            ".git/config",
            ".github/workflows/ci.yml",
            ".husky/pre-commit",
            ".ssh/id_rsa",
            ".env",
            ".env.production",
            "node_modules/x/index.js",
            "target/debug/x",
            "../x",
            "a//b",
            "id_rsa",
            "secrets/credentials.json",
            "keys/server.pem",
        ] {
            assert!(workbench_path_check(bad).is_err(), "{bad}");
        }
        // the strict rule is what it was
        for bad in ["package.json", "Cargo.lock", ".eslintrc.json", "build.rs"] {
            assert!(write_path_check(bad).is_err(), "{bad}");
        }
    }
}
