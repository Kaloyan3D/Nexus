/**
 * The runtime's start-up failures are written for engineers ("node was not found on PATH"). This turns the
 * ones a person can fix into what to do. Unknown messages are shown as they are, after the generic advice.
 */
export interface StartupHelp {
  title: string;
  steps: string[];
}

export function startupHelp(message: string | null | undefined): StartupHelp {
  const m = (message ?? "").toLowerCase();
  if (m.includes("node was not found")) {
    return {
      title: "Nexus needs Node.js",
      steps: [
        "Install Node.js 20 or newer (nodejs.org, or your system's package manager).",
        "If you installed it with a version manager such as nvm, make sure it is available to programs started from your desktop menu, not only to your terminal.",
        "Restart Nexus.",
      ],
    };
  }
  if (m.includes("not found (set nexus_bin_dir)") || m.includes("registry/controller bridge was not found") || m.includes("cannot locate the nexus binaries")) {
    return {
      title: "Part of Nexus is missing from this installation",
      steps: ["Reinstall Nexus from the installer you downloaded.", "If you are running a development build, build the native runtime first."],
    };
  }
  if (m.includes("sun_len") || m.includes("path must be shorter")) {
    return {
      title: "Nexus's data folder path is too long",
      steps: ["Nexus talks to its runtime through a socket whose path has a length limit.", "Use a shorter location for Nexus's data (the NEXUS_HOME setting), or leave it at the default."],
    };
  }
  if (m.includes("permission denied") || m.includes("read-only file system") || m.includes("no data directory")) {
    return {
      title: "Nexus cannot use its data folder",
      steps: ["Check that your home folder is writable and not full.", "Then press Try again."],
    };
  }
  if (m.includes("did not become ready") || m.includes("timed out")) {
    return {
      title: "The Nexus runtime did not start in time",
      steps: ["Press Try again. A slow disk or a leftover process from a crash can delay it.", "If it keeps happening, restart your computer and open Nexus again."],
    };
  }
  return { title: "Nexus could not start", steps: ["Press Try again.", "If it keeps happening, reinstall Nexus."] };
}
