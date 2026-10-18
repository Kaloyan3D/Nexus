//! A6.1.4: project type and execution-profile detection (root markers only; no
//! file content is executed or parsed beyond a few small manifests).
//!
//! A *profile* names the build/test commands Nexus will let the model run for a
//! project kind. Only commands the sandbox command policy actually accepts are
//! listed as `supported`; other ecosystems are detected so the user is told
//! honestly, and are not runnable until their profile is verified.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKind {
    /// `rust` | `node` | `typescript` | `python` | `go` | `dotnet`
    pub id: &'static str,
    pub label: &'static str,
    /// True when Nexus can run this kind's validation commands in the sandbox today.
    pub supported: bool,
    /// Exact argv forms (for the model's guidance and the UI), never a shell line.
    pub commands: Vec<String>,
    /// A short, honest note (e.g. why a kind is not runnable yet).
    pub note: &'static str,
}

fn has(root: &Path, name: &str) -> bool {
    std::fs::symlink_metadata(root.join(name))
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

fn any_with_ext(root: &Path, exts: &[&str], depth: u32) -> bool {
    let Ok(rd) = std::fs::read_dir(root) else {
        return false;
    };
    for e in rd.flatten().take(400) {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(m) = e.metadata() else { continue };
        if m.file_type().is_file() {
            if exts.iter().any(|x| name.ends_with(x)) {
                return true;
            }
        } else if m.file_type().is_dir()
            && depth > 0
            && !name.starts_with('.')
            && !matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | "venv" | "__pycache__"
            )
            && any_with_ext(&e.path(), exts, depth - 1)
        {
            return true;
        }
    }
    false
}

/// The catalogue entry for a kind id (`rust`, `node`, `typescript`, `python`, `go`,
/// `dotnet`).
pub fn describe(id: &str) -> Option<ProjectKind> {
    let host_has = |paths: &[&str]| paths.iter().any(|p| Path::new(p).exists());
    Some(match id {
        "rust" => ProjectKind {
            id: "rust",
            label: "Rust (Cargo)",
            supported: true,
            commands: vec![
                "cargo fetch (install dependencies, once)".into(),
                "cargo test".into(),
                "cargo build".into(),
                "cargo clippy".into(),
                "cargo fmt --check".into(),
            ],
            note: "Dependencies are downloaded once with `cargo fetch` into the project environment and are available offline afterwards.",
        },
        "node" | "typescript" => {
            let ts = id == "typescript";
            let mut commands = vec![
                "npm ci or npm install (install dependencies; do it first when the project has dependencies)".to_owned(),
                "npm test".to_owned(),
                "npm run <script>".to_owned(),
            ];
            if ts {
                commands.push("npx tsc --noEmit".into());
            }
            commands.push("npx <local tool> (vitest, jest, eslint, ...)".into());
            commands.push("node <file> / node --test".into());
            ProjectKind {
                id: if ts { "typescript" } else { "node" },
                label: if ts { "TypeScript (npm)" } else { "JavaScript (npm)" },
                supported: true,
                commands,
                note: "Dependencies are installed once into the project environment and stay available to later commands (offline).",
            }
        }
        "python" => ProjectKind {
            id: "python",
            label: "Python",
            supported: true,
            commands: vec![
                "python3 -m pip install -r requirements.txt (install dependencies)".into(),
                "python3 -m pytest -q".into(),
                "python3 -m unittest discover".into(),
                "python3 <script>".into(),
            ],
            note: "Dependencies install into the project environment (PYTHONPATH is set for you).",
        },
        "go" => ProjectKind {
            id: "go",
            label: "Go",
            supported: host_has(&["/usr/bin/go", "/usr/local/go/bin/go", "/usr/lib/go/bin/go"]),
            commands: vec![
                "go mod download (install dependencies)".into(),
                "go build ./...".into(),
                "go test ./...".into(),
                "go vet ./...".into(),
            ],
            note: "Needs the Go toolchain on this computer; modules download once into the project environment.",
        },
        "dotnet" => ProjectKind {
            id: "dotnet",
            label: ".NET",
            supported: host_has(&["/usr/bin/dotnet", "/usr/local/bin/dotnet"]),
            commands: vec![
                "dotnet restore (install dependencies)".into(),
                "dotnet build --no-restore".into(),
                "dotnet test --no-restore".into(),
            ],
            note: "Needs the .NET SDK on this computer; NuGet packages restore once into the project environment.",
        },
        _ => return None,
    })
}

/// Detect the kinds present at `root` (a directory). Order: most specific first.
pub fn detect(root: &Path) -> Vec<ProjectKind> {
    let mut ids: Vec<&str> = Vec::new();
    if has(root, "Cargo.toml") {
        ids.push("rust");
    }
    if has(root, "package.json") {
        ids.push(if has(root, "tsconfig.json") {
            "typescript"
        } else {
            "node"
        });
    }
    if has(root, "pyproject.toml")
        || has(root, "setup.py")
        || has(root, "setup.cfg")
        || has(root, "requirements.txt")
        || any_with_ext(root, &[".py"], 2)
    {
        ids.push("python");
    }
    if has(root, "go.mod") {
        ids.push("go");
    }
    if any_with_ext(root, &[".sln", ".csproj", ".fsproj"], 2) {
        ids.push("dotnet");
    }
    ids.into_iter().filter_map(describe).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(files: &[&str]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for f in files {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        d
    }

    fn ids(d: &Path) -> Vec<&'static str> {
        detect(d).iter().map(|k| k.id).collect()
    }

    #[test]
    fn detects_kinds_from_root_markers_and_reports_what_is_runnable() {
        assert_eq!(ids(dir(&["Cargo.toml", "src/lib.rs"]).path()), ["rust"]);
        assert_eq!(ids(dir(&["package.json"]).path()), ["node"]);
        let ts = dir(&["package.json", "tsconfig.json"]);
        assert_eq!(ids(ts.path()), ["typescript"]);
        assert!(detect(ts.path())[0]
            .commands
            .contains(&"npx tsc --noEmit".to_owned()));
        assert_eq!(ids(dir(&["pyproject.toml"]).path()), ["python"]);
        assert_eq!(ids(dir(&["pkg/mod.py"]).path()), ["python"]);
        let go = detect(dir(&["go.mod"]).path());
        assert_eq!(go[0].id, "go");
        let net = detect(dir(&["App/App.csproj"]).path());
        assert_eq!(net[0].id, "dotnet");
        // polyglot and empty
        assert_eq!(
            ids(dir(&["Cargo.toml", "package.json"]).path()),
            ["rust", "node"]
        );
        assert!(detect(dir(&["README.md"]).path()).is_empty());
        // a marker that is a directory or a symlink is not a manifest
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("Cargo.toml")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", d.path().join("package.json")).unwrap();
        assert!(detect(d.path()).is_empty());
    }
}
