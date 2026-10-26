#!/usr/bin/env python3
"""Local stand-ins for package registries and a git host (M5 toolchain tests).

build ROOT          create the registries' content under ROOT
serve ROOT PORTFILE serve it on 127.0.0.1 (one server; the Host header picks the registry)
tls ROOT PORTFILE CERT KEY  serve ROOT/npm over TLS
"""
import base64, hashlib, http.server, io, json, os, shutil, socketserver, ssl, subprocess, sys, tarfile, zipfile

HOSTS = {
    "registry.npm-fixture.org": "npm",
    "pypi.fixture-py.org": "pypi",
    "index.crates-fixture.org": "crates",
    "git.fixture-git.org": "git",
    "secure.fixture-tls.org": "npm",
}

def tgz(files):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode="w:gz") as t:
        for name, data in files.items():
            ti = tarfile.TarInfo(name); ti.size = len(data); ti.mtime = 0
            t.addfile(ti, io.BytesIO(data))
    return b.getvalue()

def build(root):
    # npm: fixture-lib@1.0.0
    pkg = tgz({
        "package/package.json": json.dumps({"name": "fixture-lib", "version": "1.0.0", "main": "index.js"}).encode(),
        "package/index.js": b"module.exports = () => 'fixture-lib says hello';\n",
    })
    d = os.path.join(root, "npm", "fixture-lib", "-"); os.makedirs(d)
    open(os.path.join(d, "fixture-lib-1.0.0.tgz"), "wb").write(pkg)
    integ = "sha512-" + base64.b64encode(hashlib.sha512(pkg).digest()).decode()
    packument = {
        "name": "fixture-lib", "dist-tags": {"latest": "1.0.0"},
        "versions": {"1.0.0": {"name": "fixture-lib", "version": "1.0.0", "main": "index.js",
            "dist": {"tarball": "http://registry.npm-fixture.org/fixture-lib/-/fixture-lib-1.0.0.tgz",
                     "integrity": integ, "shasum": hashlib.sha1(pkg).hexdigest()}}},
    }
    open(os.path.join(root, "npm", "fixture-lib", "index.json"), "w").write(json.dumps(packument))
    # pip: fixture-pkg 1.0
    wname = "fixture_pkg-1.0-py3-none-any.whl"
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("fixture_pkg/__init__.py", "def hello():\n    return 'fixture-pkg says hello'\n")
        z.writestr("fixture_pkg-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: fixture-pkg\nVersion: 1.0\n")
        z.writestr("fixture_pkg-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        z.writestr("fixture_pkg-1.0.dist-info/RECORD", "")
    whl = b.getvalue()
    os.makedirs(os.path.join(root, "pypi", "simple", "fixture-pkg")); os.makedirs(os.path.join(root, "pypi", "packages"))
    open(os.path.join(root, "pypi", "packages", wname), "wb").write(whl)
    open(os.path.join(root, "pypi", "simple", "fixture-pkg", "index.html"), "w").write(
        '<!DOCTYPE html><html><body><a href="http://pypi.fixture-py.org/packages/%s#sha256=%s">%s</a></body></html>' % (wname, hashlib.sha256(whl).hexdigest(), wname))
    # cargo sparse registry: fixture-crate 0.1.0
    crate = tgz({
        "fixture-crate-0.1.0/Cargo.toml": b'[package]\nname = "fixture-crate"\nversion = "0.1.0"\nedition = "2021"\n',
        "fixture-crate-0.1.0/src/lib.rs": b"pub fn hello() -> &'static str { \"fixture-crate says hello\" }\n",
    })
    os.makedirs(os.path.join(root, "crates", "fi", "xt")); os.makedirs(os.path.join(root, "crates", "dl", "fixture-crate"))
    open(os.path.join(root, "crates", "dl", "fixture-crate", "0.1.0.crate"), "wb").write(crate)
    open(os.path.join(root, "crates", "config.json"), "w").write(json.dumps({"dl": "http://index.crates-fixture.org/dl/{crate}/{version}.crate"}))
    open(os.path.join(root, "crates", "fi", "xt", "fixture-crate"), "w").write(json.dumps(
        {"name": "fixture-crate", "vers": "0.1.0", "deps": [], "cksum": hashlib.sha256(crate).hexdigest(), "features": {}, "yanked": False}) + "\n")
    # git over the dumb HTTP protocol
    work = os.path.join(root, "work"); bare = os.path.join(root, "git", "repo.git")
    os.makedirs(work); os.makedirs(os.path.dirname(bare))
    g = lambda *a, cwd=work: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", *a], cwd=cwd, check=True, capture_output=True)
    g("init", "-q"); open(os.path.join(work, "README.md"), "w").write("fixture repository\n"); g("add", "-A"); g("commit", "-q", "-m", "init")
    g("clone", "-q", "--bare", work, bare, cwd=root); g("update-server-info", cwd=bare)

class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        sub = HOSTS.get(host)
        path = path.split("?")[0].split("#")[0]
        if sub is None:
            return os.path.join(self.server.root, "_nothing_")
        p = os.path.join(self.server.root, sub, path.lstrip("/"))
        if sub == "npm" and os.path.isdir(p) and os.path.exists(os.path.join(p, "index.json")):
            return os.path.join(p, "index.json")
        return p
    def guess_type(self, path):
        if path.endswith("index.json") or path.endswith("config.json"): return "application/json"
        if os.path.basename(path) == "fixture-crate": return "text/plain"
        return super().guess_type(path)
    def log_message(self, *a): pass

class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

def serve(root, portfile, cert=None, key=None):
    s = S(("127.0.0.1", 0), H); s.root = root
    if cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
        s.socket = ctx.wrap_socket(s.socket, server_side=True)
    open(portfile, "w").write(str(s.server_address[1]))
    s.serve_forever()

if __name__ == "__main__":
    c = sys.argv[1]
    if c == "build": build(sys.argv[2])
    elif c == "serve": serve(sys.argv[2], sys.argv[3])
    elif c == "tls": serve(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
