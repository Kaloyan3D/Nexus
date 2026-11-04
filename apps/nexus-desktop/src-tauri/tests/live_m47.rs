//! LIVE (M4.7): controlled experiment runs against the real engine and the person's connected provider (billable,
//! never reads credentials). Ignored by default; needs the app closed and `NEXUS_VM_HELPER`.
//!
//!   NEXUS_M47_TASK=scheduler|inventory  NEXUS_M47_REPLAY=window|append-only|none  NEXUS_M47_ENGINE=adaptive|stable
//!   NEXUS_M47_TAG=<run label>  NEXUS_M47_OUT=<dir>  NEXUS_VM_HELPER=<Nexus.app>/Contents/MacOS/nexus-vm \
//!     cargo test --test live_m47 -- --ignored --nocapture --test-threads=1 experiment_run
//!
//! Writes `<tag>.runrecord.json`, `<tag>.analytics.json`, `<tag>.meta.json` and the run's working copy under
//! `<tag>.workspace/` (exported read-only from the engine; the export is never acknowledged, so nothing is applied
//! by this harness). The hidden acceptance checks run on that copy afterwards, outside the engine.

use nexus_desktop_lib::bridge_link::BridgeLink;
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::EngineLink;
use nexus_desktop_lib::engine_config::EngineConfig;
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::*;
use nexus_desktop_lib::sync::wire::SyncReq;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SCHEDULER_TASK: &str = include_str!("fixtures/m47_scheduler_task.md");
const INVENTORY_TASK: &str = "The tests in `test/` describe the correct behaviour of this Node.js project, and they fail: the bugs are in `src/inventory.js`. Fix them so that `node --test` passes, keeping the module's public API the same. Then run `node --test` and report the result.";

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_owned())
}

fn until<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    let t = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t.elapsed() < Duration::from_secs(secs), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn seed_inventory(root: &Path) {
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("test")).unwrap();
    std::fs::write(root.join("package.json"), "{\n  \"name\": \"inventory\",\n  \"version\": \"1.0.0\",\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test\" }\n}\n").unwrap();
    std::fs::write(
        root.join("src/inventory.js"),
        r#"'use strict';

// A small in-memory inventory: items keyed by SKU, each { qty, price } (price in cents).

function create() {
  return new Map();
}

function addItem(inv, sku, qty, price) {
  const cur = inv.get(sku);
  if (cur) {
    cur.qty = cur.qty + qty;
  } else {
    inv.set(sku, { qty, price });
  }
  return inv.get(sku);
}

function removeItem(inv, sku, qty) {
  const cur = inv.get(sku);
  if (!cur) throw new Error('unknown sku ' + sku);
  cur.qty = cur.qty - qty;
  return cur;
}

function totalValue(inv) {
  let total = 0;
  for (const { qty, price } of inv.values()) total += qty + price;
  return total;
}

// "sku,qty,price" lines; a header line is allowed; quoted fields may contain commas.
function parseCsv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('sku')) continue;
    const [sku, qty, price] = line.split(',');
    out.push({ sku, qty: Number(qty), price: Number(price) });
  }
  return out;
}

module.exports = { create, addItem, removeItem, totalValue, parseCsv };
"#,
    )
    .unwrap();
    std::fs::write(
        root.join("test/inventory.test.js"),
        r#"'use strict';
const test = require('node:test');
const assert = require('node:assert');
const inv = require('../src/inventory');

test('adding twice accumulates quantity', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 100);
  assert.strictEqual(inv.addItem(i, 'a', 3, 100).qty, 5);
});

test('quantities must be positive integers', () => {
  const i = inv.create();
  assert.throws(() => inv.addItem(i, 'a', -1, 100));
  assert.throws(() => inv.addItem(i, 'a', 1.5, 100));
});

test('removing everything removes the sku', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 100);
  inv.removeItem(i, 'a', 2);
  assert.strictEqual(i.has('a'), false);
});

test('cannot remove more than is held', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 100);
  assert.throws(() => inv.removeItem(i, 'a', 3));
  assert.strictEqual(i.get('a').qty, 2);
});

test('total value is quantity times price', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 150);
  inv.addItem(i, 'b', 1, 1000);
  assert.strictEqual(inv.totalValue(i), 1300);
});

test('csv with header, blank lines and quoted commas', () => {
  const rows = inv.parseCsv('sku,qty,price\n"x,1",2,30\n\ny,1,5\n');
  assert.deepStrictEqual(rows, [{ sku: 'x,1', qty: 2, price: 30 }, { sku: 'y', qty: 1, price: 5 }]);
});
"#,
    )
    .unwrap();
}

/// Read the engine's working copy of the project through the read-only export plan (never acknowledged).
fn export_workspace(l: &BridgeLink, pid: &str, dst: &Path) -> usize {
    let plan = match l.sync(SyncReq::ExportPlan {
        project_id: pid.to_owned(),
    }) {
        Ok(p) => p,
        Err(e) => {
            println!("export plan failed: {e:?}");
            return 0;
        }
    };
    let digest = plan["planDigest"].as_str().unwrap_or("").to_owned();
    let mut n = 0;
    for c in plan["changes"].as_array().into_iter().flatten() {
        let Some(path) = c["path"].as_str() else { continue };
        if c["new"].is_null() || path.starts_with("target/") || c["new"]["size"].as_u64().unwrap_or(0) > 4_000_000 {
            continue;
        }
        let mut data = Vec::new();
        loop {
            let r = match l.sync(SyncReq::ExportRead {
                project_id: pid.to_owned(),
                plan_digest: digest.clone(),
                path: path.to_owned(),
                offset: data.len() as u64,
                len: 1 << 20,
            }) {
                Ok(r) => r,
                Err(_) => break,
            };
            use base64::Engine as _;
            let chunk = base64::engine::general_purpose::STANDARD
                .decode(r["data"].as_str().unwrap_or(""))
                .unwrap_or_default();
            let eof = r["eof"] == true;
            data.extend(chunk);
            if eof || data.is_empty() {
                break;
            }
        }
        let f = dst.join(path);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, data).unwrap();
        n += 1;
    }
    n
}

#[test]
#[ignore]
fn experiment_run() {
    let task = env("NEXUS_M47_TASK", "inventory");
    let replay = env("NEXUS_M47_REPLAY", "window");
    let engine = env("NEXUS_M47_ENGINE", "adaptive");
    let tag = env("NEXUS_M47_TAG", &format!("{task}-{replay}-{engine}"));
    let out = PathBuf::from(env("NEXUS_M47_OUT", "/tmp/m47"));
    std::fs::create_dir_all(&out).unwrap();
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let dir = home.join("Library/Application Support/ai.arthurlabs.nexus.desktop");
    let root = home.join("benchmarks/m47").join(&tag);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".gitignore"), "target/\nnode_modules/\n").unwrap();
    if task == "inventory" {
        seed_inventory(&root);
    }
    let root = std::fs::canonicalize(&root).unwrap();
    let data = std::env::temp_dir().join(format!("nexus-m47-{tag}"));
    let _ = std::fs::remove_dir_all(&data);

    let yes: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    assert!(EngineConfig::wants_vm(&dir));
    let helper = nexus_desktop_lib::engine_vm::VmTransport::locate_helper().expect("set NEXUS_VM_HELPER");
    let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(helper, None, None, &dir));
    let l = BridgeLink::start(Box::new(vm), yes.clone(), env!("CARGO_PKG_VERSION"));
    until("engine ready", 240, || l.status().is_ready().then_some(()));
    until("runtime ready", 300, || (l.call("runtime_state", json!({})).ok()?["phase"] == "ready").then_some(()));

    let c = Coordinator::new(Arc::new(Store::open(&data).unwrap()), l.clone(), yes, Some(std::fs::canonicalize(&home).unwrap()));
    c.open_project(root.to_str().unwrap()).unwrap();
    let p = c.store.list()[0].clone();
    let gid = p.guest_id.clone().unwrap();
    let key = format!("m47-{tag}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let custom = std::env::var("NEXUS_M47_CONTENT").ok();
    let content = custom.as_deref().unwrap_or(if task == "scheduler" { SCHEDULER_TASK } else { INVENTORY_TASK });
    // `default` sends no policy: the broker's own default applies
    let replay_arg = if replay == "default" { Value::Null } else { json!(replay) };
    let t0 = Instant::now();
    let r = c
        .serve("thread_send", json!({"threadId": null, "projectId": gid, "content": content, "mode": "auto",
            "workspace": "continue", "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
            "idempotencyKey": key, "engine": engine, "permissionMode": "full", "reasoningReplay": replay_arg}))
        .unwrap();
    let run = r["run"]["runId"].as_str().unwrap().to_owned();
    println!("M47 {tag}: run {run}");
    let rec = until("run end", 3 * 3600, || {
        c.tick();
        let st = l.call("intent_status", json!({"runId": run})).ok()?;
        (st["terminal"] == true).then_some(st)
    });
    let wall = t0.elapsed().as_millis();
    // let the coordinator settle the writeback decision
    for _ in 0..20 {
        c.tick();
        std::thread::sleep(Duration::from_millis(300));
    }
    let doc = l
        .call("run_analytics_export", json!({"runId": run, "hostPlatform": "macos-aarch64", "appVersion": env!("CARGO_PKG_VERSION")}))
        .unwrap();
    let sync = serde_json::to_value(c.store.list()[0].run(&run).map(|x| x.sync.clone())).unwrap_or_default();
    let ws = out.join(format!("{tag}.workspace"));
    let _ = std::fs::remove_dir_all(&ws);
    let files = export_workspace(&l, p.id.as_str(), &ws);
    let w = |name: &str, v: &Value| std::fs::write(out.join(format!("{tag}.{name}.json")), serde_json::to_vec_pretty(v).unwrap()).unwrap();
    w("runrecord", &rec);
    w("analytics", &doc);
    w("meta", &json!({"tag": tag, "task": task, "replay": replay, "engine": engine, "runId": run, "harnessWallMs": wall,
        "writeback": sync, "exportedFiles": files, "projectRoot": root}));
    println!(
        "M47 {tag}: state={} completion={} verification={} wall={}ms requests={} hit={} uncached={} writeback={}",
        rec["state"], rec["completion"], rec["codingOutcome"]["verification"], doc["runtime"]["wallMs"],
        doc["runtime"]["requests"]["count"], doc["tokens"]["cacheHitRate"], doc["tokens"]["noncachedInput"], sync
    );
    let _ = c.forget(&gid);
    let _ = std::fs::remove_dir_all(&data);
    l.shutdown();
}
