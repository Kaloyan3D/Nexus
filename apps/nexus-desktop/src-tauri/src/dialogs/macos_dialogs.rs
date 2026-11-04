//! macOS dialogs: genuine `NSOpenPanel` / `NSAlert`, shown by this (trusted) process on the
//! main thread. A chosen path and a confirmation answer never pass through the renderer,
//! and choosing a folder here grants nothing: the caller decides what a path may be used for.

use super::Dialogs;
use std::sync::mpsc;
use tauri::AppHandle;

pub struct MacDialogs {
    app: AppHandle,
}

impl MacDialogs {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// AppKit panels must be driven from the main thread; the calling command thread waits.
    fn on_main<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(f());
            })
            .map_err(|e| format!("cannot show a dialog: {e}"))?;
        rx.recv()
            .map_err(|_| "the dialog was closed unexpectedly".to_owned())
    }
}

/// The button that grants. It is the second button, so the default (Return) answer is Cancel.
const ALLOW: &str = "Allow";
const CANCEL: &str = "Cancel";

impl Dialogs for MacDialogs {
    fn pick_folder(&self, title: &str) -> Result<Option<String>, String> {
        let title = title.to_owned();
        let picked = self.on_main(move || {
            let mut dialog = rfd::FileDialog::new().set_title(&title);
            if let Some(home) = std::env::var_os("HOME") {
                dialog = dialog.set_directory(home);
            }
            dialog.pick_folder()
        })?;
        match picked {
            None => Ok(None),
            Some(p) => p
                .into_os_string()
                .into_string()
                .map(Some)
                .map_err(|_| "the chosen folder's name is not valid text".to_owned()),
        }
    }

    fn confirm(&self, title: &str, text: &str) -> Result<bool, String> {
        let (title, text) = (title.to_owned(), text.to_owned());
        let answer = self.on_main(move || {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title(&title)
                .set_description(&text)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    CANCEL.to_owned(),
                    ALLOW.to_owned(),
                ))
                .show()
        })?;
        Ok(matches!(answer, rfd::MessageDialogResult::Custom(ref l) if l == ALLOW))
    }

    /// A native, non-echoing prompt (AppleScript's `display dialog ... with hidden answer`). The prompt text is
    /// passed as arguments, never spliced into the script, and the answer comes back on stdout only.
    fn secret(&self, title: &str, prompt: &str) -> Result<Option<String>, String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        const SCRIPT: &str = "on run argv\n\
            try\n\
            set r to display dialog (item 2 of argv) default answer \"\" with hidden answer with title (item 1 of argv) buttons {\"Cancel\", \"OK\"} default button \"OK\" cancel button \"Cancel\" with icon note\n\
            return text returned of r\n\
            on error number -128\n\
            return \"__cancelled__\"\n\
            end try\n\
            end run\n";
        let mut child = Command::new("/usr/bin/osascript")
            .arg("-")
            .arg(title)
            .arg(prompt)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot show a prompt: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("cannot show a prompt")?
            .write_all(SCRIPT.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout)
            .trim_end_matches('\n')
            .to_owned();
        Ok((out.status.success() && !text.is_empty() && text != "__cancelled__").then_some(text))
    }
}
