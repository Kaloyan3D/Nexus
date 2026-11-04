//! Glue between the app's commands and the synchronization engine: opening Mac folders as
//! projects, keeping the engine's copy current before a task, following runs to their end, and
//! presenting honest status. Owns no filesystem logic of its own (that is `host` / `guest`).

use super::host::*;
use super::manifest;
use super::registry::*;
use super::wire::*;
use crate::dialogs::Dialogs;
use crate::dto::UiError;
use crate::engine::EngineLink;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// `Guest` over the engine link (the bridge in production).
pub struct EngineGuest(pub Arc<dyn EngineLink>);
impl Guest for EngineGuest {
    fn call(&self, req: SyncReq) -> Result<Value, SyncErr> {
        self.0
            .sync(req)
            .map_err(|e| SyncErr::new(&e.code, e.message))
    }
}

pub struct Coordinator {
    pub store: Arc<Store>,
    engine: Arc<dyn EngineLink>,
    dialogs: Arc<dyn Dialogs>,
    home: Option<PathBuf>,
    /// Projects with a synchronization step in progress (one at a time per project).
    busy: Mutex<HashSet<String>>,
}

fn ui(code: &str, m: impl Into<String>) -> UiError {
    UiError {
        code: code.to_owned(),
        message: m.into(),
    }
}

fn host_err(e: HostErr) -> UiError {
    let message = match e.code.as_str() {
        "guest-has-unexported-changes" => "Nexus's last changes to this project were not applied to your Mac folder, so it cannot be refreshed from your Mac yet. Resolve or discard that result first.".to_owned(),
        "sync-conflict" => "A finished task's result could not be applied because your Mac folder changed too. Nothing was overwritten; resolve that result first.".to_owned(),
        "run-active" => "Nexus is still working on or applying changes to this folder. Wait for it to finish.".to_owned(),
        "engine-busy" => "The engine is running a task. Try again when it finishes.".to_owned(),
        "no-consent" => "This folder has no standing permission for Nexus to copy it to the engine and apply verified results back.".to_owned(),
        _ => e.message.clone(),
    };
    ui(&format!("sync-{}", e.code), message)
}

const FULL_ACCESS_TEXT: &str = "Full Access\n\nWhile this run is in Full Access, Nexus may run commands, install packages, use the network that dependency installation needs, and create, change or delete files in this project's working copy WITHOUT asking you again.\n\nIt stays inside this project's permissions and the Linux sandbox: it cannot reach other folders on your Mac, your secrets or system settings. Every command is still recorded, and you can stop the run or lower the mode at any time.";

fn mode_rank(m: &str) -> Option<u8> {
    match m {
        "ask" => Some(0),
        "auto-safe" => Some(1),
        "full" => Some(2),
        _ => None,
    }
}

fn permission_title(p: &Value) -> String {
    match p["kind"].as_str() {
        Some("dependency-install") => "Install dependencies?".to_owned(),
        Some("bulk-delete") => "Delete several files?".to_owned(),
        _ => "Delete files?".to_owned(),
    }
}

/// What the person is asked, from the engine's own record of the operation.
fn permission_text(p: &Value) -> String {
    let args = p["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let command = format!("{} {}", p["program"].as_str().unwrap_or(""), args);
    let mut t = String::new();
    if p["kind"] == "dependency-install" {
        let plan = &p["plan"];
        t.push_str(&format!(
            "Package manager: {}\nOperation: {}\n",
            plan["manager"].as_str().unwrap_or("?"),
            plan["verb"].as_str().unwrap_or("?")
        ));
        let pk: Vec<String> = plan["packages"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| {
                        let c = x["constraint"].as_str().unwrap_or("");
                        if c.is_empty() {
                            x["name"].as_str().unwrap_or("").to_owned()
                        } else {
                            format!("{} ({})", x["name"].as_str().unwrap_or(""), c)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if pk.is_empty() {
            t.push_str("Packages: everything the project's manifest and lockfile declare\n");
        } else {
            t.push_str(&format!("Packages: {}\n", pk.join(", ")));
        }
        if let Some(o) = plan["options"].as_array().filter(|o| !o.is_empty()) {
            t.push_str(&format!(
                "Options: {}\n",
                o.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        t.push_str(&format!(
            "Workspace: {}\n",
            p["cwd"].as_str().unwrap_or(".")
        ));
        t.push_str(&format!("Command: {}\n", command.trim()));
        t.push_str("\nThis runs once, in the sandbox, with network access for the download. Approving does not allow any other installation.");
    } else {
        t.push_str(&format!(
            "Command: {}\nWorkspace: {}\n\nThis runs once, in the project's working copy.",
            command.trim(),
            p["cwd"].as_str().unwrap_or(".")
        ));
    }
    if let Some(purpose) = p["purpose"].as_str().filter(|x| !x.is_empty()) {
        t.push_str(&format!("\nRequested while: {purpose}"));
    }
    t
}

struct BusyGuard<'a>(&'a Coordinator, String);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut b) = self.0.busy.lock() {
            b.remove(&self.1);
        }
    }
}

fn human_bytes(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / 1048576.0)
    } else {
        format!("{} KB", n.div_ceil(1024))
    }
}

impl Coordinator {
    pub fn new(
        store: Arc<Store>,
        engine: Arc<dyn EngineLink>,
        dialogs: Arc<dyn Dialogs>,
        home: Option<PathBuf>,
    ) -> Arc<Coordinator> {
        Arc::new(Coordinator {
            store,
            engine,
            dialogs,
            home,
            busy: Mutex::new(HashSet::new()),
        })
    }

    fn guest(&self) -> EngineGuest {
        EngineGuest(self.engine.clone())
    }

    fn ctx<'a>(&'a self, g: &'a EngineGuest) -> Ctx<'a> {
        Ctx {
            store: &self.store,
            guest: g,
            fault: Fault::None,
        }
    }

    fn claim(&self, pid: &str) -> Option<BusyGuard<'_>> {
        let mut b = self.busy.lock().ok()?;
        if !b.insert(pid.to_owned()) {
            return None;
        }
        Some(BusyGuard(self, pid.to_owned()))
    }

    pub fn project_by_guest(&self, gid: &str) -> Option<Project> {
        self.store.find_by_guest(gid)
    }

    // ---- onboarding ----------------------------------------------------------------------

    /// A folder chosen in the native picker. Returns the same shape as the Linux `project_pick`.
    pub fn open_project(&self, picked: &str) -> Result<Value, UiError> {
        let st = self.engine.status();
        if !st.is_ready() {
            return Err(UiError { message: format!("The folder was not opened: {} No folder was stored and no permission was granted.", st.message()), ..st.unavailable_error() });
        }
        let (root, dev, ino) = validate_root(
            std::path::Path::new(picked),
            self.home.as_deref(),
            self.store.dir(),
        )
        .map_err(|e| ui("bad-project", e.message))?;
        let scan = manifest::scan(&root).map_err(|e| ui("bad-project", e.to_string()))?;
        let existing = self.store.find_by_identity(dev, ino);
        let pid = match &existing {
            Some(p) => {
                // choosing a known folder again lets the person review the one optional setting
                let cur = p.consent.as_ref().is_some_and(|c| c.apply_unverified);
                let choice = self.ask_apply_unverified(cur)?;
                if choice != cur {
                    self.store
                        .update(&p.id, |p| {
                            if let Some(c) = p.consent.as_mut() {
                                c.apply_unverified = choice;
                            }
                        })
                        .map_err(|e| ui("registry", e.0))?;
                }
                p.id.clone()
            }
            None => {
                let label = label_of(&root);
                let text = consent_text(&root, &scan);
                if !self
                    .dialogs
                    .confirm("Let Nexus work on this folder?", &text)
                    .map_err(|m| ui("project", m))?
                {
                    return Err(ui("cancelled", "cancelled"));
                }
                let apply_unverified = self.ask_apply_unverified(false)?;
                let p = Project {
                    id: new_project_id(),
                    label,
                    root: root.to_string_lossy().into_owned(),
                    root_dev: dev,
                    root_ino: ino,
                    created_ms: now_ms(),
                    consent: Some(Consent {
                        granted_at_ms: now_ms(),
                        scope: SCOPE_VERSION.into(),
                        root: root.to_string_lossy().into_owned(),
                        apply_unverified,
                    }),
                    guest_id: None,
                    generation: 0,
                    staged: false,
                    last_sync_ms: None,
                    staging: false,
                    skipped: scan.skipped.clone(),
                    skipped_total: scan.skipped_total as u64,
                    file_count: scan.files.len() as u64,
                    total_bytes: scan.total_bytes,
                    runs: vec![],
                };
                let id = p.id.clone();
                self.store.insert(p).map_err(|e| ui("registry", e.0))?;
                id
            }
        };
        let _g = self.claim(&pid).ok_or_else(|| {
            ui(
                "sync-run-active",
                "this folder is being synchronized right now",
            )
        })?;
        let gst = self.guest();
        let rep = stage_project(&self.ctx(&gst), &pid).map_err(|e| {
            if existing.is_none() {
                // a first staging that failed leaves no half-registered project behind
                let _ = self.store.remove(&pid);
                let _ = gst.0.sync(SyncReq::Discard {
                    project_id: pid.clone(),
                });
            }
            host_err(e)
        })?;
        let p = self
            .store
            .get(&pid)
            .ok_or_else(|| ui("registry", "project vanished"))?;
        let gid = p
            .guest_id
            .clone()
            .or(rep.guest_id)
            .ok_or_else(|| ui("sync-protocol", "the engine did not register the project"))?;
        let list = self
            .engine
            .call("project_list", json!({"withChanges": false}))?;
        let view = list["projects"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["projectId"] == gid.as_str()).cloned())
            .ok_or_else(|| ui("sync-protocol", "the engine does not list the project"))?;
        let mut v = json!({
            "project": view,
            "created": existing.is_none(),
            "snapshot": {"files": rep.files, "bytes": rep.bytes, "skippedTotal": p.skipped_total, "skipped": p.skipped.iter().take(20).map(|s| json!({"path": s.path, "reason": s.reason})).collect::<Vec<_>>()},
        });
        self.decorate_project(&mut v["project"]);
        Ok(v)
    }

    /// The per-project opt-in: also apply results that could not be verified (a project without tests).
    /// Default (Return key) is "No". A failed check, a cancelled run or an error is never applied either way.
    fn ask_apply_unverified(&self, current: bool) -> Result<bool, UiError> {
        let text = format!(
            "By default Nexus only updates your folder after a task finishes AND its checks pass. A project without tests can never pass a check, so its results would stay in the engine.\n\n\
             Allow Nexus to ALSO update this folder when a task finishes but could not be verified?\n\n\
             Never applied either way: results of failed checks, cancelled tasks, errors, and anything that would overwrite a change you made.\n\n\
             Currently: {}.",
            if current { "applies unverified results" } else { "applies only verified results" }
        );
        self.dialogs
            .confirm("Also apply results that could not be verified?", &text)
            .map_err(|m| ui("project", m))
    }

    // ---- before / after a task -------------------------------------------------------------

    /// Called before `thread_send` for a project. Returns the host project when it is a Mac project.
    pub fn preflight_send(&self, args: &Value) -> Result<Option<Project>, UiError> {
        let Some(gid) = args["projectId"].as_str() else {
            return Ok(None);
        };
        let Some(p) = self.project_by_guest(gid) else {
            return Ok(None);
        };
        if let Some(r) = p.active_run() {
            return Err(ui(
                "sync-run-active",
                format!(
                    "Nexus is still working on or applying changes to this folder (run {}).",
                    r.run_id
                ),
            ));
        }
        let guard = self.claim(&p.id).ok_or_else(|| {
            ui(
                "sync-run-active",
                "this folder is being synchronized right now",
            )
        })?;
        let gst = self.guest();
        let ctx = self.ctx(&gst);
        // an unresolved result is retried first: the person may have resolved the difference
        if let Some(c) = p.pending_conflict() {
            let _ = retry_conflict(&ctx, &p.id, &c.run_id);
        }
        stage_project(&ctx, &p.id).map_err(host_err)?;
        drop(guard);
        Ok(self.store.get(&p.id))
    }

    /// Record the run the engine accepted for a Mac project.
    pub fn after_send(&self, p: &Project, reply: &Value) {
        if let Some(run) = reply["run"]["runId"].as_str() {
            let _ = track_run(
                &self.store,
                &p.id,
                run,
                reply["threadId"].as_str().map(str::to_owned),
            );
        }
    }

    /// One pass of the follow-up loop: finish interrupted writebacks, follow running runs, and write
    /// back the ones that ended. Safe to call as often as wanted; every step is idempotent.
    pub fn tick(&self) {
        let ready = self.engine.status().is_ready();
        for p in self.store.list() {
            let Some(_g) = self.claim(&p.id) else {
                continue;
            };
            let gst = self.guest();
            let ctx = self.ctx(&gst);
            // host-only recovery needs no engine; the engine acknowledgement is retried when it is back
            let _ = recover_project(&ctx, &p.id);
            if !ready {
                continue;
            }
            let p = match self.store.get(&p.id) {
                Some(p) => p,
                None => continue,
            };
            for r in p
                .runs
                .iter()
                .filter(|r| matches!(r.sync, SyncState::Running | SyncState::Exporting))
            {
                if self.store.journal(&p.id, &r.run_id).is_some_and(|j| {
                    !matches!(j.state, JState::Applied | JState::Conflict | JState::Failed)
                }) {
                    continue;
                }
                let Ok(run) = self
                    .engine
                    .call("intent_status", json!({"runId": r.run_id}))
                else {
                    continue;
                };
                if run["terminal"].as_bool() != Some(true) {
                    continue;
                }
                let _ = writeback_run(&ctx, &p.id, &r.run_id, &run);
            }
        }
    }

    /// `project_adopt` on a Mac project: retry applying a preserved result.
    pub fn adopt(&self, run_id: &str) -> Result<Value, UiError> {
        let p = self
            .store
            .list()
            .into_iter()
            .find(|p| p.run(run_id).is_some())
            .ok_or_else(|| ui("not-found", "unknown run"))?;
        let _g = self.claim(&p.id).ok_or_else(|| {
            ui(
                "sync-run-active",
                "this folder is being synchronized right now",
            )
        })?;
        let gst = self.guest();
        let o = retry_conflict(&self.ctx(&gst), &p.id, run_id).map_err(host_err)?;
        match o {
            Outcome::Applied { changed } => Ok(
                json!({"applied": self.store.get(&p.id).and_then(|p| p.run(run_id).map(|r| r.changed.iter().map(|c| c.path.clone()).collect::<Vec<_>>())).unwrap_or_default(), "changed": changed}),
            ),
            Outcome::Conflict(c) => Err(ui(
                "sync-conflict",
                format!(
                    "Your Mac folder still differs in {} place(s); nothing was changed.",
                    c.len()
                ),
            )),
            Outcome::Failed(m) | Outcome::NotApplied(m) => Err(ui("sync-failed", m)),
        }
    }

    /// `project_forget` on a Mac project: the engine forgets it (caller), then the engine-side copy and the
    /// Mac record go. The Mac folder itself is never touched.
    pub fn forget(&self, gid: &str) -> Result<(), UiError> {
        let Some(p) = self.project_by_guest(gid) else {
            return Ok(());
        };
        if p.active_run().is_some() {
            return Err(ui(
                "sync-run-active",
                "Nexus is still working on this folder.",
            ));
        }
        let _ = self.engine.sync(SyncReq::Discard {
            project_id: p.id.clone(),
        });
        self.store.remove(&p.id).map_err(|e| ui("registry", e.0))
    }

    // ---- command interception ---------------------------------------------------------------

    /// Serve one engine command for the renderer: forwards to the engine, wrapping the commands whose
    /// meaning changes when the project folder lives on the Mac.
    pub fn serve(&self, cmd: &str, args: Value) -> Result<Value, UiError> {
        match cmd {
            "run_analytics_save" => {
                // write the benchmark document into the person's Downloads folder; the file name comes from the
                // validated run id, never from the renderer
                let run_id = args["runId"].as_str().unwrap_or_default().to_owned();
                if run_id.is_empty()
                    || run_id.len() > 64
                    || !run_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    return Err(ui("bad-usage", "not a run id"));
                }
                let doc = self.engine.call(
                    "run_analytics_export",
                    json!({"runId": run_id,
                           "hostPlatform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                           "appVersion": env!("CARGO_PKG_VERSION")}),
                )?;
                let home = self
                    .home
                    .clone()
                    .ok_or_else(|| ui("no-home", "there is no home folder to save into"))?;
                let dir = home.join("Downloads");
                std::fs::create_dir_all(&dir).map_err(|e| ui("save-failed", e.to_string()))?;
                let path = dir.join(format!("nexus-run-analytics-{run_id}.json"));
                std::fs::write(
                    &path,
                    serde_json::to_vec_pretty(&doc)
                        .map_err(|e| ui("save-failed", e.to_string()))?,
                )
                .map_err(|e| ui("save-failed", e.to_string()))?;
                Ok(json!({"path": path.to_string_lossy()}))
            }
            "run_analytics_export" => {
                // the engine cannot know the Mac it serves: the app states its own platform and version
                let mut args = args;
                args["hostPlatform"] = json!(format!(
                    "{}-{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ));
                args["appVersion"] = json!(env!("CARGO_PKG_VERSION"));
                self.engine.call(cmd, args)
            }
            "permission_decide" => self.permission_decide(args),
            "permission_set_mode" => self.permission_set_mode(args),
            "thread_send" => {
                self.permission_preflight(&args)?;
                // the Desktop always names a mode; the default is Ask for Approval
                let mut args = args;
                if args["permissionMode"].as_str().is_none_or(str::is_empty) {
                    args["permissionMode"] = json!("ask");
                }
                let pf = self.preflight_send(&args)?;
                let mut r = self.engine.call(cmd, args)?;
                if let Some(p) = pf {
                    self.after_send(&p, &r);
                }
                self.decorate_runs_deep(&mut r);
                Ok(r)
            }
            "project_list" => {
                let mut r = self.engine.call(cmd, args)?;
                self.decorate_project_list(&mut r);
                Ok(r)
            }
            "project_forget" => {
                let gid = args["projectId"].as_str().unwrap_or_default().to_owned();
                if let Some(p) = self.project_by_guest(&gid) {
                    if p.active_run().is_some() {
                        return Err(ui(
                            "sync-run-active",
                            "Nexus is still working on this folder.",
                        ));
                    }
                }
                let r = self.engine.call(cmd, args)?;
                self.forget(&gid)?;
                Ok(r)
            }
            "project_adopt" => {
                let run = args["runId"].as_str().unwrap_or_default().to_owned();
                if self.store.list().iter().any(|p| p.run(&run).is_some()) {
                    return self.adopt(&run);
                }
                self.engine.call(cmd, args)
            }
            "project_set_edit_mode" | "project_set_workspace" => {
                if args["projectId"]
                    .as_str()
                    .and_then(|g| self.project_by_guest(g))
                    .is_some()
                {
                    return Err(ui("sync-unsupported", "Folders on your Mac are always worked on in the Linux engine and updated automatically after a verified task."));
                }
                self.engine.call(cmd, args)
            }
            "thread_get" | "thread_list" | "intent_status" | "intent_list" | "intent_resume"
            | "intent_cancel" => {
                let mut r = self.engine.call(cmd, args)?;
                self.decorate_runs_deep(&mut r);
                Ok(r)
            }
            _ => self.engine.call(cmd, args),
        }
    }

    // ---- permission modes (M4.5) ------------------------------------------------------------
    //
    // The decisions below are made in NATIVE confirmations shown by this process, built from the
    // engine's own record of the operation (never from what the renderer sends), so page content
    // and model text cannot click them or change what they say.

    /// Before a task starts: validate the mode, show the one-time Full Access confirmation, and make
    /// sure the project's standing permissions can carry dependency installs at all (each install
    /// still asks, or not, according to the mode).
    fn permission_preflight(&self, args: &Value) -> Result<(), UiError> {
        let mode = args["permissionMode"].as_str().unwrap_or("");
        if !matches!(mode, "" | "ask" | "auto-safe" | "full") {
            return Err(ui("bad-usage", "unknown permission mode"));
        }
        if mode == "full"
            && !self
                .dialogs
                .confirm("Full Access", FULL_ACCESS_TEXT)
                .map_err(|e| ui("permission-dialog", e))?
        {
            return Err(ui(
                "permission-declined",
                "Full Access was not enabled and nothing was started.",
            ));
        }
        // a project whose standing grant has no install network cannot install anything in any mode
        if let Some(gid) = args["projectId"].as_str() {
            if let Ok(list) = self
                .engine
                .call("project_list", json!({"withChanges": false}))
            {
                let offline = list["projects"].as_array().is_some_and(|ps| {
                    ps.iter().any(|p| {
                        p["projectId"].as_str() == Some(gid)
                            && p["grant"]["net"].as_str() == Some("offline")
                    })
                });
                if offline {
                    // the broker's own consent text in a native dialog; a "no" leaves the project offline
                    let _ = self.engine.call(
                        "project_allow_installs",
                        json!({"projectId": gid, "allow": true}),
                    );
                }
            }
        }
        Ok(())
    }

    fn pending_of(&self, run_id: &str) -> Result<(Value, Value), UiError> {
        let st = self
            .engine
            .call("intent_status", json!({"runId": run_id}))?;
        let run = if st["run"].is_object() {
            st["run"].clone()
        } else {
            st
        };
        Ok((run.clone(), run["pendingPermission"].clone()))
    }

    /// The person's decision on a pending request. Approving needs a native confirmation that shows
    /// the engine's own description of exactly what will run.
    fn permission_decide(&self, args: Value) -> Result<Value, UiError> {
        let run_id = args["runId"].as_str().unwrap_or_default().to_owned();
        let request_id = args["requestId"].as_str().unwrap_or_default().to_owned();
        let decision = args["decision"].as_str().unwrap_or_default().to_owned();
        let (_, pending) = self.pending_of(&run_id)?;
        if pending["requestId"].as_str() != Some(request_id.as_str()) {
            return Err(ui(
                "permission-gone",
                "That request is no longer waiting (it was decided, expired or the run ended).",
            ));
        }
        let digest = pending["digest"].as_str().unwrap_or_default().to_owned();
        // whatever digest the renderer names, the decision is bound to the engine's record
        if args["digest"].as_str().is_some_and(|d| d != digest) {
            return Err(ui(
                "permission-mismatch",
                "The request changed; review it again.",
            ));
        }
        let go = match decision.as_str() {
            "deny" => false,
            "approve" => self
                .dialogs
                .confirm(&permission_title(&pending), &permission_text(&pending))
                .map_err(|e| ui("permission-dialog", e))?,
            _ => return Err(ui("bad-usage", "decision must be approve or deny")),
        };
        self.engine.call(
            "permission_decide",
            json!({"runId": run_id, "requestId": request_id, "digest": digest,
                   "decision": if go { "approve" } else { "deny" }}),
        )
    }

    /// Change a run's permission mode. A more autonomous mode needs the engine's upgrade token, which
    /// is only released after the person confirmed the engine's own text natively.
    fn permission_set_mode(&self, args: Value) -> Result<Value, UiError> {
        let run_id = args["runId"].as_str().unwrap_or_default().to_owned();
        let to = args["mode"].as_str().unwrap_or_default().to_owned();
        let (run, _) = self.pending_of(&run_id)?;
        let cur = run["permissionMode"].as_str().unwrap_or("ask");
        if mode_rank(&to).is_none() {
            return Err(ui("bad-usage", "unknown permission mode"));
        }
        if mode_rank(&to) > mode_rank(cur) {
            let prep = self.engine.call(
                "permission_prepare_upgrade",
                json!({"runId": run_id, "mode": to}),
            )?;
            let text = prep["text"].as_str().unwrap_or_default();
            let title = if to == "full" {
                "Full Access"
            } else {
                "Permission mode"
            };
            if !self
                .dialogs
                .confirm(title, text)
                .map_err(|e| ui("permission-dialog", e))?
            {
                return Err(ui("permission-declined", "The mode was not changed."));
            }
            return self.engine.call(
                "permission_set_mode",
                json!({"runId": run_id, "mode": to, "upgradeToken": prep["token"]}),
            );
        }
        // a downgrade (or no change) applies at once and needs no confirmation
        self.engine
            .call("permission_set_mode", json!({"runId": run_id, "mode": to}))
    }

    // ---- presentation --------------------------------------------------------------------

    pub fn sync_view(&self, p: &Project) -> Value {
        let state = if p.staging {
            "staging"
        } else if let Some(r) = p.active_run() {
            match r.sync {
                SyncState::Running => "running",
                SyncState::Exporting => "exporting",
                SyncState::Prepared => "prepared",
                _ => "applying",
            }
        } else if p.pending_conflict().is_some() {
            "conflict"
        } else if p.runs.last().is_some_and(|r| r.sync == SyncState::Failed) {
            "failed"
        } else {
            "synced"
        };
        json!({
            "state": state,
            "generation": p.generation,
            "lastSyncMs": p.last_sync_ms,
            "consent": p.consent.is_some(),
            "applyUnverified": p.consent.as_ref().is_some_and(|c| c.apply_unverified),
            "files": p.file_count,
            "skippedTotal": p.skipped_total,
            "conflicts": p.pending_conflict().map(|r| r.conflicts.clone()).unwrap_or_default(),
        })
    }

    pub fn run_view(&self, r: &RunRecord) -> Value {
        let (state, label): (&str, String) = match &r.sync {
            SyncState::Staging => ("staging", "Copying your folder to the engine".into()),
            SyncState::Running => ("running", "Nexus is working".into()),
            SyncState::Exporting => ("exporting", "Collecting the result".into()),
            SyncState::Prepared => ("prepared", "Ready to update your Mac folder".into()),
            SyncState::Applying => ("applying", "Updating your Mac folder".into()),
            SyncState::Applied => ("applied", "Applied to your Mac folder".into()),
            SyncState::Conflict => (
                "conflict",
                "Not applied: your Mac folder changed too".into(),
            ),
            SyncState::Failed => ("failed", "Not applied: an error stopped the update".into()),
            SyncState::NotApplied { reason } => (
                "not-applied",
                format!("Not applied to your Mac folder: {reason}"),
            ),
        };
        json!({
            "state": state,
            "label": label,
            "changed": r.changed,
            "conflicts": r.conflicts,
            "verification": r.verification,
            "appliedMs": r.applied_ms,
            "message": r.message,
            "savedResult": r.saved_result,
        })
    }

    /// Rewrite one project view from the engine so it speaks about the Mac folder.
    pub fn decorate_project(&self, v: &mut Value) {
        let Some(gid) = v["projectId"].as_str().map(str::to_owned) else {
            return;
        };
        let Some(p) = self.project_by_guest(&gid) else {
            return;
        };
        // Everything the engine reports about THIS project (its Direct workspace and its execution grant) is
        // true of the engine-side working copy and is passed through unchanged: hiding it made a permission
        // the person had just confirmed invisible. What is added is the Mac side: the folder and how it is
        // kept in sync. The UI tells the two apart by `sync`.
        if let Some(o) = v.as_object_mut() {
            o.insert("macPath".into(), json!(p.root));
            o.insert("label".into(), json!(p.label));
            o.insert("sync".into(), self.sync_view(&p));
            o.insert("changedSinceSnapshot".into(), Value::Null);
            o.insert("originDirty".into(), json!(false));
        }
    }

    pub fn decorate_project_list(&self, v: &mut Value) {
        if let Some(a) = v["projects"].as_array_mut() {
            for x in a {
                self.decorate_project(x);
            }
        }
    }

    /// Attach `hostSync` to an engine run record (or any value carrying `runId`).
    pub fn decorate_run(&self, run: &mut Value) {
        let Some(id) = run["runId"].as_str().map(str::to_owned) else {
            return;
        };
        if let Some(rec) = self.store.list().iter().find_map(|p| p.run(&id).cloned()) {
            let view = self.run_view(&rec);
            if let Some(o) = run.as_object_mut() {
                o.insert("hostSync".into(), view);
                // the engine's workspace wording does not describe the Mac folder
                o.insert("workspaceKind".into(), json!("isolated"));
                o.insert("workspaceRelation".into(), json!("copy"));
                o.insert("workspaceNote".into(), json!("Nexus works in a copy on its Linux engine and applies verified changes to your Mac folder automatically."));
            }
        }
    }

    /// Walk a response and decorate every run record in it.
    pub fn decorate_runs_deep(&self, v: &mut Value) {
        match v {
            Value::Object(o) => {
                if o.contains_key("runId") {
                    self.decorate_run(v);
                }
                if let Value::Object(o) = v {
                    for (_, x) in o.iter_mut() {
                        self.decorate_runs_deep(x);
                    }
                }
            }
            Value::Array(a) => {
                for x in a {
                    self.decorate_runs_deep(x);
                }
            }
            _ => {}
        }
    }
}

fn consent_text(root: &std::path::Path, scan: &manifest::Scan) -> String {
    let sensitive = scan
        .skipped
        .iter()
        .filter(|s| s.reason == super::policy::SkipReason::SensitiveName)
        .count();
    format!(
        "Folder: {}\n\n\
         Nexus will copy {} files ({}) of this folder to its Linux engine, do its work there, and, when a task finishes AND its checks pass, automatically update this folder with the changes. You will not be asked again for this folder.\n\n\
         Never copied: Git data, secrets and key files ({} found), build and cache folders, links and special files. Nexus never overwrites a file you changed in the meantime: it keeps both versions and tells you.\n\n\
         You can stop this at any time by removing the project.",
        root.display(),
        scan.files.len(),
        human_bytes(scan.total_bytes),
        sensitive,
    )
}
