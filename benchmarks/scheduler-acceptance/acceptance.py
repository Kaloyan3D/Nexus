#!/usr/bin/env python3
"""Independent black-box acceptance suite for generated job-scheduler projects (M4.7 Phase 7).

Kept OUTSIDE every generated repository; no harness sees it during a benchmark. It drives each implementation only
through its CLI (an adapter maps the invocation syntax) and observes behaviour from the outside:

* execution counts come from marker files the job commands themselves append to (independent of any schema);
* job state comes from the CLI's own `show` output;
* surviving descendants are found with `ps` by a unique token in their command line.

Usage: acceptance.py <native|dsh> <path-to-binary> [test ...]   (prints one JSON line per test, then a summary)
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, time, uuid

TERMINAL = {"succeeded", "failed", "cancelled", "blocked"}


class Adapter:
    def __init__(self, kind, binary, db):
        self.kind, self.bin, self.db = kind, binary, db

    def _cli(self, *args, timeout=20):
        return subprocess.run([self.bin, "--db", self.db, *args], capture_output=True, text=True, timeout=timeout)

    def add(self, name, command, priority=0, retries=0, timeout=30, deps=()):
        a = ["add", "--name", name, "--command", command, "--priority", str(priority), "--max-retries", str(retries)]
        if self.kind == "native":
            a += ["--timeout", str(timeout), "--backoff", "0.2"]
            for d in deps:
                a += ["--depends-on", d]
        else:
            a += ["--timeout-s", str(max(1, int(timeout))), "--backoff-ms", "200"]
            if deps:
                a += ["--depends-on", ",".join(deps)]
        r = self._cli(*a)
        if r.returncode != 0:
            raise RuntimeError(f"add failed: {r.stderr.strip()[:300]}")
        return r.stdout.strip().splitlines()[-1].split()[-1]

    def run_cmd(self, workers=4):
        if self.kind == "native":
            return [self.bin, "--db", self.db, "run", "--workers", str(workers), "--until-idle", "--timeout-secs", "120"]
        return [self.bin, "--db", self.db, "run", "--workers", str(workers), "--until-done", "--run-timeout-s", "120"]

    def start(self, workers=4):
        return subprocess.Popen(self.run_cmd(workers), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True, text=True)

    def run(self, workers=4, timeout=90):
        p = self.start(workers)
        try:
            out, err = p.communicate(timeout=timeout)
            return p.returncode, out, err
        except subprocess.TimeoutExpired:
            kill_group(p)
            return None, "", "TIMEOUT"

    def status(self, jid):
        r = self._cli("show", jid)
        m = re.search(r"^status:\s*(\S+)", r.stdout, re.M)
        return m.group(1).lower() if m else f"?({r.returncode})"

    def cancel(self, jid):
        return self._cli("cancel", jid).returncode


def kill_group(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        p.wait(timeout=5)
    except Exception:
        pass


def survivors(token):
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    me = str(os.getpid())
    return [l.strip() for l in out.splitlines() if token in l and not l.strip().startswith(me + " ")
            and "acceptance.py" not in l and "ps -axo" not in l]


def kill_token(token):
    for l in survivors(token):
        try:
            os.kill(int(l.split()[0]), signal.SIGKILL)
        except Exception:
            pass


def count(path):
    try:
        return sum(1 for _ in open(path))
    except FileNotFoundError:
        return 0


def wait_until(pred, secs, step=0.1):
    t = time.time()
    while time.time() - t < secs:
        if pred():
            return True
        time.sleep(step)
    return pred()


# ------------------------------------------------------------------------------------------------- tests

def t_concurrent_instances(a, d):
    """Two scheduler processes on one database: every job must execute exactly once."""
    ids = [a.add(f"j{i}", f"echo x >> {d}/m{i}; sleep 2") for i in range(6)]
    p1 = a.start(2)
    time.sleep(0.7)  # the first instance is now running jobs
    p2 = a.start(2)
    for p in (p1, p2):
        try:
            p.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            kill_group(p)
    counts = [count(f"{d}/m{i}") for i in range(6)]
    states = [a.status(j) for j in ids]
    ok = all(c == 1 for c in counts) and all(s == "succeeded" for s in states)
    return ok, {"executions": counts, "states": states}


def t_lock_contention(a, d):
    """40 short jobs, 16 workers: all succeed, each exactly once, nothing stuck."""
    ids = [a.add(f"c{i}", f"echo x >> {d}/c{i}") for i in range(40)]
    rc, _, err = a.run(16, 90)
    counts = [count(f"{d}/c{i}") for i in range(40)]
    states = [a.status(j) for j in ids]
    ok = rc is not None and all(c == 1 for c in counts) and all(s == "succeeded" for s in states)
    return ok, {"exit": rc, "notOnce": sum(1 for c in counts if c != 1),
                "notSucceeded": [s for s in states if s != "succeeded"][:5], "stderr": err[-200:]}


def t_timeout_kills_descendants(a, d):
    """A compound job past its timeout: recorded promptly and no descendant survives."""
    tok = "61.%d" % (uuid.uuid4().int % 10**6)
    j = a.add("t", f"sleep {tok}; echo after >> {d}/after", timeout=2)
    t0 = time.time()
    rc, _, _ = a.run(1, 40)
    took = time.time() - t0
    left = survivors(tok)
    st = a.status(j)
    kill_token(tok)
    ok = rc is not None and took < 15 and st in ("failed",) and not left
    return ok, {"exit": rc, "seconds": round(took, 1), "state": st, "survivingDescendants": len(left)}


def t_cancel_running_compound(a, d):
    """Cancel a running compound job: cancelled within seconds, no descendant survives, no post-cancel work."""
    tok = "62.%d" % (uuid.uuid4().int % 10**6)
    j = a.add("c", f"sleep {tok}; echo after >> {d}/after", timeout=120)
    p = a.start(1)
    running = wait_until(lambda: a.status(j) == "running", 10)
    time.sleep(0.5)
    a.cancel(j)
    gone = wait_until(lambda: not survivors(tok), 8)
    st_ok = wait_until(lambda: a.status(j) == "cancelled", 8)
    left = survivors(tok)
    kill_token(tok)
    try:
        p.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        kill_group(p)
    ok = running and gone and st_ok and count(f"{d}/after") == 0
    return ok, {"sawRunning": running, "state": a.status(j), "survivingDescendants": len(left),
                "postCancelWork": count(f"{d}/after")}


def t_cancel_before_start(a, d):
    """A job cancelled before the scheduler starts never executes."""
    j = a.add("p", f"echo x >> {d}/p")
    a.cancel(j)
    a.run(2, 30)
    st = a.status(j)
    return st == "cancelled" and count(f"{d}/p") == 0, {"state": st, "executions": count(f"{d}/p")}


def t_crash_recovery(a, d):
    """SIGKILL the scheduler mid-job; restart; the job completes and nothing is left running."""
    j = a.add("r", f"echo x >> {d}/r; sleep 3", retries=2)
    p = a.start(1)
    wait_until(lambda: count(f"{d}/r") >= 1, 10)
    time.sleep(0.5)
    kill_group(p)
    rc, _, _ = a.run(1, 60)
    st = a.status(j)
    return st == "succeeded" and rc is not None, {"state": st, "executions": count(f"{d}/r"), "restartExit": rc}


def t_crash_consistency(a, d):
    """SIGKILL during heavy activity; restart; every job ends succeeded, none stuck, each ran at least once."""
    ids = [a.add(f"h{i}", f"echo x >> {d}/h{i}; sleep 0.3", retries=2) for i in range(20)]
    p = a.start(4)
    time.sleep(1.0)
    kill_group(p)
    rc, _, _ = a.run(4, 90)
    states = [a.status(j) for j in ids]
    counts = [count(f"{d}/h{i}") for i in range(20)]
    ok = rc is not None and all(s == "succeeded" for s in states) and all(c >= 1 for c in counts)
    return ok, {"notSucceeded": [s for s in states if s != "succeeded"], "executions": counts}


def t_large_stdout(a, d):
    j = a.add("o", "head -c 5000000 /dev/zero | tr '\\0' 'a'", timeout=60)
    rc, _, _ = a.run(1, 90)
    st = a.status(j)
    return st == "succeeded", {"state": st, "exit": rc}


def t_large_stderr(a, d):
    """200 KB on stderr (more than a pipe buffer) while stdout stays open."""
    j = a.add("e", "head -c 200000 /dev/zero | tr '\\0' 'e' 1>&2; echo done", timeout=20)
    t0 = time.time()
    rc, _, _ = a.run(1, 60)
    st = a.status(j)
    return st == "succeeded", {"state": st, "seconds": round(time.time() - t0, 1), "exit": rc}


def t_utf8_output(a, d):
    """More than 8 KB of multi-byte output (a common truncation boundary)."""
    j = a.add("u", "i=0; while [ $i -lt 6000 ]; do printf 'é'; i=$((i+1)); done", timeout=30)
    rc, _, err = a.run(1, 60)
    st = a.status(j)
    return st == "succeeded", {"state": st, "exit": rc, "panicked": "panicked" in err}


def t_timeout_enforced(a, d):
    j = a.add("s", "sleep 10", timeout=1)
    t0 = time.time()
    a.run(1, 40)
    st = a.status(j)
    took = time.time() - t0
    return st == "failed" and took < 8, {"state": st, "seconds": round(took, 1)}


def t_dependency_propagation(a, d):
    """A fails -> B (needs A) -> C (needs B): neither B nor C ever executes; both end terminal and not succeeded."""
    ja = a.add("a", "exit 3")
    jb = a.add("b", f"echo x >> {d}/b", deps=[ja])
    jc = a.add("c", f"echo x >> {d}/c", deps=[jb])
    rc, _, _ = a.run(2, 40)
    s = [a.status(j) for j in (ja, jb, jc)]
    ok = s[0] == "failed" and s[1] in ("failed", "blocked") and s[2] in ("failed", "blocked") \
        and count(f"{d}/b") == 0 and count(f"{d}/c") == 0 and rc is not None
    return ok, {"states": s, "exit": rc}


def t_database_errors(a, d):
    """A database path that cannot work fails cleanly (non-zero, an error message, no panic)."""
    bad = Adapter(a.kind, a.bin, d)  # a directory
    r = bad._cli("list")
    junk = os.path.join(d, "junk.db")
    open(junk, "w").write("this is not sqlite")
    r2 = Adapter(a.kind, a.bin, junk)._cli("list")
    ok = r.returncode != 0 and r2.returncode != 0 and "panicked" not in r.stderr + r2.stderr
    return ok, {"dirExit": r.returncode, "junkExit": r2.returncode, "panicked": "panicked" in r.stderr + r2.stderr}


TESTS = {
    "concurrent-instances": t_concurrent_instances,
    "lock-contention": t_lock_contention,
    "timeout-kills-descendants": t_timeout_kills_descendants,
    "cancel-running-compound": t_cancel_running_compound,
    "cancel-before-start": t_cancel_before_start,
    "crash-recovery": t_crash_recovery,
    "crash-consistency": t_crash_consistency,
    "large-stdout": t_large_stdout,
    "large-stderr": t_large_stderr,
    "utf8-output": t_utf8_output,
    "timeout-enforced": t_timeout_enforced,
    "dependency-propagation": t_dependency_propagation,
    "database-errors": t_database_errors,
}


def main():
    kind, binary = sys.argv[1], os.path.abspath(sys.argv[2])
    names = sys.argv[3:] or list(TESTS)
    passed = 0
    for n in names:
        d = tempfile.mkdtemp(prefix=f"acc-{kind}-")
        a = Adapter(kind, binary, os.path.join(d, "s.db"))
        t0 = time.time()
        try:
            ok, detail = TESTS[n](a, d)
        except Exception as e:  # an adapter/CLI failure is a test failure, reported as such
            ok, detail = False, {"error": repr(e)[:300]}
        passed += ok
        print(json.dumps({"impl": kind, "test": n, "pass": bool(ok), "seconds": round(time.time() - t0, 1), "detail": detail}), flush=True)
        shutil.rmtree(d, ignore_errors=True)
    print(json.dumps({"impl": kind, "summary": f"{passed}/{len(names)}"}), flush=True)


if __name__ == "__main__":
    main()
