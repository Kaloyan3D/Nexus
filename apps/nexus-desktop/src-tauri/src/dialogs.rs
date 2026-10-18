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
}

/// A scripted answer set for automated runs. Using it is a fact the caller records:
/// a scripted person is not a person.
#[derive(Default, Clone)]
pub struct ScriptedDialogs {
    pub folders: Arc<std::sync::Mutex<Vec<String>>>,
    pub confirm: bool,
    pub secret: Option<String>,
}

impl Dialogs for ScriptedDialogs {
    fn pick_folder(&self, _title: &str) -> Result<Option<String>, String> {
        Ok(self
            .folders
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .pop())
    }
    fn confirm(&self, _title: &str, _text: &str) -> Result<bool, String> {
        Ok(self.confirm)
    }
    fn secret(&self, _title: &str, _prompt: &str) -> Result<Option<String>, String> {
        Ok(self.secret.clone())
    }
}
