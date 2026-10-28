//! A6.1.4 interactive profile in the Tauri backend: runtime lifecycle, one-time
//! provider connection and consent, and project opening. Everything privileged
//! happens here, in the native process, in response to a person's gesture in a NATIVE
//! dialog - the renderer only asks "start", "connect", "open a project", and receives
//! results. It never supplies a path, a key, an authorization or a limit.

use crate::dialogs::Dialogs;
use crate::dto::UiError;
use nexus_client::intent_client as ic;
use nexus_runtime::{Home, Phase, Tools};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsentView {
    pub given: bool,
    pub provider_id: Option<String>,
    pub remote_model_id: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    /// `interactive` (this app runs the runtime) | `external` (an operator-run broker; strict profile)
    pub mode: &'static str,
    /// `starting` | `ready` | `error` | `stopped`
    pub phase: String,
    pub message: Option<String>,
    pub home: Option<String>,
    pub provider_connected: bool,
    pub consent: ConsentView,
    /// The broker can open projects (interactive profile only).
    pub can_open_projects: bool,
    /// Nexus was updated while a task is running: the runtime restarts by itself when
    /// the task finishes; new tasks wait until then.
    pub update_pending: bool,
    /// How the person decides a pending operation of a project that asks: the trusted terminal approver,
    /// with this installation's real paths (the credential file's PATH, never its content). Absent when
    /// the approver is not installed or the runtime is operator-run.
    pub approver_command: Option<String>,
}

pub type ActivityProbe = Box<dyn Fn() -> Result<usize, String> + Send + Sync>;

pub struct Runtime {
    pub external: bool,
    pub home: Option<Home>,
    tools: Result<Tools, String>,
    state: Mutex<(String, Option<String>)>,
    /// Submissions hold the read side while they reach the broker; a runtime replacement
    /// takes the write side, so it never overlaps one and its active-run check sees it.
    gate: RwLock<()>,
    update_pending: AtomicBool,
    /// Set by the watcher once the runtime has been silent long enough to be called hung.
    force_replace: AtomicBool,
    /// Test hook: replaces the broker query for "how many runs are active".
    #[doc(hidden)]
    pub activity_probe: Mutex<Option<ActivityProbe>>,
}

static GLOBAL: std::sync::OnceLock<std::sync::Arc<Runtime>> = std::sync::OnceLock::new();

/// Make the app's runtime reachable from the submit commands (their signatures are
/// fixed by the authority tests). Unset in unit tests, where `guarded` is a pass-through.
pub fn install(rt: std::sync::Arc<Runtime>) {
    let _ = GLOBAL.set(rt);
}

/// Phase 2: the Home of the engine preference / saved adaptive configuration (the app's own runtime, or
/// the environment's home when an external broker is used).
pub fn engine_home() -> Result<Home, String> {
    match GLOBAL.get() {
        Some(rt) => rt.engine_home(),
        None => Home::resolve(),
    }
}

/// Phase 2: the engine choice for a NEW task: the explicit `engine` (adaptive | stable) or the operator's
/// preference (default adaptive). `Ok(None)` = stable (the request every earlier version sent);
/// adaptive that cannot be used is an error with an actionable message - never a silent stable.
pub fn new_task_selection(
    engine: Option<&str>,
) -> Result<Option<nexus_runtime::engine_choice::Selection>, UiError> {
    use nexus_runtime::engine_choice as ec;
    let requested = match engine {
        None => None,
        Some(e) => Some(ec::Engine::parse(e).ok_or(UiError {
            code: "bad-usage".to_owned(),
            message: "the engine must be adaptive or stable".to_owned(),
        })?),
    };
    let home = engine_home().map_err(|m| UiError {
        code: "engine".to_owned(),
        message: m,
    })?;
    if requested.unwrap_or_else(|| ec::preferred(&home)) == ec::Engine::Stable {
        return Ok(None);
    }
    let targets = ic::registry_targets(&ic::default_broker_socket())
        .map_err(|e| crate::backend::ui_error(&e))?;
    ec::selection_for(&home, requested, &targets).map_err(|e| UiError {
        code: e.code.to_owned(),
        message: e.message,
    })
}

/// Run a submission under the runtime's freshness check and update gate.
pub fn guarded<T>(call: impl FnOnce() -> Result<T, UiError>) -> Result<T, UiError> {
    match GLOBAL.get() {
        Some(rt) => rt.submit_guarded(call),
        None => call(),
    }
}

/// A run that has not ended; a restart must never take it down.
fn active_runs(rt: &Runtime) -> Result<usize, String> {
    if let Some(p) = rt
        .activity_probe
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|f| f()))
    {
        return p;
    }
    let sock = rt.sock();
    ic::list(&sock, 200)
        .map(|r| r.iter().filter(|x| !x.terminal).count())
        // a broker that answers "busy" is alive and serving work: that is not "idle"
        .map_err(|e| format!("{}:{}", e.code, e.message))
}

impl Runtime {
    /// External mode when `NEXUS_BROKER_SOCKET` is set (fixtures, operator-run strict
    /// profile): this app never starts or stops anything then.
    pub fn new() -> Runtime {
        let external = std::env::var_os("NEXUS_BROKER_SOCKET").is_some_and(|v| !v.is_empty());
        let home = if external { None } else { Home::resolve().ok() };
        if let Some(h) = &home {
            // The existing commands resolve their sockets from the environment.
            std::env::set_var("NEXUS_BROKER_SOCKET", h.broker_socket());
            std::env::set_var("NEXUS_SOCKET", h.daemon_socket());
        }
        Runtime {
            external,
            tools: if external {
                Err("external".into())
            } else {
                Tools::discover()
            },
            home,
            state: Mutex::new((if external { "ready" } else { "starting" }.to_owned(), None)),
            gate: RwLock::new(()),
            update_pending: AtomicBool::new(false),
            force_replace: AtomicBool::new(false),
            activity_probe: Mutex::new(None),
        }
    }

    fn phase(&self) -> String {
        self.state.lock().map(|s| s.0.clone()).unwrap_or_default()
    }

    fn set(&self, phase: &str, msg: Option<String>) {
        if let Ok(mut s) = self.state.lock() {
            *s = (phase.to_owned(), msg);
        }
    }

    /// Start (or attach to) the runtime in the background; idempotent.
    pub fn start_async(self: &std::sync::Arc<Self>) {
        if self.external {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || me.start_blocking());
    }

    pub fn start_blocking(&self) {
        let (Some(home), Ok(tools)) = (&self.home, &self.tools) else {
            self.set(
                "error",
                Some(
                    self.tools
                        .as_ref()
                        .err()
                        .cloned()
                        .unwrap_or_else(|| "no data directory".into()),
                ),
            );
            return;
        };
        let _w = self.gate.write().unwrap_or_else(|e| e.into_inner());
        let was_ready = self.state.lock().map(|s| s.0 == "ready").unwrap_or(false);
        // an update with work in flight keeps the old, working broker until it is idle
        self.set("starting", was_ready.then(|| "Updating Nexus…".to_owned()));
        let r = nexus_runtime::start_if(home, tools, || match active_runs(self) {
            Ok(0) => Ok(()),
            Ok(n) => Err(format!("{n} task(s) are still running")),
            // alive but refusing: it is serving work
            Err(m) if m.starts_with("busy:") => {
                Err("the runtime is busy; still running".to_owned())
            }
            // not answering: replace it only if its process is gone, or the watcher has
            // found it silent for minutes. A slow broker is still running someone's task.
            Err(_)
                if self.force_replace.load(Ordering::SeqCst)
                    || nexus_runtime::status(home).broker_pid.is_none() =>
            {
                Ok(())
            }
            Err(_) => Err("the runtime is slow to answer; still running".to_owned()),
        });
        match r {
            Ok(st) if st.phase == Phase::Ready => {
                self.update_pending.store(false, Ordering::SeqCst);
                self.set("ready", None);
            }
            Ok(st) => self.set("error", Some(format!("{:?}", st.phase))),
            Err(e) if e.ends_with("still running") => {
                // deferred, nothing was stopped
                self.update_pending.store(true, Ordering::SeqCst);
                self.set("ready", None);
            }
            Err(e) => self.set("error", Some(e)),
        }
    }

    /// Before work is sent: if the running broker predates the installed binary,
    /// replace it (idle) or say clearly why not (busy). Never kills a running task.
    /// Returns once the runtime answers again. Ok means "safe to submit".
    pub fn ensure_current(&self) -> Result<(), String> {
        let (Some(home), Ok(tools)) = (&self.home, &self.tools) else {
            return Ok(()); // external: this app does not manage the broker
        };
        match nexus_runtime::freshness(home, tools) {
            nexus_runtime::Freshness::Stale => {}
            // a runtime that failed to come back (e.g. after a bad update) is retried
            nexus_runtime::Freshness::NotRunning if self.phase() == "error" => {}
            nexus_runtime::Freshness::Current => {
                self.update_pending.store(false, Ordering::SeqCst);
                return Ok(());
            }
            _ => return Ok(()),
        }
        // an update is applied only when the runtime positively reports that it is idle
        if matches!(active_runs(self), Ok(0)) {
            self.start_blocking();
        } else {
            self.update_pending.store(true, Ordering::SeqCst);
        }
        let st = self.state();
        if self.update_pending.load(Ordering::SeqCst) {
            return Err(
                "Nexus was updated. A task is still running; the update is applied \
                        automatically when it finishes, then you can start the next task."
                    .to_owned(),
            );
        }
        if st.phase != "ready" {
            return Err(format!(
                "Nexus was updated but could not restart: {}",
                st.message.unwrap_or_else(|| st.phase.clone())
            ));
        }
        Ok(())
    }

    /// Shared by every submit command: freshness check, then the call under the read
    /// gate. There is deliberately no automatic re-send: the broker's own `broker-stale`
    /// refusal arrives as a failed run (nothing sent), and re-submitting behind the
    /// user's back could create a second task.
    pub fn submit_guarded<T>(
        &self,
        call: impl FnOnce() -> Result<T, UiError>,
    ) -> Result<T, UiError> {
        if let Err(m) = self.ensure_current() {
            return Err(UiError {
                code: "runtime-updating".to_owned(),
                message: m,
            });
        }
        let _r = self.gate.read().unwrap_or_else(|e| e.into_inner());
        call()
    }

    /// Background watcher: apply a pending or newly noticed update as soon as idle.
    pub fn watch_for_updates(self: &std::sync::Arc<Self>) {
        if self.external {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let mut unanswered = 0u32;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let phase = me.phase();
                if phase == "ready" {
                    // a runtime that stopped answering (crashed process, killed daemon) is
                    // brought back by itself; work that was running is closed honestly by
                    // the broker's startup recovery
                    if ic::code_config(&me.sock()).is_ok() {
                        unanswered = 0;
                        let _ = me.ensure_current();
                    } else {
                        unanswered += 1;
                        // a dead process is replaced after two silent checks; a live but
                        // silent one only after about two minutes
                        let alive = me
                            .home
                            .as_ref()
                            .is_some_and(|h| nexus_runtime::status(h).broker_pid.is_some());
                        if unanswered >= if alive { 12 } else { 2 } {
                            unanswered = 0;
                            me.force_replace.store(alive, Ordering::SeqCst);
                            me.start_blocking();
                            me.force_replace.store(false, Ordering::SeqCst);
                        }
                    }
                } else if phase == "error" {
                    // retry a failed start/update every so often
                    unanswered += 1;
                    if unanswered >= 3 {
                        unanswered = 0;
                        me.start_blocking();
                    }
                }
            }
        });
    }

    /// Stop what this app started (a runtime started by someone else is left alone).
    pub fn shutdown(&self) {
        if self.external || std::env::var_os("NEXUS_KEEP_RUNTIME").is_some() {
            return;
        }
        if let Some(h) = &self.home {
            if nexus_runtime::status(h).started_by_this_process {
                let _ = nexus_runtime::stop(h);
            }
        }
    }

    fn sock(&self) -> std::path::PathBuf {
        ic::default_broker_socket()
    }

    pub fn state(&self) -> RuntimeState {
        let (phase, message) = self
            .state
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| ("error".into(), None));
        let mut st = RuntimeState {
            mode: if self.external {
                "external"
            } else {
                "interactive"
            },
            phase: phase.clone(),
            message,
            home: self
                .home
                .as_ref()
                .map(|h| h.root.to_string_lossy().into_owned()),
            provider_connected: self
                .home
                .as_ref()
                .is_some_and(nexus_runtime::provider_connected),
            consent: ConsentView {
                given: false,
                provider_id: None,
                remote_model_id: None,
                text: None,
            },
            can_open_projects: false,
            update_pending: self.update_pending.load(Ordering::SeqCst),
            approver_command: match (&self.home, &self.tools, self.external) {
                (Some(h), Ok(t), false) => t.approver.as_ref().map(|bin| {
                    format!(
                        "{} --socket {} --cap-file {} review ",
                        bin.display(),
                        h.daemon_socket().display(),
                        h.approver_cap().display()
                    )
                }),
                _ => None,
            },
        };
        if phase == "ready" {
            if let Ok(c) = ic::consent_status(&self.sock()) {
                if c["interactive"] == true {
                    st.can_open_projects = true;
                    st.consent = ConsentView {
                        given: !c["consent"].is_null(),
                        provider_id: c["providerId"].as_str().map(str::to_owned),
                        remote_model_id: c["remoteModelId"].as_str().map(str::to_owned),
                        text: c["text"].as_str().map(str::to_owned),
                    };
                }
            } else if !self.external {
                // the runtime died after it was ready
                st.phase = "error".into();
                st.message = Some("the Nexus runtime is not answering".into());
            }
        }
        st
    }

    /// One-time provider connection: the key is typed in a NATIVE password prompt.
    pub fn provider_connect(
        &self,
        d: &dyn Dialogs,
    ) -> Result<nexus_runtime::ConnectReport, String> {
        let (Some(home), Ok(tools)) = (&self.home, &self.tools) else {
            return Err("this app is not running its own runtime".into());
        };
        let Some(key) = d.secret(
            "Connect OpenCode Go",
            "Paste your OpenCode Go API key (stored privately on this computer)",
        )?
        else {
            return Err("cancelled".into());
        };
        nexus_runtime::connect_provider(home, tools, &key)
    }

    /// Phase 2: the explicit one-time setup of Nexus Adaptive. A NATIVE confirmation states exactly what
    /// will be sent to the provider; only a "yes" there starts it. The renderer supplies nothing.
    pub fn adaptive_setup(&self, d: &dyn Dialogs) -> Result<nexus_runtime::ConnectReport, String> {
        let (Some(home), Ok(tools)) = (&self.home, &self.tools) else {
            return Err("this app is not running its own runtime".into());
        };
        if !d.confirm(
            "Set up Nexus Adaptive",
            "Nexus will verify the adaptive route with OpenCode Go using your stored key: 8 small requests (a models call, a short text request at each reasoning level low, medium, high and xhigh, a streaming request, a tool call and its continuation). They count against your OpenCode Go plan. If every check passes, the adaptive configuration is saved. Nothing else is sent.",
        )? {
            return Err("cancelled".into());
        }
        nexus_runtime::enable_adaptive(home, tools)
    }

    /// The Home the engine preference and the saved adaptive configuration live in.
    pub fn engine_home(&self) -> Result<Home, String> {
        match &self.home {
            Some(h) => Ok(h.clone()),
            None => Home::resolve(),
        }
    }

    /// One-time consent: the exact text the broker serves is shown in a NATIVE dialog;
    /// only a "yes" there records it.
    pub fn provider_consent(&self, d: &dyn Dialogs) -> Result<ConsentView, String> {
        let c = ic::consent_status(&self.sock()).map_err(|e| e.message)?;
        if c["interactive"] != true {
            return Err("this runtime does not use consent-based authorization".into());
        }
        if c["providerReady"] == false {
            return Err("connect OpenCode Go first".into());
        }
        if c["providerReady"] == false {
            return Err("connect OpenCode Go first".into());
        }
        let (p, m, text, digest) = (
            c["providerId"].as_str().unwrap_or(""),
            c["remoteModelId"].as_str().unwrap_or(""),
            c["text"].as_str().unwrap_or(""),
            c["textSha256"].as_str().unwrap_or(""),
        );
        if !d.confirm("Allow autonomous work", text)? {
            return Err("cancelled".into());
        }
        ic::consent_grant(&self.sock(), p, m, digest).map_err(|e| e.message)?;
        Ok(self.state().consent)
    }

    pub fn provider_revoke(&self, d: &dyn Dialogs) -> Result<ConsentView, String> {
        if !d.confirm("Revoke consent", "Nexus will stop working autonomously until you allow it again. Running tasks are not interrupted.")? {
            return Err("cancelled".into());
        }
        ic::consent_revoke(&self.sock()).map_err(|e| e.message)?;
        Ok(self.state().consent)
    }

    /// Native folder picker -> broker `project-open`. The path never touches the renderer.
    pub fn project_pick(&self, d: &dyn Dialogs) -> Result<serde_json::Value, String> {
        let Some(path) = d.pick_folder("Open a project folder")? else {
            return Err("cancelled".into());
        };
        // A project that is already open keeps its durable workspace choice. A NEW one asks, in plain
        // words and before any task can run, where Nexus is allowed to make changes.
        let v = ic::project_open_with(&self.sock(), &path, None).map_err(|e| e.message)?;
        if v.get("created") == Some(&serde_json::Value::Bool(true)) {
            let id = v["project"]["projectId"].as_str().unwrap_or("").to_owned();
            if d.confirm(DIRECT_TITLE, DIRECT_TEXT)? {
                return ic::project_set_workspace(&self.sock(), &id, "direct")
                    .map(|mut w| {
                        // keep the snapshot facts of the open; the project view is the updated one
                        if let (Some(o), Some(n)) = (v.as_object(), w.as_object_mut()) {
                            for (k, val) in o {
                                n.entry(k.clone()).or_insert(val.clone());
                            }
                        }
                        w
                    })
                    .map_err(|e| e.message);
            }
        }
        Ok(v)
    }

    /// Change where NEW tasks of an opened project edit. Choosing the direct workspace needs a native
    /// confirmation (the agent will change the real files); choosing the isolated copy does not.
    pub fn project_set_workspace(
        &self,
        d: &dyn Dialogs,
        id: &str,
        mode: &str,
    ) -> Result<serde_json::Value, String> {
        if mode == "direct" && !d.confirm(DIRECT_TITLE, DIRECT_TEXT)? {
            return Err("cancelled".into());
        }
        ic::project_set_workspace(&self.sock(), id, mode).map_err(|e| e.message)
    }

    /// Apply a finished run's patch to the user's folder after a NATIVE confirmation that
    /// lists the files. The broker re-checks everything (ownership, unchanged folder,
    /// all-or-nothing) and audits it.
    pub fn adopt_patch(&self, d: &dyn Dialogs, run_id: &str) -> Result<serde_json::Value, String> {
        let diff = ic::diff(&self.sock(), run_id).map_err(|e| e.message)?;
        if diff.files.is_empty() {
            return Err("this run changed no files".into());
        }
        let list: Vec<String> = diff
            .files
            .iter()
            .take(30)
            .map(|f| format!("  {} {}", f.status, f.path))
            .collect();
        let text = format!(
            "Apply Nexus's changes to your project folder?\n\n{}\n\nThis modifies files in your folder (it does not commit, push or deploy). Nexus applies all of it or none of it, and only if the folder is unchanged since Nexus copied it.",
            list.join("\n")
        );
        if !d.confirm("Apply changes to your folder", &text)? {
            return Err("cancelled".into());
        }
        ic::project_adopt(&self.sock(), run_id).map_err(|e| e.message)
    }

    /// Set the project's standing permissions (filesystem, network, approval behaviour). The broker
    /// produces the exact consent text for these choices; THIS process shows it in a native dialog and
    /// only a "yes" returns its digest to the broker. The renderer supplies the choices and nothing else:
    /// it cannot confirm, cannot name a digest, and a refusal (a capability this build lacks) is raised
    /// before any dialog.
    #[allow(clippy::too_many_arguments)]
    pub fn project_set_grant(
        &self,
        d: &dyn Dialogs,
        id: &str,
        fs: &str,
        net: &str,
        approval: &str,
        expires_in_secs: Option<u64>,
        dest: &ic::NetChoice,
    ) -> Result<serde_json::Value, String> {
        self.apply_draft(
            d,
            id,
            &GrantDraft {
                fs: fs.to_owned(),
                net: net.to_owned(),
                approval: approval.to_owned(),
                expires_in_secs,
                checkpoint: "best-effort".into(),
                hard_links: "protect".into(),
                dest: dest.clone(),
            },
        )
    }

    /// The one place a grant change reaches the broker: preview -> the broker's exact text in a NATIVE
    /// dialog -> only a "yes" returns that text's digest.
    fn apply_draft(
        &self,
        d: &dyn Dialogs,
        id: &str,
        g: &GrantDraft,
    ) -> Result<serde_json::Value, String> {
        let sock = self.sock();
        let exec = Some((g.checkpoint.as_str(), g.hard_links.as_str()));
        let pv = ic::project_grant_preview_net(
            &sock,
            id,
            &g.fs,
            &g.net,
            &g.approval,
            g.expires_in_secs,
            exec,
            &g.dest,
        )
        .map_err(|e| e.message)?;
        let text = pv["text"]
            .as_str()
            .ok_or("the broker returned no text")?
            .to_owned();
        let digest = pv["textSha256"]
            .as_str()
            .ok_or("the broker returned no digest")?
            .to_owned();
        if !d.confirm("Change this project's permissions", &text)? {
            return Err("cancelled".into());
        }
        ic::project_grant_set_net(
            &sock,
            id,
            &g.fs,
            &g.net,
            &g.approval,
            g.expires_in_secs,
            &digest,
            "desktop",
            exec,
            &g.dest,
        )
        .map_err(|e| e.message)
    }

    /// What the broker says about one project: whether it edits its real folder, and its grant.
    fn project_facts(&self, id: &str) -> Result<(bool, Option<serde_json::Value>), String> {
        let l = ic::project_list(&self.sock(), false).map_err(|e| e.message)?;
        let p = l["projects"]
            .as_array()
            .and_then(|a| a.iter().find(|p| p["projectId"] == id))
            .ok_or_else(|| "no such project".to_owned())?;
        Ok((
            p["workspaceMode"] == "direct",
            p.get("grant").filter(|g| !g.is_null()).cloned(),
        ))
    }

    /// The Desktop's "edit the permissions" command: like [`Self::project_set_grant`], but what the panel
    /// does not offer is KEPT from the active permissions instead of silently reset (recovery
    /// checkpoints, hard-link policy, Git writes, and - unless the caller names them - preview ports).
    /// Nothing is widened by keeping: the dialog shows the complete result either way.
    #[allow(clippy::too_many_arguments)]
    pub fn project_set_grant_keeping(
        &self,
        d: &dyn Dialogs,
        id: &str,
        fs: &str,
        net: &str,
        approval: &str,
        expires_in_secs: Option<u64>,
        dest: &ic::NetChoice,
        dev_ports: Option<Vec<u16>>,
    ) -> Result<serde_json::Value, String> {
        let (direct, grant) = self.project_facts(id)?;
        let active = grant
            .as_ref()
            .filter(|g| g["status"] == "active")
            .and_then(|g| GrantDraft::from_view(g).ok());
        let mut draft = GrantDraft {
            fs: fs.to_owned(),
            net: net.to_owned(),
            approval: approval.to_owned(),
            expires_in_secs,
            checkpoint: active
                .as_ref()
                .map_or("best-effort".into(), |a| a.checkpoint.clone()),
            hard_links: active
                .as_ref()
                .map_or("protect".into(), |a| a.hard_links.clone()),
            dest: dest.clone(),
        };
        draft.dest.git_write = active.as_ref().is_some_and(|a| a.dest.git_write);
        let ports = dev_ports.unwrap_or_else(|| {
            active
                .as_ref()
                .map(|a| a.dest.dev_ports.clone())
                .unwrap_or_default()
        });
        // previews run commands in the project's own folder; without that there is nothing to keep
        draft.dest.dev_ports = if fs == "workspace" && direct {
            normalized_ports(&ports)
        } else {
            vec![]
        };
        self.apply_draft(d, id, &draft)
    }

    /// "Allow local development previews": add ports to the project's ACTIVE permissions and nothing else.
    /// The renderer names ports (numbers); the broker's own consent text lists them and a native "yes" is
    /// the only thing that stores them. A model can never reach this.
    pub fn project_allow_previews(
        &self,
        d: &dyn Dialogs,
        id: &str,
        ports: &[u16],
    ) -> Result<serde_json::Value, String> {
        if ports.is_empty() || ports.len() > 8 {
            return Err("choose between one and eight ports".into());
        }
        if let Some(p) = ports.iter().find(|p| **p < 1024) {
            return Err(format!(
                "port {p} is reserved; development servers use ports 1024 and above"
            ));
        }
        let (direct, grant) = self.project_facts(id)?;
        let Some(g) = grant else {
            return Err("no-grant: allow Nexus to work in this project first".into());
        };
        let mut draft = GrantDraft::from_view(&g)?;
        if draft.fs != "workspace" || !direct {
            return Err("not-available: previews run in the project folder itself; allow Nexus to work in this project first".into());
        }
        let mut all = draft.dest.dev_ports.clone();
        all.extend_from_slice(ports);
        draft.dest.dev_ports = normalized_ports(&all);
        self.apply_draft(d, id, &draft)
    }

    /// Stop previews on some ports (narrowing; still confirmed so the person sees the result).
    pub fn project_revoke_previews(
        &self,
        d: &dyn Dialogs,
        id: &str,
    ) -> Result<serde_json::Value, String> {
        let (_, grant) = self.project_facts(id)?;
        let Some(g) = grant else {
            return Err("this project has no permissions".into());
        };
        let mut draft = GrantDraft::from_view(&g)?;
        draft.dest.dev_ports.clear();
        self.apply_draft(d, id, &draft)
    }

    /// "Allow dependency downloads" on a project that has standing permissions: network for dependency
    /// installs only (`install`), or back to offline. Controlled/Full network is left to the advanced
    /// editor: an exact destination list is never silently replaced.
    pub fn project_allow_installs(
        &self,
        d: &dyn Dialogs,
        id: &str,
        allow: bool,
    ) -> Result<serde_json::Value, String> {
        let (_, grant) = self.project_facts(id)?;
        let Some(g) = grant else {
            return Err("no-grant: allow Nexus to work in this project first".into());
        };
        let mut draft = GrantDraft::from_view(&g)?;
        match (draft.net.as_str(), allow) {
            ("offline", true) => draft.net = "install".into(),
            ("install", false) => draft.net = "offline".into(),
            ("install", true) | ("offline", false) => {
                return Err("nothing to change: that is already the setting".into())
            }
            _ => {
                return Err("not-available: this project already has specific network destinations; change them in Advanced permissions".into())
            }
        }
        self.apply_draft(d, id, &draft)
    }

    /// "Allow Nexus to edit this project": the project edits its real folder (native confirmation) and its
    /// commands run there, confined (the broker's consent text, native confirmation). Network stays off,
    /// approval automatic inside the permissions, no end date unless the person already had one.
    /// An existing active permission set is KEPT and only its filesystem scope is raised to the project
    /// folder; Full Access is never chosen here.
    pub fn project_allow_work(
        &self,
        d: &dyn Dialogs,
        id: &str,
    ) -> Result<serde_json::Value, String> {
        let (direct, grant) = self.project_facts(id)?;
        if !direct {
            if !d.confirm(DIRECT_TITLE, DIRECT_TEXT)? {
                return Err("cancelled".into());
            }
            ic::project_set_workspace(&self.sock(), id, "direct").map_err(|e| e.message)?;
        }
        let existing = grant
            .as_ref()
            .filter(|g| g["status"] == "active")
            .map(GrantDraft::from_view)
            .transpose()?;
        let draft = match existing {
            Some(g) if g.fs == "workspace" => return self.project_view(id),
            Some(mut g) if g.fs == "scratch" => {
                g.fs = "workspace".into();
                g
            }
            Some(_) => {
                return Err("not-available: this project has Full Access; reduce it in Advanced permissions".into())
            }
            None => GrantDraft {
                fs: "workspace".into(),
                net: "offline".into(),
                approval: "auto".into(),
                expires_in_secs: None,
                checkpoint: "best-effort".into(),
                hard_links: "protect".into(),
                dest: ic::NetChoice::default(),
            },
        };
        self.apply_draft(d, id, &draft)?;
        self.project_view(id)
    }

    fn project_view(&self, id: &str) -> Result<serde_json::Value, String> {
        let l = ic::project_list(&self.sock(), false).map_err(|e| e.message)?;
        l["projects"]
            .as_array()
            .and_then(|a| a.iter().find(|p| p["projectId"] == id))
            .cloned()
            .map(|p| serde_json::json!({ "project": p }))
            .ok_or_else(|| "no such project".to_owned())
    }

    /// Dependency installs / automatic apply of an ISOLATED project's finished work. Turning either ON
    /// widens what Nexus may do without asking again, so it needs the person's native "yes"; turning it off
    /// does not.
    pub fn project_set_policy(
        &self,
        d: &dyn Dialogs,
        id: &str,
        installs: Option<bool>,
        trusted: Option<bool>,
    ) -> Result<serde_json::Value, String> {
        if installs == Some(true)
            && !d.confirm(
                "Allow dependency downloads?",
                "Nexus may download this project's dependencies (for example npm install or pip install) inside its sandbox. Only install commands get network access; everything else keeps running without it. Nexus does not choose where packages come from beyond what your project's own files say.",
            )?
        {
            return Err("cancelled".into());
        }
        if trusted == Some(true)
            && !d.confirm(
                "Apply finished work automatically?",
                "When a task finishes and its checks pass, Nexus will apply the change to your project folder by itself: all of it or none of it, and only if your folder did not change meanwhile. Nothing is committed or pushed.",
            )?
        {
            return Err("cancelled".into());
        }
        ic::project_policy(&self.sock(), id, installs, trusted).map_err(|e| e.message)
    }

    /// Where a running development server can be seen, resolved by the BROKER from its own job record
    /// (never from an address the renderer supplies), then opened in the default browser.
    pub fn preview_open(
        &self,
        d: &dyn Dialogs,
        job_id: &str,
        port: u16,
    ) -> Result<String, String> {
        let st = ic::job_status(&self.sock(), job_id).map_err(|e| e.message)?;
        if st["state"] != "running" {
            return Err("this server is not running any more".into());
        }
        let host_port = st["exposed"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["port"] == port))
            .and_then(|x| x["hostPort"].as_u64())
            .ok_or("that preview is not published")?;
        let url = format!("http://127.0.0.1:{host_port}");
        d.open_url(&url)?;
        Ok(url)
    }

    /// Guarded recovery of what one command changed in the project folder. The renderer names an
    /// execution and the digest of the preview it showed the person; THIS process re-previews, refuses if
    /// the files moved since, shows the exact outcome in a native dialog and only a "yes" applies it.
    pub fn restore_apply(
        &self,
        d: &dyn Dialogs,
        execution_id: &str,
        reviewed_digest: &str,
    ) -> Result<serde_json::Value, String> {
        let sock = self.sock();
        let pv = ic::exec_restore_preview(&sock, execution_id).map_err(|e| e.message)?;
        let r = &pv["restore"];
        if let Some(why) = r["refused"].as_str() {
            return Err(format!("refused: {why}"));
        }
        let digest = pv["confirmDigest"].as_str().ok_or("no confirmation digest")?;
        if digest != reviewed_digest {
            return Err("changed: the files changed since you reviewed this recovery; review it again".into());
        }
        let list = |k: &str| -> Vec<String> {
            r[k].as_array()
                .map(|a| a.iter().filter_map(|i| i["path"].as_str().map(str::to_owned)).collect())
                .unwrap_or_default()
        };
        let part = |title: &str, k: &str| -> String {
            let l = list(k);
            if l.is_empty() {
                return String::new();
            }
            let shown: Vec<String> = l.iter().take(15).map(|p| format!("  {p}")).collect();
            let more = if l.len() > 15 { format!("\n  … and {} more", l.len() - 15) } else { String::new() };
            format!("\n{title} ({}):\n{}{more}\n", l.len(), shown.join("\n"))
        };
        let text = format!(
            "Put these files back the way they were before the command ran?\n{}{}{}{}\nFiles you or anything else changed afterwards are left exactly as they are. This is not atomic and cannot recover anything Nexus did not observe (changes outside the project folder, or in dependency folders).",
            part("Will be restored", "restored"),
            part("Left alone (already as they were)", "skipped"),
            part("Left alone (changed since - in conflict)", "conflicted"),
            part("Cannot be recovered", "unrecoverable"),
        );
        if !d.confirm("Restore files changed by a command", &text)? {
            return Err("cancelled".into());
        }
        ic::exec_restore_apply(&sock, execution_id, digest, "desktop").map_err(|e| e.message)
    }

    /// What one command changed, trimmed for display (no per-file hashes, no grant internals).
    pub fn exec_effects_view(&self, execution_id: &str) -> Result<serde_json::Value, String> {
        let mut v = ic::exec_effects(&self.sock(), execution_id).map_err(|e| e.message)?;
        if let Some(rec) = v.get_mut("effects").and_then(|e| e.as_object_mut()) {
            for k in ["postState", "grant", "timingMs", "pre", "post"] {
                rec.remove(k);
            }
            if let Some(fx) = rec.get_mut("effects").and_then(|e| e.as_object_mut()) {
                fx.remove("postSha256");
            }
        }
        Ok(v)
    }

    /// Revoke (`clear == false`) or remove (`clear == true`) the project's standing permissions after a
    /// native confirmation.
    pub fn project_end_grant(
        &self,
        d: &dyn Dialogs,
        id: &str,
        clear: bool,
    ) -> Result<serde_json::Value, String> {
        let (title, text) = if clear {
            (
                "Remove this project's permissions",
                "The project returns to the defaults (commands run on a throw-away copy, no network, automatic approval). Tasks that are running under the removed permissions stop being allowed to act.",
            )
        } else {
            (
                "Revoke this project's permissions",
                "New tasks are refused until you grant permissions again, and tasks that are running stop being allowed to act. Nothing already applied is undone.",
            )
        };
        if !d.confirm(title, text)? {
            return Err("cancelled".into());
        }
        if clear {
            ic::project_grant_clear(&self.sock(), id, "desktop")
        } else {
            ic::project_grant_revoke(&self.sock(), id, "desktop")
        }
        .map_err(|e| e.message)
    }

    pub fn project_forget(&self, d: &dyn Dialogs, id: &str) -> Result<serde_json::Value, String> {
        if !d.confirm("Remove project from Nexus", "Nexus will forget this project and delete its private snapshot. Your own folder is not touched.")? {
            return Err("cancelled".into());
        }
        ic::project_forget(&self.sock(), id).map_err(|e| e.message)
    }
}

/// A complete permission set to be previewed, confirmed and stored.
#[derive(Debug, Clone)]
pub struct GrantDraft {
    pub fs: String,
    pub net: String,
    pub approval: String,
    pub expires_in_secs: Option<u64>,
    pub checkpoint: String,
    pub hard_links: String,
    pub dest: ic::NetChoice,
}

impl GrantDraft {
    /// The broker's description of an ACTIVE grant, ready to be amended. The remaining lifetime is kept
    /// (never extended); an ended grant is not amended - the person sets permissions up again.
    pub fn from_view(g: &serde_json::Value) -> Result<GrantDraft, String> {
        if g["status"] != "active" {
            return Err("ended: these permissions were revoked or have expired; set them up again first".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let s = |k: &str, d: &str| g[k].as_str().unwrap_or(d).to_owned();
        let ports = |v: &serde_json::Value| -> Vec<u16> {
            v.as_array()
                .map(|a| a.iter().filter_map(|x| x.as_u64().and_then(|n| u16::try_from(n).ok())).collect())
                .unwrap_or_default()
        };
        let hosts = g["netPolicy"]["hosts"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|h| {
                        let host = h["host"].as_str()?;
                        let p = ports(&h["ports"]);
                        Some(if p.is_empty() {
                            host.to_owned()
                        } else {
                            format!("{host}:{}", p.iter().map(u16::to_string).collect::<Vec<_>>().join(","))
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(GrantDraft {
            fs: s("fs", "scratch"),
            net: s("net", "offline"),
            approval: s("approval", "auto"),
            expires_in_secs: g["expiresAtMs"]
                .as_i64()
                .map(|e| ((e - now) / 1000).max(1) as u64),
            checkpoint: s("checkpoint", "best-effort"),
            hard_links: s("hardLinks", "protect"),
            dest: ic::NetChoice {
                presets: vec![],
                hosts,
                local_ports: ports(&g["netPolicy"]["local_ports"]),
                git_write: g["gitWrite"] == true,
                dev_ports: ports(&g["devPorts"]),
            },
        })
    }
}

/// Sorted, de-duplicated, valid.
pub fn normalized_ports(p: &[u16]) -> Vec<u16> {
    let mut v: Vec<u16> = p.iter().copied().filter(|p| *p > 0).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// What this computer offers the application, for first-run guidance. Read-only, and it names only what
/// is found (a program name or "none"), never a path outside what the person's own PATH already is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    pub platform: &'static str,
    /// `kdialog` | `zenity` | none: without one, the system dialogs Nexus needs cannot be shown.
    pub dialog_tool: Option<&'static str>,
    /// Opens a preview in the default browser.
    pub opener: Option<&'static str>,
    /// Programs a project's own build and test commands commonly need, and whether they were found.
    pub toolchains: Vec<(&'static str, bool)>,
}

pub fn environment_check() -> EnvCheck {
    let which = |name: &str| {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
            .unwrap_or(false)
    };
    EnvCheck {
        platform: std::env::consts::OS,
        dialog_tool: ["kdialog", "zenity"].into_iter().find(|n| which(n)),
        opener: ["xdg-open"].into_iter().find(|n| which(n)),
        toolchains: ["git", "node", "npm", "python3", "cargo"]
            .into_iter()
            .map(|n| (n, which(n)))
            .collect(),
    }
}

const DIRECT_TITLE: &str = "Let Nexus edit this folder directly?";
const DIRECT_TEXT: &str = "Yes: Nexus reads, creates, changes and deletes files in this project folder itself. Each change is on disk as soon as it is made, your editor and terminal see it at once, and there is no patch to apply afterwards. Nexus still cannot leave the folder, touch secrets or .git, or overwrite a file you changed since it read it, and it keeps the original of every file it changes.\n\nNo: Nexus works in a throw-away copy and you review and apply its patch yourself.\n\nYou can change this later in the project's settings; it applies to new tasks only.";

/// The Desktop's coding submission: text + project identity only. The limits are the
/// broker's (never the renderer's). Shared by the Tauri command and the acceptance runner
/// so both exercise the same code.
pub fn code_submit(
    prompt: String,
    source_id: String,
    idempotency_key: String,
) -> Result<ic::SubmitReply, String> {
    use nexus_client::intent_contract::{NexusIntentV1, ResponseMode};
    let sock = ic::default_broker_socket();
    let limits = ic::code_config(&sock)
        .map_err(|e| e.message)?
        .limits
        .to_intent_limits();
    let intent = NexusIntentV1 {
        schema_version: 1,
        request_id: ic::fresh_key("gui"),
        idempotency_key,
        intent_type: "repo-code".to_owned(),
        content: prompt,
        model: None,
        workspace_id: Some(source_id),
        limits,
        response_mode: ResponseMode::Stream,
        client_label: Some("nexus-desktop".to_owned()),
    };
    ic::submit(&sock, &intent).map_err(|e| e.message)
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}
