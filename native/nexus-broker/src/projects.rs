//! A6.1.4 project onboarding: open a folder, snapshot it, register it, restore it.
//!
//! The folder path arrives from the Desktop's NATIVE backend after the OS folder
//! picker (never from the renderer or the model). It is validated here, the folder
//! is only read, and what the model sees is a Nexus-owned snapshot repository whose
//! commit the registry pins. Projects are restored from the registry on restart.

use nexus_tools::registry::{self, ManagedMeta, ProjectRecord, WorkspaceMode};
use nexus_tools::snapshot::{self, SnapshotLimits};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Snapshot generations kept per project (the current one and the previous one).
const KEEP_GENERATIONS: u64 = 2;

pub struct Env<'a> {
    pub registry_dir: &'a Path,
    pub trust: &'a registry::Trust,
    pub snapshots_dir: &'a Path,
    /// Directories that may never be opened as a project (Nexus's own state).
    pub forbidden: Vec<PathBuf>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| std::fs::canonicalize(h).ok())
}

/// Validate a folder chosen in the native picker. Fail closed.
pub fn validate_origin(env: &Env<'_>, raw: &str) -> Result<PathBuf, (&'static str, String)> {
    use std::os::unix::fs::MetadataExt;
    let bad = |m: &str| Err(("bad-project", m.to_owned()));
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') || !raw.starts_with('/') {
        return bad("the project folder must be an absolute path");
    }
    let canon = std::fs::canonicalize(raw)
        .map_err(|_| ("bad-project", "that folder does not exist".to_owned()))?;
    let md = std::fs::metadata(&canon)
        .map_err(|_| ("bad-project", "that folder cannot be read".to_owned()))?;
    if !md.is_dir() {
        return bad("a project must be a folder");
    }
    if md.uid() != unsafe { libc::geteuid() } {
        return bad("only folders you own can be opened as a project");
    }
    if canon.parent().is_none() {
        return bad("the filesystem root cannot be a project");
    }
    for top in [
        "/proc",
        "/sys",
        "/dev",
        "/etc",
        "/usr",
        "/boot",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/var",
        "/run",
        "/root",
        "/tmp/.X11-unix",
    ] {
        if canon.starts_with(top) {
            return bad("system folders cannot be opened as a project");
        }
    }
    if let Some(h) = home() {
        if canon == h || h.starts_with(&canon) {
            return bad("open a project folder, not your whole home folder");
        }
        for sensitive in [
            ".ssh",
            ".gnupg",
            ".aws",
            ".kube",
            ".docker",
            ".password-store",
            ".mozilla",
            ".config",
            ".local",
            ".cache",
        ] {
            if canon.starts_with(h.join(sensitive)) {
                return bad(
                    "that folder holds credentials or application data and cannot be a project",
                );
            }
        }
    }
    for f in &env.forbidden {
        if canon.starts_with(f) || f.starts_with(&canon) {
            return bad("that folder overlaps Nexus's own data");
        }
    }
    Ok(canon)
}

pub fn project_id(origin: &Path) -> String {
    let name: String = origin
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(24)
        .collect();
    let h = hex::encode(Sha256::digest(origin.to_string_lossy().as_bytes()));
    format!(
        "{}-{}",
        if name.is_empty() { "project" } else { &name },
        &h[..6]
    )
}

fn seq_of(rec: &ProjectRecord) -> u64 {
    Path::new(&rec.source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.rsplit('-').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// The project's standing grant as shown to the user (absent when the project has none).
pub fn grant_view(rec: &ProjectRecord, now_ms: i64) -> Option<Value> {
    let st = rec.grant.as_ref()?;
    let g = &st.current;
    Some(json!({
        "grantId": g.grant_id, "version": g.version, "digest": g.digest(&rec.id),
        "fs": g.fs, "net": g.net, "approval": g.approval,
        "checkpoint": g.exec.checkpoint, "hardLinks": g.exec.hard_links, "gitWorktree": g.exec.git_worktree,
        "expiresAtMs": g.expires_at_ms, "createdAtMs": g.created_at_ms, "createdBy": g.created_by,
        "status": st.status(now_ms).as_str(),
        "revokedAtMs": st.revoked_at_ms,
        "history": st.history.iter().rev().take(10).map(|e| json!({
            "atMs": e.at_ms, "kind": e.kind, "version": e.version, "by": e.by
        })).collect::<Vec<_>>(),
    }))
}

pub fn view(rec: &ProjectRecord, changed: Option<bool>) -> Value {
    let kinds: Vec<Value> = rec
        .origin
        .as_deref()
        .map(|_| rec.kinds.iter().map(|k| kind_view(k)).collect())
        .unwrap_or_default();
    let mut v = json!({
        "projectId": rec.id,
        "label": rec.label.clone().unwrap_or_else(|| rec.id.clone()),
        "managed": rec.managed,
        "kinds": kinds,
        "pinnedCommit": rec.pinned_commit,
        "writeAllow": rec.write_allow,
        "installs": rec.installs,
        "trusted": rec.trusted,
        "workspaceMode": rec.workspace_mode.as_str(),
        "snapshotAtMs": rec.updated_at_ms,
        "originDirty": rec.snapshot_origin_dirty,
        "changedSinceSnapshot": changed,
    });
    if let Some(g) = grant_view(rec, now_ms()) {
        v["grant"] = g;
    }
    v
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

type VerbErr = (&'static str, String);

fn spec_of(params: &Value) -> Result<nexus_tools::grant::GrantSpec, VerbErr> {
    let s = |k: &str, d: &str| {
        params
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or(d)
            .to_owned()
    };
    let expires_at_ms = match params.get("expiresInSecs") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let secs = v.as_u64().filter(|n| *n > 0).ok_or((
                "bad-request",
                "expiresInSecs must be a positive number".to_owned(),
            ))?;
            Some(now_ms().saturating_add((secs as i64).saturating_mul(1000)))
        }
    };
    Ok(nexus_tools::grant::GrantSpec {
        fs: s("fs", "scratch"),
        net: s("net", "offline"),
        approval: s("approval", "auto"),
        expires_at_ms,
        exec: nexus_tools::grant::ExecPolicy {
            checkpoint: s("checkpoint", "best-effort"),
            hard_links: s("hardLinks", "protect"),
            git_worktree: s("gitWorktree", "off"),
        },
    })
}

fn actor(client: &str, params: &Value) -> String {
    let surface: String = params
        .get("surface")
        .and_then(|v| v.as_str())
        .unwrap_or("client")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!("{surface}:{client}")
}

fn grant_project(env: &Env<'_>, id: &str) -> Result<ProjectRecord, VerbErr> {
    registry::load(env.registry_dir, env.trust)
        .map_err(|e| ("registry", e.to_string()))?
        .get(id)
        .cloned()
        .ok_or(("not-found", "no such project".to_owned()))
}

/// What the user would be asked to confirm: the exact text (its digest is what `grant_set` requires back),
/// and the refusal, if any, BEFORE anything is shown. Pure; changes nothing.
pub fn grant_preview(env: &Env<'_>, id: &str, params: &Value) -> Result<Value, VerbErr> {
    let rec = grant_project(env, id)?;
    let spec = spec_of(params)?;
    nexus_tools::grant::validate_spec(&spec, rec.workspace_mode == WorkspaceMode::Direct, now_ms())
        .map_err(|e| (e.code, e.message))?;
    let label = rec.label.clone().unwrap_or_else(|| rec.id.clone());
    let text = nexus_tools::grant::consent_text_for(
        &label,
        &spec,
        rec.workspace_mode == WorkspaceMode::Direct,
    );
    Ok(json!({
        "projectId": rec.id,
        "text": text, "textSha256": nexus_tools::grant::text_digest(&text),
        "fs": spec.fs, "net": spec.net, "approval": spec.approval, "expiresAtMs": spec.expires_at_ms,
        "checkpoint": spec.exec.checkpoint, "hardLinks": spec.exec.hard_links,
        "direct": rec.workspace_mode == WorkspaceMode::Direct,
        "replaces": grant_view(&rec, now_ms()),
    }))
}

/// Store the grant. The caller must return the digest of the exact text the broker serves for these
/// choices: a UI that showed something else cannot create a grant.
pub fn grant_set(env: &Env<'_>, client: &str, id: &str, params: &Value) -> Result<Value, VerbErr> {
    let rec = grant_project(env, id)?;
    let spec = spec_of(params)?;
    nexus_tools::grant::validate_spec(&spec, rec.workspace_mode == WorkspaceMode::Direct, now_ms())
        .map_err(|e| (e.code, e.message))?;
    let label = rec.label.clone().unwrap_or_else(|| rec.id.clone());
    let text = nexus_tools::grant::consent_text_for(
        &label,
        &spec,
        rec.workspace_mode == WorkspaceMode::Direct,
    );
    let want = nexus_tools::grant::text_digest(&text);
    if params.get("textSha256").and_then(|v| v.as_str()) != Some(want.as_str()) {
        return Err((
            "consent-mismatch",
            "the confirmation does not match the text for these permissions; nothing was changed"
                .into(),
        ));
    }
    let rec = registry::set_grant(
        env.registry_dir,
        env.trust,
        id,
        &spec,
        &actor(client, params),
        &want,
    )
    .map_err(|e| (grant_code(&e), e.message))?;
    Ok(json!({ "project": view(&rec, None) }))
}

pub fn grant_revoke(
    env: &Env<'_>,
    client: &str,
    id: &str,
    params: &Value,
) -> Result<Value, VerbErr> {
    let rec = registry::revoke_grant(env.registry_dir, env.trust, id, &actor(client, params))
        .map_err(|e| (grant_code(&e), e.message))?;
    Ok(json!({ "project": view(&rec, None) }))
}

pub fn grant_clear(
    env: &Env<'_>,
    client: &str,
    id: &str,
    params: &Value,
) -> Result<Value, VerbErr> {
    let rec = registry::clear_grant(env.registry_dir, env.trust, id, &actor(client, params))
        .map_err(|e| (grant_code(&e), e.message))?;
    Ok(json!({ "project": view(&rec, None) }))
}

fn grant_code(e: &registry::RegError) -> &'static str {
    match e.code {
        "not-found" => "not-found",
        "no-grant" | "already-revoked" => "bad-request",
        "not-available" | "bad-grant" => "bad-request",
        _ => "registry",
    }
}

fn kind_view(id: &str) -> Value {
    // Re-derive the descriptive fields from the detector's catalogue (ids are stored).
    match id {
        "rust" => json!({"id": id, "label": "Rust (Cargo)", "supported": true}),
        "node" => json!({"id": id, "label": "JavaScript (npm)", "supported": true}),
        "typescript" => json!({"id": id, "label": "TypeScript (npm)", "supported": true}),
        "python" => json!({"id": id, "label": "Python", "supported": true}),
        "go" => json!({"id": id, "label": "Go", "supported": false}),
        "dotnet" => json!({"id": id, "label": ".NET", "supported": false}),
        _ => json!({"id": id, "label": id, "supported": false}),
    }
}

/// Open (or re-open / refresh) the folder as a managed project.
pub fn open(env: &Env<'_>, raw: &str) -> Result<Value, (&'static str, String)> {
    open_with(env, raw, None)
}

/// `workspace`: where a NEW project's tasks edit (`None` = isolated, the long-standing default). An
/// existing project keeps its durable choice whatever is passed here: re-opening or refreshing never
/// changes what the agent may do to the folder.
pub fn open_with(
    env: &Env<'_>,
    raw: &str,
    workspace: Option<WorkspaceMode>,
) -> Result<Value, (&'static str, String)> {
    let origin = validate_origin(env, raw)?;
    let id = project_id(&origin);
    let kinds = nexus_tools::detect::detect(&origin);
    // Installed packages (node_modules) are excluded from the sandbox's staged snapshot, so
    // copying them would only bloat the snapshot: never included.
    let node = false;
    let existing = registry::load(env.registry_dir, env.trust)
        .map_err(|e| ("registry", e.to_string()))?
        .get(&id)
        .cloned();
    let seq = existing.as_ref().map(seq_of).unwrap_or(0) + 1;
    std::fs::create_dir_all(env.snapshots_dir)
        .map_err(|e| ("internal", format!("snapshot area: {e}")))?;
    let dest = env
        .snapshots_dir
        .join(snapshot::snapshot_dir_name(&id, seq));
    let info = snapshot::snapshot(&origin, &dest, node, &SnapshotLimits::default())
        .map_err(|e| ("bad-project", e.to_string()))?;
    let meta = ManagedMeta {
        label: origin
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone()),
        origin: origin.to_string_lossy().into_owned(),
        kinds: kinds.iter().map(|k| k.id.to_owned()).collect(),
        fingerprint: info.fingerprint.clone(),
        origin_dirty: info.origin_dirty.unwrap_or(false),
        new_mode: workspace.unwrap_or_default(),
    };
    let rec = match registry::upsert_managed(
        env.registry_dir,
        env.trust,
        &id,
        &dest,
        &info.commit,
        &meta,
        Vec::new(),
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = snapshot::remove_snapshot(&dest);
            return Err(("registry", e.to_string()));
        }
    };
    // retire old generations
    for n in 1..=seq.saturating_sub(KEEP_GENERATIONS) {
        let _ =
            snapshot::remove_snapshot(&env.snapshots_dir.join(snapshot::snapshot_dir_name(&id, n)));
    }
    Ok(json!({
        "project": view(&rec, Some(false)),
        "created": existing.is_none(),
        "snapshot": {"files": info.files, "bytes": info.bytes, "skippedTotal": info.skipped_total,
                     "skipped": info.skipped.iter().take(20).map(|(p, w)| json!({"path": p, "reason": w})).collect::<Vec<_>>()},
        "kindsDetail": kinds,
    }))
}

/// Projects known to the registry (operator-registered ones included).
pub fn list(env: &Env<'_>, with_changes: bool) -> Result<Value, (&'static str, String)> {
    let f = registry::load(env.registry_dir, env.trust).map_err(|e| ("registry", e.to_string()))?;
    let limits = SnapshotLimits::default();
    let items: Vec<Value> = f
        .projects
        .iter()
        .map(|p| {
            let changed = if with_changes && p.managed {
                p.origin
                    .as_deref()
                    .and_then(|o| snapshot::fingerprint(Path::new(o), &limits).ok())
                    .map(|fp| Some(fp) != p.snapshot_fingerprint)
            } else {
                None
            };
            view(p, changed)
        })
        .collect();
    Ok(json!({ "projects": items }))
}

/// Re-snapshot when the origin changed since the last snapshot (new tasks start from
/// current files; running tasks keep their copy). Returns whether it refreshed.
pub fn ensure_fresh(env: &Env<'_>, id: &str) -> bool {
    let Ok(f) = registry::load(env.registry_dir, env.trust) else {
        return false;
    };
    let Some(p) = f.get(id) else { return false };
    if !p.managed {
        return false;
    }
    let Some(origin) = p.origin.clone() else {
        return false;
    };
    let same = snapshot::fingerprint(Path::new(&origin), &SnapshotLimits::default())
        .ok()
        .map(|fp| Some(&fp) == p.snapshot_fingerprint.as_ref())
        .unwrap_or(true);
    if same {
        return false;
    }
    open(env, &origin).is_ok()
}

pub fn set_policy(
    env: &Env<'_>,
    id: &str,
    installs: Option<bool>,
    trusted: Option<bool>,
) -> Result<Value, (&'static str, String)> {
    let rec = registry::set_installs(env.registry_dir, env.trust, id, installs, trusted)
        .map_err(|e| ("not-found", e.to_string()))?;
    Ok(json!({ "project": view(&rec, None) }))
}

/// Change where NEW tasks of an opened project edit. A task that already started keeps its workspace.
pub fn set_workspace(
    env: &Env<'_>,
    id: &str,
    mode: WorkspaceMode,
) -> Result<Value, (&'static str, String)> {
    let rec = registry::set_workspace_mode(env.registry_dir, env.trust, id, mode)
        .map_err(|e| ("not-found", e.to_string()))?;
    Ok(json!({ "project": view(&rec, None) }))
}

pub fn forget(env: &Env<'_>, id: &str) -> Result<Value, (&'static str, String)> {
    let rec = registry::remove_managed(env.registry_dir, env.trust, id)
        .map_err(|e| ("not-found", e.to_string()))?;
    for n in 0..=10_000u64.min(seq_of(&rec) + 1) {
        let d = env.snapshots_dir.join(snapshot::snapshot_dir_name(id, n));
        if d.exists() {
            let _ = snapshot::remove_snapshot(&d);
        }
    }
    Ok(json!({ "forgotten": id }))
}
