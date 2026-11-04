//! Where the macOS app finds its Linux engine. Absent file = no engine configured = the safe
//! `NoEngine` fallback; nothing is attempted.
//!
//! `engine.json` in the app's config folder:
//! `{"host": "192.168.64.2", "user": "kaloyan", "identityFile": "~/.ssh/nexus_engine_app_ed25519"}`
//! (optional `"knownHosts"`: the pinned host-key file, default `engine_known_hosts` beside it).

use crate::bridge_link::SshTransport;
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EngineConfig {
    /// `"vm"` = the embedded engine (the default when nothing is configured and an image exists);
    /// `"ssh"` (or absent with host/user) = a Linux machine reached over SSH (development/legacy).
    pub transport: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    pub known_hosts: Option<String>,
}

fn word(s: &str, extra: &[char]) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

fn expand(p: &str, home: &Path) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

impl EngineConfig {
    pub fn parse(json: &str) -> Result<EngineConfig, String> {
        let c: EngineConfig =
            serde_json::from_str(json).map_err(|e| format!("engine.json is not valid: {e}"))?;
        if c.transport.as_deref() == Some("vm") {
            return Ok(c);
        }
        if !matches!(c.transport.as_deref(), None | Some("ssh")) {
            return Err("engine.json: `transport` must be \"vm\" or \"ssh\"".into());
        }
        // These become ssh arguments: refuse anything that could be read as an option or a
        // second host.
        if !word(&c.host, &['.', '-', ':']) {
            return Err("engine.json: `host` must be a plain host name or address".into());
        }
        if !word(&c.user, &['_', '-', '.']) {
            return Err("engine.json: `user` must be a plain account name".into());
        }
        if c.identity_file.is_empty()
            || c.identity_file.contains('\0')
            || c.known_hosts.as_deref().is_some_and(|k| k.contains('"'))
        {
            return Err("engine.json: `identityFile` is required".into());
        }
        Ok(c)
    }

    /// Whether `<dir>/engine.json` selects the embedded VM.
    pub fn wants_vm(dir: &Path) -> bool {
        std::fs::read_to_string(dir.join("engine.json"))
            .ok()
            .and_then(|t| EngineConfig::parse(&t).ok())
            .is_some_and(|c| c.transport.as_deref() == Some("vm"))
    }

    /// Read `<dir>/engine.json` as an SSH engine; `Ok(None)` when there is none (or it selects the VM).
    pub fn load(dir: &Path, home: &Path) -> Result<Option<SshTransport>, String> {
        let file = dir.join("engine.json");
        let text = match std::fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("cannot read engine.json: {e}")),
        };
        let c = EngineConfig::parse(&text)?;
        if c.transport.as_deref() == Some("vm") {
            return Ok(None);
        }
        Ok(Some(SshTransport {
            identity_file: expand(&c.identity_file, home),
            known_hosts: c
                .known_hosts
                .as_deref()
                .map(|p| expand(p, home))
                .unwrap_or_else(|| dir.join("engine_known_hosts")),
            host: c.host,
            user: c.user,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rejects_option_injection() {
        let ok = r#"{"host":"192.168.64.2","user":"kaloyan","identityFile":"~/.ssh/k"}"#;
        assert!(EngineConfig::parse(ok).is_ok());
        for bad in [
            r#"{"host":"-oProxyCommand=x","user":"u","identityFile":"k"}"#,
            r#"{"host":"h","user":"-oX","identityFile":"k"}"#,
            r#"{"host":"h h","user":"u","identityFile":"k"}"#,
            r#"{"host":"h","user":"u@x","identityFile":"k"}"#,
            r#"{"host":"h","user":"u","identityFile":"k","extra":1}"#,
        ] {
            assert!(EngineConfig::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn missing_file_means_no_engine() {
        let d = tempfile::tempdir().unwrap();
        assert!(EngineConfig::load(d.path(), d.path()).unwrap().is_none());
    }

    #[test]
    fn load_resolves_home_and_default_known_hosts() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("engine.json"),
            r#"{"host":"h","user":"u","identityFile":"~/.ssh/k"}"#,
        )
        .unwrap();
        let t = EngineConfig::load(d.path(), Path::new("/Users/x"))
            .unwrap()
            .unwrap();
        assert_eq!(t.identity_file, PathBuf::from("/Users/x/.ssh/k"));
        assert_eq!(t.known_hosts, d.path().join("engine_known_hosts"));
    }

    #[test]
    fn the_embedded_engine_needs_no_ssh_settings() {
        let c = EngineConfig::parse(r#"{"transport":"vm"}"#).unwrap();
        assert_eq!(c.transport.as_deref(), Some("vm"));
        assert!(EngineConfig::parse(r#"{"transport":"carrier-pigeon"}"#).is_err());
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("engine.json"), r#"{"transport":"vm"}"#).unwrap();
        assert!(EngineConfig::wants_vm(d.path()));
        assert!(EngineConfig::load(d.path(), d.path()).unwrap().is_none());
    }
}
