import { useEffect, useState } from "react";
import type { EnvCheck } from "../../lib/contracts";
import { Alert } from "../../components/ui/primitives";
import { useNexus } from "../../state/NexusContext";

/** What a missing system tool means for the person, with the way to fix it. Pure, so it can be tested. */
export function environmentFindings(env: EnvCheck | null, inPlace: { available: boolean | undefined; reason: string | null | undefined }): Array<{ id: string; tone: "error" | "warning" | "info"; title: string; body: string }> {
  const out: Array<{ id: string; tone: "error" | "warning" | "info"; title: string; body: string }> = [];
  if (!env) return out;
  if (env.platform !== "linux") {
    out.push({
      id: "platform",
      tone: "warning",
      title: `Nexus has only been tested on Linux (this is ${env.platform})`,
      body: "Some features may not work here. The sandbox that runs your project's commands and previews is Linux-only.",
    });
  }
  if (!env.dialogTool) {
    out.push({
      id: "dialog",
      tone: "error",
      title: "Nexus cannot show its permission dialogs",
      body: "Nexus asks for your API key and for every permission in a system dialog that web content cannot imitate. Install “zenity” or “kdialog” with your system's package manager (for example, “sudo apt install zenity” or “sudo pacman -S zenity”), then restart Nexus.",
    });
  }
  if (inPlace.available === false) {
    out.push({
      id: "sandbox",
      tone: "warning",
      title: "Commands in your project folder are unavailable on this computer",
      body: `${inPlace.reason ?? "The sandbox is not available."} Nexus can still read and edit files and run tests in a temporary copy, but it cannot install dependencies, keep build output, or show a running site. This usually needs a newer Linux kernel with Landlock, or reinstalling Nexus.`,
    });
  }
  const found = env.toolchains.filter(([, ok]) => ok).map(([n]) => n);
  const missing = env.toolchains.filter(([, ok]) => !ok).map(([n]) => n);
  if (!env.toolchains.some(([n, ok]) => ok && ["node", "npm", "python3", "cargo"].includes(n))) {
    out.push({
      id: "toolchains",
      tone: "warning",
      title: "No build tools were found",
      body: `Nexus did not find node, npm, python3 or cargo on this computer, so it cannot build or test most projects. Install what your project needs (for a website: Node.js) and restart Nexus.${found.length ? ` Found: ${found.join(", ")}.` : ""}`,
    });
  } else if (missing.length > 0) {
    out.push({
      id: "missing-tools",
      tone: "info",
      title: `Not found on this computer: ${missing.join(", ")}`,
      body: "Projects that need these can be edited, but Nexus cannot build or test them until they are installed.",
    });
  }
  if (!env.opener) {
    out.push({
      id: "opener",
      tone: "info",
      title: "Previews cannot open your browser by themselves",
      body: "“xdg-open” was not found. You can still copy a preview's address into your browser.",
    });
  }
  return out;
}

/** The facts about this computer that decide what Nexus can do, with what to do about each. Shown only when there is something to say. */
export function EnvironmentNotes({ onlyBlocking = false }: { onlyBlocking?: boolean }) {
  const { api, permissionSupport } = useNexus();
  const [env, setEnv] = useState<EnvCheck | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .environmentCheck()
      .then((e) => alive && setEnv(e))
      .catch(() => alive && setEnv(null));
    return () => {
      alive = false;
    };
  }, [api]);
  const inPlace = permissionSupport?.known === true ? { available: permissionSupport.inPlaceAvailable, reason: permissionSupport.inPlaceReason } : { available: undefined, reason: undefined };
  const findings = environmentFindings(env, inPlace).filter((f) => !onlyBlocking || f.tone === "error");
  if (findings.length === 0) return null;
  return (
    <section className="nv-envnotes" aria-label="About this computer">
      {findings.map((f) => (
        <Alert key={f.id} tone={f.tone} title={f.title}>
          {f.body}
        </Alert>
      ))}
    </section>
  );
}
