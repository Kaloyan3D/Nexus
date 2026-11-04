#!/usr/bin/env python3
"""Aggregate M4.7 A/B experiment outputs (written by src-tauri/tests/live_m47.rs) into per-arm statistics.

Usage: aggregate.py <out-dir>   ->  prints one row per run and a per-arm summary (JSON at the end).
Independent checks (outside the engine): inventory runs get the hidden acceptance (benchmarks/inventory-acceptance);
scheduler runs get an independent rebuild and re-run of their own tests on the host (self-written tests, so this is
reproduction, not independent criteria).
"""
import glob, json, os, statistics, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def hidden_inventory(ws):
    r = subprocess.run([os.path.join(ROOT, "inventory-acceptance", "run.sh"), ws], capture_output=True, text=True, timeout=120)
    p = f = None
    for l in r.stdout.splitlines():
        if "pass" in l:
            p = int(l.split()[-1])
        if "fail" in l:
            f = int(l.split()[-1])
    return p, f


def rerun_scheduler(ws):
    if not os.path.exists(os.path.join(ws, "Cargo.toml")):
        return "no-project"
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ws, "..", os.path.basename(ws) + ".target"))
    b = subprocess.run(["cargo", "build", "--quiet"], cwd=ws, env=env, capture_output=True, text=True, timeout=1800)
    if b.returncode != 0:
        return "build-failed"
    t = subprocess.run(["cargo", "test", "--quiet"], cwd=ws, env=env, capture_output=True, text=True, timeout=1800)
    return "tests-pass" if t.returncode == 0 else "tests-fail"


def row(out, tag):
    meta = json.load(open(os.path.join(out, f"{tag}.meta.json")))
    doc = json.load(open(os.path.join(out, f"{tag}.analytics.json")))
    rec = json.load(open(os.path.join(out, f"{tag}.runrecord.json")))
    ws = os.path.join(out, f"{tag}.workspace")
    # an applied run's files are in the Mac project folder (the engine baseline advanced, so the export is empty)
    if not os.path.isdir(ws) or not os.listdir(ws):
        ws = meta.get("projectRoot") or ws
    rt, tk, ef = doc.get("runtime", {}), doc.get("tokens", {}), doc.get("efficiency", {})
    r = {
        "tag": tag, "task": meta["task"], "replay": meta["replay"], "engine": meta["engine"],
        "completion": rec.get("completion"), "verification": (rec.get("codingOutcome") or {}).get("verification"),
        "writeback": (meta.get("writeback") or {}).get("state"),
        "wallMs": rt.get("wallMs"), "requests": (rt.get("requests") or {}).get("count"),
        "input": tk.get("input"), "uncached": tk.get("noncachedInput"), "output": tk.get("output"),
        "reasoning": tk.get("reasoning"), "hit": tk.get("cacheHitRate"),
        "recovery": (doc.get("verification") or {}).get("recoveryCycles"),
        "verifCycles": (doc.get("verification") or {}).get("cycles"),
        "listCostUsd": ((doc.get("cost") or {}).get("providerListPrice") or {}).get("usd"),
        "efforts": (doc.get("routing") or {}).get("attemptsPerEffort"),
        "cacheBreaks": {b["cause"]: b["uncachedInput"] for b in ((ef.get("cacheBreaks") or {}).get("byCause") or [])},
        "afterFinal": (ef.get("verificationLoop") or {}).get("requestsAfterFirstFinalAnswer"),
    }
    if meta["task"] == "inventory":
        r["hidden"] = hidden_inventory(ws)
    else:
        r["independentRerun"] = rerun_scheduler(ws)
    return r


def main():
    out = sys.argv[1]
    tags = sorted(os.path.basename(p)[: -len(".meta.json")] for p in glob.glob(os.path.join(out, "*.meta.json")))
    rows = [row(out, t) for t in tags]
    for r in rows:
        print(json.dumps(r))
    arms = {}
    for r in rows:
        arms.setdefault((r["task"], r["engine"], r["replay"]), []).append(r)
    summary = []
    for (task, engine, replay), rs in sorted(arms.items()):
        m = lambda k: statistics.mean([x[k] for x in rs if isinstance(x.get(k), (int, float))]) if any(isinstance(x.get(k), (int, float)) for x in rs) else None
        s = {"task": task, "engine": engine, "replay": replay, "runs": len(rs),
             "verifiedPassed": sum(1 for x in rs if x["verification"] == "verified-passed"),
             "meanWallS": round(m("wallMs") / 1000, 1) if m("wallMs") else None, "meanRequests": m("requests"),
             "meanUncached": m("uncached"), "meanHit": round(m("hit"), 4) if m("hit") else None,
             "meanOutput": m("output"), "meanReasoning": m("reasoning"), "meanListCostUsd": m("listCostUsd")}
        if task == "inventory":
            s["hiddenAllPass"] = sum(1 for x in rs if x.get("hidden") and x["hidden"][1] == 0)
        else:
            s["independentRerunPass"] = sum(1 for x in rs if x.get("independentRerun") == "tests-pass")
        summary.append(s)
        print("ARM", json.dumps(s))
    json.dump({"rows": rows, "arms": summary}, open(os.path.join(out, "aggregate.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
