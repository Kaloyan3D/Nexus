# Release 1 — UX contract

Principle: Nexus is simple to use *because* the machinery underneath is strict, not despite it. A person never has
to open a terminal (one declared exception, below), edit a file, set a variable or learn what a grant, port list,
tool profile or sandbox is. Every authority change is a native system dialog showing the broker's exact text.

## 1. Information architecture

Primary navigation (5): **Workspace · Projects · History · Models · Settings**. Advanced (collapsed): Controller
ledger, Control Room, Mock runs, Sentry (labelled *not connected*: no backend exists).

| Place | Purpose | What is on it |
|---|---|---|
| Workspace (idle) | start work | Setup card until ready → project composer (project, task, *Auto / Review only / Make changes*, Run) → one sentence on what Nexus may do here (expands to the four choices) → processes running now → recent conversations |
| Workspace (conversation) | follow and steer | messages, runs with result word + badges, live progress, steps, on-demand permission cards, Diff / Test output / Evidence & recovery, Resume, running processes, composer (always available; Stop while running) |
| Projects | manage access | per project: four plain choices, running processes, **Advanced permissions** (one disclosure) |
| Settings | connection and machine | provider + autonomy, engine, run limits (advanced), this computer, version, advanced diagnostics |

No model, route, request-mode, path, limit, digest or approval control exists in the ordinary composer.

## 2. Journeys

1. **First run** — *This computer* findings with fixes → Nexus starts → connect OpenCode Go (key in a system dialog)
   → allow autonomous work (system dialog) → prepare Nexus Adaptive (billable, system dialog) → open a project
   (system folder picker) → composer. Each step's failure shows the cause and what to do.
2. **Build a website** — "Describe what to build or fix" → Run. Nexus works; progress shows *Now:*, steps, counts.
   If it needs a preview port it was not allowed: a card names the port ("Nexus wants to show your site on port
   5173"); **Allow and continue…** opens the system dialog with the broker's text; on yes the permission is stored
   and the same conversation is told to carry on. The server appears under *Running on this computer* with **Open
   preview**, log, **Stop**.
3. **Inspect** — result word (Verified / Not verified / Failed / Refused / Stopped / Unavailable) + the evidence
   behind it (commands with exit codes, changed files, diff). The model's own claim is never the source.
4. **Recover** — Evidence & recovery → what each command changed → **Review recovery…** (changes nothing) →
   **Restore N files…** → system dialog with the exact outcome → result counts. Conflicts are left alone.
5. **Stop / resume** — Stop cancels the run; Resume (broker-decided, with a stated reason when not allowed) continues it.
6. **Revoke** — Projects → *Stop allowing* previews, or Advanced → Revoke: running servers stop; running tasks lose the permission.

## 3. Permission model

| Plain choice | Means | Stored as | Default |
|---|---|---|---|
| Edit files | in your folder / on a copy | workspace mode | chosen at first open (system dialog) |
| Run commands | in the project folder, sandboxed, offline | grant `fs=workspace` | off (temporary copy) |
| Download dependencies | install commands may reach package registries | grant `net=install` (or legacy switch on copies) | off |
| Local previews | a dev server may be shown on **this computer only**, on named ports | grant `devPorts` | off, none |

Rules the UI and native layer enforce (each has a test):
- The renderer names a project and, for previews, port numbers 1024–65535 (≤ 8). Never a path, address, digest it
  did not receive, tool or limit. The preview address is read from the broker's job record and must be
  `http://127.0.0.1:<port>`.
- Every widening = broker preview text → native dialog → only a "yes" returns that text's digest. A declined dialog is silent and changes nothing.
- Amendments keep the existing lifetime (never extended), recovery policy, Git choice, destination list; revoked/expired permissions are not revived with their old options.
- Previews are **demand-driven**: no port is pre-authorized. The first refusal produces the exact request.
- A run keeps the permissions it started with; cards say "applies from your next message" while a run is live.
- The model cannot request, grant, widen or renew anything; a card only exists because a refusal is in the run record.
- Never automatic: Full Access, unrestricted network, Git writes, ask-mode.
- Advanced (one disclosure): network destinations, expiry, approval mode, Full Access (flagged), auto-apply.

## 4. Honest wording (decisions)

- "Verified" is only said when a recorded command passed in the project. A run cancelled after a passing test says
  *Last test command passed*, under **Stopped**.
- Direct edits: "Nexus keeps the original of every file it changes (30 days) … cannot put edited files back with
  one click yet." No promise of a universal undo anywhere.
- Ask-before-each-action requires a separate terminal approver; the project shows a warning and how to switch to automatic.
- Capabilities the machine lacks are shown disabled **with the reason** (sandbox, network gatekeeper, approver).

## 5. Accessibility and layout

Native `button`/`select`/`details`, labelled groups and regions, `role=alert/status` for outcomes, Escape closes
panels, Ctrl+Enter sends, compact layout (drawer nav, overlay panel) below 1000 px. No new colours or motion; the
Arthur Labs tokens and existing components are reused.
