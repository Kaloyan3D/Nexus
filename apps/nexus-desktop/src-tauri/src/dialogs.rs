//! Native OS dialogs (folder picker, confirmation, secret prompt).
//!
//! These are shown by the NATIVE backend, never by the renderer: a path chosen in the
//! picker, a consent answered "yes" and an API key typed into the password prompt
//! reach this process directly. Page content (and so any model-influenced text) can
//! neither synthesize the click nor read the key. Linux uses `kdialog` or `zenity`;
//! if neither exists the operation fails closed with a clear message.

use std::process::{Command, Stdio};
use std::sync::Arc;

/// The three things the backend ever asks a person. A trait so the acceptance runner
/// and tests can script them, clearly labelled as scripted.
pub trait Dialogs: Send + Sync {
    /// `Ok(None)` = the person cancelled.
    fn pick_folder(&self, title: &str) -> Result<Option<String>, String>;
    fn confirm(&self, title: &str, text: &str) -> Result<bool, String>;
    /// A secret typed by the person (never echoed, never logged).
    fn secret(&self, title: &str, prompt: &str) -> Result<Option<String>, String>;
    /// Open a local preview address in the person's default browser. The caller has already
    /// resolved the address from the broker (never from the renderer); implementations still accept
    /// nothing but `http://127.0.0.1:<port>`.
    fn open_url(&self, _url: &str) -> Result<(), String> {
        Err("this environment cannot open a browser".to_owned())
    }
}

/// `http://127.0.0.1:<port>` and nothing else: a preview is a local development server.
pub fn is_local_preview_url(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:").is_some_and(|p| {
        !p.is_empty()
            && p.len() <= 5
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n))
    })
}

pub struct SystemDialogs;

fn which(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
        .unwrap_or(false)
}

fn run(cmd: &mut Command) -> Result<(bool, String), String> {
    let o = cmd
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("cannot show a dialog: {e}"))?;
    Ok((
        o.status.success(),
        String::from_utf8_lossy(&o.stdout)
            .trim_end_matches('\n')
            .to_owned(),
    ))
}

fn no_tool() -> String {
    "no dialog tool found: install kdialog or zenity".to_owned()
}

impl Dialogs for SystemDialogs {
    fn pick_folder(&self, title: &str) -> Result<Option<String>, String> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let (ok, out) = if which("kdialog") {
            run(Command::new("kdialog").args(["--title", title, "--getexistingdirectory", &home]))?
        } else if which("zenity") {
            run(Command::new("zenity").args(["--file-selection", "--directory", "--title", title]))?
        } else {
            return Err(no_tool());
        };
        Ok((ok && !out.is_empty()).then_some(out))
    }

    fn confirm(&self, title: &str, text: &str) -> Result<bool, String> {
        let (ok, _) = if which("kdialog") {
            run(Command::new("kdialog").args([
                "--title",
                title,
                "--yesno",
                text,
                "--yes-label",
                "Allow",
                "--no-label",
                "Cancel",
            ]))?
        } else if which("zenity") {
            run(Command::new("zenity").args([
                "--question",
                "--title",
                title,
                "--text",
                text,
                "--ok-label",
                "Allow",
                "--cancel-label",
                "Cancel",
                "--width",
                "560",
            ]))?
        } else {
            return Err(no_tool());
        };
        Ok(ok)
    }

    fn secret(&self, title: &str, prompt: &str) -> Result<Option<String>, String> {
        let (ok, out) = if which("kdialog") {
            run(Command::new("kdialog").args(["--title", title, "--password", prompt]))?
        } else if which("zenity") {
            run(Command::new("zenity").args([
                "--entry",
                "--hide-text",
                "--title",
                title,
                "--text",
                prompt,
            ]))?
        } else {
            return Err(no_tool());
        };
        Ok((ok && !out.is_empty()).then_some(out))
    }

    fn open_url(&self, url: &str) -> Result<(), String> {
        if !is_local_preview_url(url) {
            return Err("only a local preview address can be opened".to_owned());
        }
        if !which("xdg-open") {
            return Err("no way to open a browser was found: install xdg-utils, or copy the address into your browser".to_owned());
        }
        Command::new("xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|mut c| {
                // do not wait for the browser, but do not leave a zombie either
                std::thread::spawn(move || {
                    let _ = c.wait();
                });
            })
            .map_err(|e| format!("cannot open the browser: {e}"))
    }
}

/// A scripted answer set for automated runs. Using it is a fact the caller records:
/// a scripted person is not a person.
#[derive(Default, Clone)]
pub struct ScriptedDialogs {
    pub folders: Arc<std::sync::Mutex<Vec<String>>>,
    pub confirm: bool,
    pub secret: Option<String>,
    /// Addresses `open_url` was asked to open (a scripted browser).
    pub opened: Arc<std::sync::Mutex<Vec<String>>>,
    /// Every confirmation shown: `(title, text)`.
    pub shown: Arc<std::sync::Mutex<Vec<(String, String)>>>,
}

impl Dialogs for ScriptedDialogs {
    fn pick_folder(&self, _title: &str) -> Result<Option<String>, String> {
        Ok(self
            .folders
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .pop())
    }
    fn confirm(&self, title: &str, text: &str) -> Result<bool, String> {
        if let Ok(mut g) = self.shown.lock() {
            g.push((title.to_owned(), text.to_owned()));
        }
        Ok(self.confirm)
    }
    fn secret(&self, _title: &str, _prompt: &str) -> Result<Option<String>, String> {
        Ok(self.secret.clone())
    }
    fn open_url(&self, url: &str) -> Result<(), String> {
        if !is_local_preview_url(url) {
            return Err("only a local preview address can be opened".to_owned());
        }
        self.opened
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .push(url.to_owned());
        Ok(())
    }
}
