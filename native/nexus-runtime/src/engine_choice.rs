//! Phase 2: which ENGINE new coding tasks use, decided in ONE place for the CLI and the Desktop.
//!
//! * The operator preference lives in `<home>/preferences.json` (private, versioned). It defaults to
//!   **adaptive** (Nexus Adaptive is the recommended engine); `stable` keeps the historical `muse-v0`.
//! * "Adaptive" is turned into an explicit, Registry-checkable selection: the operator's SAVED adaptive
//!   ModeConfiguration names the model and route; the broker's Registry target list must show that route
//!   issuable. Nothing is invented, no credential or verification status is fabricated.
//! * It NEVER falls back: if adaptive is chosen and not usable, the caller gets a precise, actionable
//!   error. Choosing `stable` is always an explicit act. A conversation that already exists keeps the
//!   engine it started with (the broker binds it); this module only chooses for NEW tasks.
//!
//! The selection returned here is a request: the broker and the Registry re-validate everything
//! (closed mode-to-engine table, contract, route verification, sealed budget).

use crate::Home;
use nexus_client::intent_client::RegistryTarget;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::OpenOptionsExt;

pub const ADAPTIVE_MODE_ID: &str = "engineering-v2-adaptive";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Adaptive,
    Stable,
}

impl Engine {
    pub fn parse(s: &str) -> Option<Engine> {
        match s {
            "adaptive" => Some(Engine::Adaptive),
            "stable" => Some(Engine::Stable),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Adaptive => "adaptive",
            Engine::Stable => "stable",
        }
    }
}

/// The identities a client sends (never a path, key or limit).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub provider_id: String,
    pub remote_model_id: String,
    pub logical_model_id: String,
    pub route_id: String,
    pub mode_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> ChoiceError {
    ChoiceError {
        code,
        message: message.into(),
    }
}

fn prefs_path(home: &Home) -> std::path::PathBuf {
    home.root.join("preferences.json")
}

/// The operator's preferred engine for NEW tasks. A missing, unreadable or unknown file means the
/// default (adaptive); a file that is not private to the user is ignored (default).
pub fn preferred(home: &Home) -> Engine {
    use std::os::unix::fs::MetadataExt;
    let p = prefs_path(home);
    let ok = std::fs::symlink_metadata(&p)
        .map(|m| m.is_file() && m.mode() & 0o077 == 0)
        .unwrap_or(false);
    if !ok {
        return Engine::Adaptive;
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v.get("engine")
                .and_then(|e| e.as_str())
                .and_then(Engine::parse)
        })
        .unwrap_or(Engine::Adaptive)
}

/// Persist the preference (private file, atomic replace).
pub fn set_preferred(home: &Home, engine: Engine) -> Result<(), ChoiceError> {
    use std::io::Write;
    let p = prefs_path(home);
    let tmp = home
        .root
        .join(format!(".preferences.{}.tmp", std::process::id()));
    let body = serde_json::json!({ "schema": 1, "engine": engine.as_str() }).to_string();
    let r = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, &p)
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| {
        err(
            "preference-unwritable",
            format!("the engine preference could not be saved ({})", e.kind()),
        )
    })
}

/// The saved adaptive ModeConfiguration's model and route (read-only), if the operator saved one.
pub fn saved_adaptive(home: &Home) -> Option<(String, String)> {
    let p = home
        .registry_data()
        .join("registry/mode-configurations.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    let main = v.pointer("/modes/engineering-v2-adaptive/config/slots/main")?;
    Some((
        main.get("logicalModelId")?.as_str()?.to_owned(),
        main.get("routeId")?.as_str()?.to_owned(),
    ))
}

/// Turn "adaptive" into the explicit selection, or say precisely why that is not possible.
pub fn adaptive_selection(
    home: &Home,
    targets: &[RegistryTarget],
) -> Result<Selection, ChoiceError> {
    let Some((logical, route)) = saved_adaptive(home) else {
        return Err(err(
            "adaptive-not-configured",
            "Nexus Adaptive is not set up yet: no adaptive configuration has been saved. Run the one-time adaptive setup (Settings → Nexus Adaptive, or `nexus engine setup`), or choose Stable explicitly.",
        ));
    };
    let Some(t) = targets
        .iter()
        .find(|t| t.route_id == route && t.logical_model_id == logical)
    else {
        return Err(err(
            "adaptive-route-missing",
            format!("the saved adaptive configuration names a route that the Registry no longer lists ({route}). Re-run the adaptive setup, or choose Stable explicitly."),
        ));
    };
    if !t.issuable {
        return Err(err(
            "adaptive-route-not-issuable",
            format!(
                "the adaptive route is not usable right now ({}). Re-run the adaptive setup to verify it again, or choose Stable explicitly.",
                t.reason.as_deref().unwrap_or("not issuable")
            ),
        ));
    }
    Ok(Selection {
        provider_id: t.provider_id.clone(),
        remote_model_id: t.remote_model_id.clone(),
        logical_model_id: t.logical_model_id.clone(),
        route_id: t.route_id.clone(),
        mode_id: ADAPTIVE_MODE_ID.to_owned(),
    })
}

/// What the user interface shows: the preference and whether each engine can be used now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceView {
    pub preferred: Engine,
    pub adaptive_available: bool,
    pub adaptive_reason: Option<String>,
    pub adaptive_model: Option<String>,
    pub adaptive_route: Option<String>,
    /// The engine a NEW task would use right now (never silently the other one).
    pub effective: Option<Engine>,
}

pub fn view(home: &Home, targets: &[RegistryTarget]) -> ChoiceView {
    let preferred = preferred(home);
    let sel = adaptive_selection(home, targets);
    let (available, reason) = match &sel {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e.message.clone())),
    };
    let saved = saved_adaptive(home);
    ChoiceView {
        preferred,
        adaptive_available: available,
        adaptive_reason: reason,
        adaptive_model: saved.as_ref().map(|s| s.0.clone()),
        adaptive_route: saved.map(|s| s.1),
        effective: match preferred {
            Engine::Stable => Some(Engine::Stable),
            Engine::Adaptive if available => Some(Engine::Adaptive),
            Engine::Adaptive => None,
        },
    }
}

/// The selection for a NEW task: `Ok(None)` = the default mode with no selection (stable, byte for byte
/// the request every earlier version sent); `Ok(Some(..))` = adaptive; `Err` = adaptive chosen but unusable.
pub fn selection_for(
    home: &Home,
    requested: Option<Engine>,
    targets: &[RegistryTarget],
) -> Result<Option<Selection>, ChoiceError> {
    match requested.unwrap_or_else(|| preferred(home)) {
        Engine::Stable => Ok(None),
        Engine::Adaptive => adaptive_selection(home, targets).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> (tempfile::TempDir, Home) {
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(
            d.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let h = Home {
            root: d.path().to_path_buf(),
        };
        crate::bootstrap(&h).unwrap();
        (d, h)
    }

    fn save_adaptive(h: &Home, logical: &str, route: &str) {
        let dir = h.registry_data().join("registry");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("mode-configurations.json"),
            serde_json::json!({"schemaVersion":1,"modes":{"engineering-v2-adaptive":{"revision":0,"config":{"slots":{"main":{"logicalModelId":logical,"routeId":route}}}}}}).to_string(),
        )
        .unwrap();
    }

    fn target(route: &str, logical: &str, issuable: bool) -> RegistryTarget {
        RegistryTarget {
            provider_id: "opencode-go-native".into(),
            logical_model_id: logical.into(),
            remote_model_id: "muse-spark-1.3-contributor".into(),
            route_id: route.into(),
            connection_id: Some("conn".into()),
            connection_status: "connected".into(),
            protocol: "openai-responses".into(),
            context_limit_tokens: 1,
            output_limit_tokens: 1,
            billing_tier: String::new(),
            data_use: None,
            issuable,
            reason: if issuable {
                None
            } else {
                Some("route-not-verified".into())
            },
        }
    }

    #[test]
    fn the_default_preference_is_adaptive_and_stable_is_an_explicit_choice() {
        let (_d, h) = home();
        assert_eq!(preferred(&h), Engine::Adaptive);
        set_preferred(&h, Engine::Stable).unwrap();
        assert_eq!(preferred(&h), Engine::Stable);
        let p = prefs_path(&h);
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(&p).unwrap().mode() & 0o777, 0o600);
        // a loose file is ignored, an unknown value is the default: no way to smuggle an engine in
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
        assert_eq!(preferred(&h), Engine::Adaptive);
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        std::fs::write(&p, r#"{"engine":"muse-v1"}"#).unwrap();
        assert_eq!(preferred(&h), Engine::Adaptive);
    }

    #[test]
    fn adaptive_becomes_an_explicit_selection_only_from_a_saved_configuration_and_an_issuable_route(
    ) {
        let (_d, h) = home();
        let ts = [target("r/adaptive", "m/adaptive", true)];
        // nothing saved: a precise setup requirement, never a fallback
        let e = selection_for(&h, None, &ts).unwrap_err();
        assert_eq!(e.code, "adaptive-not-configured");
        assert!(e.message.contains("choose Stable explicitly"));
        save_adaptive(&h, "m/adaptive", "r/adaptive");
        let s = selection_for(&h, None, &ts).unwrap().unwrap();
        assert_eq!(
            (
                s.mode_id.as_str(),
                s.route_id.as_str(),
                s.logical_model_id.as_str(),
                s.remote_model_id.as_str()
            ),
            (
                "engineering-v2-adaptive",
                "r/adaptive",
                "m/adaptive",
                "muse-spark-1.3-contributor"
            )
        );
        // the route vanished / is not issuable: explicit error
        assert_eq!(
            selection_for(&h, None, &[]).unwrap_err().code,
            "adaptive-route-missing"
        );
        let bad = [target("r/adaptive", "m/adaptive", false)];
        let e = selection_for(&h, None, &bad).unwrap_err();
        assert_eq!(e.code, "adaptive-route-not-issuable");
        assert!(e.message.contains("route-not-verified"));
        // another route with the same logical model is NOT substituted
        let other = [target("r/other", "m/adaptive", true)];
        assert_eq!(
            selection_for(&h, None, &other).unwrap_err().code,
            "adaptive-route-missing"
        );
    }

    #[test]
    fn stable_sends_no_selection_at_all_and_the_view_never_hides_an_unusable_adaptive() {
        let (_d, h) = home();
        assert_eq!(selection_for(&h, Some(Engine::Stable), &[]).unwrap(), None);
        set_preferred(&h, Engine::Stable).unwrap();
        assert_eq!(
            selection_for(&h, None, &[]).unwrap(),
            None,
            "the preference chooses the default mode"
        );
        let v = view(&h, &[]);
        assert_eq!(
            (v.preferred, v.effective, v.adaptive_available),
            (Engine::Stable, Some(Engine::Stable), false)
        );
        set_preferred(&h, Engine::Adaptive).unwrap();
        let v = view(&h, &[]);
        assert_eq!(
            v.effective, None,
            "adaptive preferred but not usable: no engine is silently substituted"
        );
        assert!(v.adaptive_reason.unwrap().contains("not set up"));
        // an explicit request overrides the preference in both directions
        assert!(selection_for(&h, Some(Engine::Adaptive), &[]).is_err());
    }
}
