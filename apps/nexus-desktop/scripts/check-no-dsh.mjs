// Fails when Nexus desktop source or dependencies reference the DSH frontend, Cordis
// extensions, or DSH-prefixed CSS variables.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// "dsh-session-log" is the name of a read-only historical data source (see
// nexus-transcript), not a dependency on the DSH frontend.
const banned = [/\bcordis\b/i, /--dsh-/i, /(from|require\()\s*["'][^"']*(dsh|cordis)[^"']*["']/i];
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css|html|json|rs|toml)$/.test(name)) {
      const text = readFileSync(p, "utf8");
      for (const re of banned) if (re.test(text)) problems.push(`${p}: matches ${re}`);
    }
  }
}
walk(join(root, "src"));
walk(join(root, "src-tauri", "src"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (/dsh|cordis/i.test(dep)) problems.push(`package.json dependency ${dep}`);
}
if (problems.length) {
  console.error("DSH independence check FAILED:\n" + problems.join("\n"));
  process.exit(1);
}
console.log("DSH independence check passed: no DSH/Cordis imports, CSS variables or dependencies.");
