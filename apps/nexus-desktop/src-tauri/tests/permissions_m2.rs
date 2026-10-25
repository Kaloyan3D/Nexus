//! Standing permissions through the Desktop's native backend: the broker produces the exact consent text,
//! THIS process shows it and only a "yes" lets its digest reach the broker. A fake broker records the wire.

use nexus_desktop_lib::dialogs::Dialogs;
use nexus_desktop_lib::interactive::Runtime;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};

struct Counting {
    answer: bool,
    shown: Mutex<Vec<(String, String)>>,
}
impl Dialogs for Counting {
    fn pick_folder(&self, _t: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn confirm(&self, title: &str, text: &str) -> Result<bool, String> {
        self.shown.lock().unwrap().push((title.into(), text.into()));
        Ok(self.answer)
    }
    fn secret(&self, _t: &str, _p: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// `NEXUS_BROKER_SOCKET` is process-global: the two tests run one after the other.
static LOCK: Mutex<()> = Mutex::new(());

fn fake_broker(sock: &std::path::Path, frames: Arc<Mutex<Vec<Value>>>, refuse_preview: bool) {
    let l = UnixListener::bind(sock).unwrap();
    std::thread::spawn(move || {
        for stream in l.incoming() {
            let Ok(mut s) = stream else { break };
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            frames.lock().unwrap().push(v.clone());
            let id = v["id"].clone();
            let reply = match v["cmd"].as_str().unwrap_or("") {
                "project-grant-preview" if refuse_preview => {
                    json!({"protocol":1,"id":id,"ok":false,"code":"bad-request","message":"Full Access is not available in this build"})
                }
                "project-grant-preview" => {
                    json!({"protocol":1,"id":id,"ok":true,"result":{"text":"EXACT TEXT FROM THE BROKER","textSha256":"f".repeat(64)}})
                }
                _ => json!({"protocol":1,"id":id,"ok":true,"result":{"project":{"projectId":"p"}}}),
            };
            let _ = writeln!(s, "{reply}");
        }
    });
}

#[test]
fn the_native_backend_shows_the_brokers_text_and_only_a_yes_reaches_the_broker() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = std::env::temp_dir().join(format!("nexus-perm-m2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("broker.sock");
    let _ = std::fs::remove_file(&sock);
    let frames = Arc::new(Mutex::new(Vec::new()));
    fake_broker(&sock, frames.clone(), false);
    std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
    let rt = Runtime::new();

    // "no": the text was shown, nothing was stored
    let no = Counting {
        answer: false,
        shown: Mutex::new(vec![]),
    };
    let r = rt.project_set_grant(&no, "p", "workspace", "install", "ask", Some(3600));
    assert_eq!(r.unwrap_err(), "cancelled");
    assert_eq!(no.shown.lock().unwrap()[0].1, "EXACT TEXT FROM THE BROKER");
    assert!(
        frames
            .lock()
            .unwrap()
            .iter()
            .all(|f| f["cmd"] != "project-grant"),
        "a declined dialog stored a grant"
    );

    // "yes": the digest of the text that was shown, the user's choices and the surface go through
    let yes = Counting {
        answer: true,
        shown: Mutex::new(vec![]),
    };
    rt.project_set_grant(&yes, "p", "workspace", "install", "ask", Some(3600))
        .unwrap();
    let f = frames
        .lock()
        .unwrap()
        .iter()
        .find(|f| f["cmd"] == "project-grant")
        .cloned()
        .expect("grant frame");
    assert_eq!(f["params"]["textSha256"], "f".repeat(64));
    assert_eq!(f["params"]["surface"], "desktop");
    assert_eq!(f["params"]["fs"], "workspace");
    assert_eq!(f["params"]["approval"], "ask");
    assert_eq!(f["params"]["expiresInSecs"], 3600);

    // revoke / clear need the confirmation too
    let no2 = Counting {
        answer: false,
        shown: Mutex::new(vec![]),
    };
    assert_eq!(
        rt.project_end_grant(&no2, "p", false).unwrap_err(),
        "cancelled"
    );
    assert_eq!(
        rt.project_end_grant(&no2, "p", true).unwrap_err(),
        "cancelled"
    );
    assert!(frames
        .lock()
        .unwrap()
        .iter()
        .all(|f| f["cmd"] != "project-grant-revoke" && f["cmd"] != "project-grant-clear"));
    rt.project_end_grant(&yes, "p", false).unwrap();
    rt.project_end_grant(&yes, "p", true).unwrap();
    let cmds: Vec<String> = frames
        .lock()
        .unwrap()
        .iter()
        .map(|f| f["cmd"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        cmds.contains(&"project-grant-revoke".to_owned())
            && cmds.contains(&"project-grant-clear".to_owned()),
        "{cmds:?}"
    );
}

#[test]
fn a_choice_the_build_cannot_provide_is_refused_before_any_dialog_is_shown() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = std::env::temp_dir().join(format!("nexus-perm-m2b-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("broker.sock");
    let _ = std::fs::remove_file(&sock);
    let frames = Arc::new(Mutex::new(Vec::new()));
    fake_broker(&sock, frames.clone(), true);
    std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
    let rt = Runtime::new();
    let d = Counting {
        answer: true,
        shown: Mutex::new(vec![]),
    };
    let e = rt
        .project_set_grant(&d, "p", "full", "full", "auto", None)
        .unwrap_err();
    assert!(e.contains("not available"), "{e}");
    assert!(
        d.shown.lock().unwrap().is_empty(),
        "a dialog was shown for a choice that cannot be stored"
    );
    assert!(frames
        .lock()
        .unwrap()
        .iter()
        .all(|f| f["cmd"] != "project-grant"));
}
