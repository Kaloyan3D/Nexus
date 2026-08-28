window.__ModuleLoader__.load({
	id: "@nexus/controller",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
//#region nexus controller drawer
/**
* @nexus/controller — the Nexus Controller panel (client half).
*
* TASK-0002 repair — the controller UI mounts into the ADDITIVE shell.overlay
* list seat as a right-edge drawer. The previous version registered into the
* `details` seat, which is kind single / scope session and already occupied
* by the native DetailsPanel (client-ui-conversation) at priority 0 — that
* occupant declares the conversation.details.tool child seat, and the pinned
* slot core REJECTS an equal-priority second registration ("single slot …
* already has a registration") while a shadowing registration would silently
* replace the native tool-details panel. The pinned architecture offers no
* additive right-column seat (verified in the slot declaration table), so the
* drawer lives in shell.overlay ("This is the additive seat for a frame-wide
* surface of your own"). Native details behavior is entirely untouched:
* DetailsPanel keeps the details seat and its conversation.details.tool
* declaration; open/close/drag stay layout-owned. Coherence: when the native
* details column opens while the drawer is open, the drawer closes itself
* (ResizeObserver on the details column).
*
* The panel displays REAL controller state only:
*   - task ledger / session bindings / routing state / routing decisions
*     arrive from the read-only host route /nexus/controller.json (polled at
*     1.5s — the fallback strategy; git is cached server-side at 10s);
*   - context occupancy + running flag arrive from the sessions list snapshot
*     (projections.values.contextPressure / byId[].running), when the host
*     populates them;
*   - the WORKING vs WAITING distinction folds the session live running flag
*     (the agent loop own signal).
*
* The panel is strictly read-only: no execution-class switching, no routing
* override, no Codex triggers, no task mutation. Open/close state persists in
* localStorage (there is no upstream layout-preference persistence to reuse —
* the layout store is transient by design).
*/
const POLL_MS = 1500;
const PREF_KEY = "nexus.controller.panel.open";
const MAX_VISIBLE_CHECKS = 5;
const DRAWER_WIDTH = 340;

//#region open/close state (module-level external store)
let openPref = null;
const openListeners = new Set();
/** The session for which the user (or the auto-open rule) already decided. */
let decidedForSession = null;
function readOpenPref() {
	if (openPref !== null) return openPref;
	let value = true;
	try {
		const stored = window.localStorage.getItem(PREF_KEY);
		if (stored === "0") value = false;
	} catch { /* storage unavailable: keep default */ }
	openPref = value;
	return value;
}
function setOpenPref(value) {
	openPref = value;
	try { window.localStorage.setItem(PREF_KEY, value ? "1" : "0"); } catch { /* best effort */ }
	for (const fn of [...openListeners]) { try { fn(); } catch { /* never break the UI */ } }
}
/** Decide (user action or auto-open) and remember the session it was for. */
function decideOpen(value, sessionId) {
	if (sessionId) decidedForSession = sessionId;
	setOpenPref(value);
}
function subscribeOpenPref(fn) {
	openListeners.add(fn);
	return () => { openListeners.delete(fn); };
}
function getOpenSnapshot() {
	return readOpenPref();
}
//#endregion

//#region display-state mapping (mirrors status.cjs deriveDisplayState)
const STATE_META = {
	unavailable: { label: "UNAVAILABLE", tone: "err", pulse: false },
	idle:      { label: "IDLE",      tone: "muted",  pulse: false },
	starting:  { label: "STARTING",  tone: "active", pulse: false },
	working:   { label: "WORKING",   tone: "active", pulse: true },
	verifying: { label: "VERIFYING", tone: "active", pulse: true },
	reviewing: { label: "REVIEWING", tone: "active", pulse: true },
	repairing: { label: "REPAIRING", tone: "warn",   pulse: false },
	waiting:   { label: "WAITING",   tone: "warn",   pulse: false },
	complete:  { label: "COMPLETE",  tone: "ok",     pulse: false },
	failed:    { label: "FAILED",    tone: "err",    pulse: false },
};
const TONE_VAR = {
	active: "var(--dsw-alias-state-business-primary)",
	ok:     "var(--dsw-alias-state-success-primary)",
	warn:   "var(--dsw-alias-state-warn-primary)",
	err:    "var(--dsw-alias-state-error-primary)",
	muted:  "var(--dsw-alias-label-tertiary)",
};
/**
* Final display state from the file-derived state plus the session live running flag.
* Non-terminal states read WAITING while the agent loop is idle; VERIFYING is exempt
* because deterministic verification runs through the CLI, outside the agent loop.
*/
function deriveDisplayState(fileState, running) {
	if (!fileState || fileState === "idle" || fileState === "failed" || fileState === "complete") return fileState || "idle";
	if (fileState === "verifying") return "verifying";
	return running === true ? fileState : "waiting";
}
/**
* Final pill state for the panel: transport failure (fetch error / non-200 /
* unparseable envelope) and envelope-level errors (the host could not build a
* controller snapshot) are UNAVAILABLE — never IDLE. IDLE means a healthy
* controller with no active work. File-level fail-closed degradation inside a
* healthy envelope (missing/corrupt sources become null rows) does NOT flip
* the pill; only the state itself is derived, as before.
*/
function resolveDisplayState(snapshot, running, failed) {
	if (failed || (snapshot && snapshot.error)) return "unavailable";
	return deriveDisplayState(snapshot ? snapshot.state : null, running);
}
//#endregion

//#region formatting
function formatTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
	if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
	return String(value);
}
function formatCount(value) {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}
function formatElapsed(isoUtc) {
	if (!isoUtc) return null;
	const start = Date.parse(isoUtc);
	if (!Number.isFinite(start)) return null;
	const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
	if (seconds < 60) return seconds + "s";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
	const hours = Math.floor(minutes / 60);
	return hours + "h " + (minutes % 60) + "m";
}
/** Show the reasoning badge only when it is not already part of the model name. */
function reasoningBadgeVisible(modelName, reasoning) {
	if (!modelName || !reasoning) return false;
	return !String(modelName).toUpperCase().endsWith(String(reasoning).toUpperCase());
}
//#endregion

//#region polling
function useControllerSnapshot(sessionId) {
	const [snapshot, setSnapshot] = react.useState(null);
	const [failed, setFailed] = react.useState(false);
	react.useEffect(() => {
		let cancelled = false;
		let timer = null;
		let inflight = false;
		const poll = async () => {
			if (inflight || cancelled) return;
			inflight = true;
			try {
				const response = await fetch("./nexus/controller.json?session=" + encodeURIComponent(sessionId || ""), { cache: "no-store" });
				if (!response.ok) throw new Error("controller state http " + response.status);
				const data = await response.json();
				if (cancelled) return;
				setSnapshot(data);
				setFailed(false);
			} catch {
				if (!cancelled) setFailed(true);
			} finally {
				inflight = false;
			}
		};
		poll();
		timer = window.setInterval(poll, POLL_MS);
		return () => {
			cancelled = true;
			if (timer !== null) window.clearInterval(timer);
		};
	}, [sessionId]);
	return { snapshot, failed };
}
//#endregion

//#region small building blocks
function Section({ label, children }) {
	return react_jsx_runtime.jsxs("div", {
		className: "nx-section",
		children: [
			react_jsx_runtime.jsx("div", { className: "nx-label", children: label }),
			react_jsx_runtime.jsx("div", { className: "nx-section-body", children }),
		],
	});
}
function Bar({ value, max, tone }) {
	if (typeof value !== "number" || typeof max !== "number" || max <= 0) return null;
	const percent = Math.max(0, Math.min(100, Math.round(value / max * 100)));
	return react_jsx_runtime.jsx("div", {
		className: "nx-bar",
		role: "progressbar",
		"aria-valuenow": percent,
		"aria-valuemin": 0,
		"aria-valuemax": 100,
		children: react_jsx_runtime.jsx("div", {
			className: "nx-bar-fill",
			style: { width: percent + "%", background: tone ? TONE_VAR[tone] : undefined },
		}),
	});
}
function StatusPill({ state }) {
	const meta = STATE_META[state] || STATE_META.idle;
	return react_jsx_runtime.jsxs("span", {
		className: "nx-state",
		children: [
			react_jsx_runtime.jsx("span", {
				className: "nx-dot" + (meta.pulse ? " nx-pulse" : ""),
				"aria-hidden": true,
				style: { background: TONE_VAR[meta.tone] },
			}),
			react_jsx_runtime.jsx("span", { children: meta.label }),
		],
	});
}
function CopyButton({ text, label }) {
	const [copied, setCopied] = react.useState(false);
	const onClick = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		} catch { /* clipboard unavailable: ignore */ }
	};
	return react_jsx_runtime.jsx("button", {
		type: "button",
		className: "nx-copy",
		"aria-label": label || "Copy",
		title: label || "Copy",
		onClick,
		children: copied
			? react_jsx_runtime.jsx("span", { className: "nx-copy-ok", children: "✓" })
			: react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: "12",
				height: "12",
				"aria-hidden": true,
				children: react_jsx_runtime.jsx("path", {
					d: "M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11M2 6.5h6A1.5 1.5 0 0 1 9.5 8v6A1.5 1.5 0 0 1 8 15.5H2A1.5 1.5 0 0 1 .5 14V8A1.5 1.5 0 0 1 2 6.5Z",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.2",
				}),
			}),
	});
}
function CheckRow({ check }) {
	const pass = check.status === "PASS";
	const skipped = check.status === "SKIP";
	return react_jsx_runtime.jsxs("div", {
		className: "nx-check",
		children: [
			react_jsx_runtime.jsx("span", {
				className: "nx-check-glyph" + (pass ? " nx-check-pass" : skipped ? " nx-check-skip" : " nx-check-fail"),
				"aria-hidden": true,
				children: pass ? "✓" : skipped ? "–" : "✕",
			}),
			react_jsx_runtime.jsx("span", { className: "nx-check-name", title: check.name, children: check.name }),
		],
	});
}
//#endregion

//#region panel body
/**
* The read-only controller surface: header (title + live state pill + close) and
* the section list. Pure render — the drawer owns polling and session derivation,
* so this component takes resolved values as props.
*/
function ControllerBody({ snapshot, failed, running, pressure, onClose }) {
	const bound = !!(snapshot && snapshot.binding);
	const task = snapshot && snapshot.task ? snapshot.task : null;
	const execution = snapshot && snapshot.execution ? snapshot.execution : null;
	const review = snapshot && snapshot.review ? snapshot.review : null;
	const git = snapshot && snapshot.git ? snapshot.git : null;
	const controller = snapshot && snapshot.controller ? snapshot.controller : null;
	const verification = task ? task.verification : null;
	const displayState = resolveDisplayState(snapshot, running, failed);

	const usedTokens = pressure ? (typeof pressure.projectedTokens === "number" ? pressure.projectedTokens : pressure.pressureTokens) : undefined;
	const windowTokens = pressure ? pressure.contextWindow : undefined;
	const showContext = typeof usedTokens === "number" && typeof windowTokens === "number";

	const checks = verification && Array.isArray(verification.checks) ? verification.checks : [];
	const visibleChecks = checks.slice(0, MAX_VISIBLE_CHECKS);
	const hiddenChecks = checks.length - visibleChecks.length;

	const showReasoningBadge = reasoningBadgeVisible(execution ? execution.model : null, execution ? execution.reasoning : null);

	return react_jsx_runtime.jsxs("div", {
		className: "nx-panel",
		"data-nexus-controller": true,
		children: [
			react_jsx_runtime.jsxs("div", {
				className: "nx-head",
				children: [
					react_jsx_runtime.jsx("div", { className: "nx-title", children: "CONTROLLER" }),
					react_jsx_runtime.jsx(StatusPill, { state: displayState }),
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "nx-close",
						"aria-label": "Collapse controller panel",
						title: "Collapse",
						onClick: () => onClose(),
						children: react_jsx_runtime.jsx("svg", {
							viewBox: "0 0 16 16",
							width: "13",
							height: "13",
							"aria-hidden": true,
							children: react_jsx_runtime.jsx("path", {
								d: "M4 4l8 8M12 4l-8 8",
								stroke: "currentColor",
								strokeWidth: "1.4",
								strokeLinecap: "round",
							}),
						}),
					}),
				],
			}),
			react_jsx_runtime.jsx("div", {
				className: "nx-body",
				children: !snapshot && failed
					? react_jsx_runtime.jsx("div", {
						className: "nx-empty",
						children: "Controller state unavailable",
					})
					: !snapshot
						? react_jsx_runtime.jsx("div", { className: "nx-empty", children: "Loading…" })
						: !bound
							? react_jsx_runtime.jsxs("div", {
								className: "nx-empty",
								children: [
									react_jsx_runtime.jsx("div", { className: "nx-empty-title", children: "No managed task" }),
									react_jsx_runtime.jsx("div", { className: "nx-empty-note", children: "This session is not bound to a controller task." }),
								],
							})
							: react_jsx_runtime.jsxs(react.Fragment, {
								children: [
										execution && react_jsx_runtime.jsxs(Section, {
											label: "Executor",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-executor",
													children: [
														react_jsx_runtime.jsx("span", { className: "nx-model", children: execution.model || "—" }),
														showReasoningBadge && react_jsx_runtime.jsx("span", { className: "nx-badge", children: execution.reasoning.toUpperCase() }),
													],
												}),
												execution.provider && react_jsx_runtime.jsx("div", { className: "nx-sub", children: execution.provider }),
											],
										}),
										execution && react_jsx_runtime.jsxs(Section, {
											label: "Execution Class",
											children: [
												react_jsx_runtime.jsx("div", { className: "nx-value", children: react_jsx_runtime.jsx("code", { className: "nx-class", children: execution.class || "—" }) }),
											],
										}),
										react_jsx_runtime.jsxs(Section, {
											label: "Task",
											children: [
												task && task.taskId
													? react_jsx_runtime.jsxs("div", {
														className: "nx-value nx-task-row",
														children: [
															react_jsx_runtime.jsx("span", { className: "nx-task-id", title: task.taskId, children: task.taskId }),
															react_jsx_runtime.jsx(CopyButton, { text: task.taskId, label: "Copy task id" }),
														],
													})
													: react_jsx_runtime.jsx("div", { className: "nx-sub", children: "No task record" }),
												task && task.description
													? react_jsx_runtime.jsx("div", { className: "nx-task-desc", title: task.description, children: task.description })
													: null,
											],
										}),
										task && react_jsx_runtime.jsxs(Section, {
											label: "Attempt",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-attempt",
													children: [
														// attempt 0 = no attempt started yet: render "—", never "0 / max"
														react_jsx_runtime.jsx("span", { children: task.attempt > 0 ? formatCount(task.attempt) : "—" }),
														task.attempt > 0 && typeof task.maxAttempts === "number" && react_jsx_runtime.jsx("span", { className: "nx-sub-inline", children: " / " + task.maxAttempts }),
													],
												}),
												react_jsx_runtime.jsx(Bar, { value: task.attempt > 0 ? task.attempt : null, max: task.maxAttempts, tone: "active" }),
											],
										}),
										verification && react_jsx_runtime.jsxs(Section, {
											label: "Verification",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-attempt",
													children: [
														verification.status === "not-run" && react_jsx_runtime.jsx("span", { className: "nx-muted", children: "Not run" }),
														verification.status === "running" && react_jsx_runtime.jsx("span", { children: "Running…" }),
														verification.status === "passed" && react_jsx_runtime.jsx("span", { className: "nx-ok", children: verification.total + " / " + verification.total + " passed ✓" }),
														verification.status === "failed" && react_jsx_runtime.jsx("span", { className: "nx-err", children: verification.failed + " / " + verification.total + " failed ✕" }),
														verification.status === "partial" && react_jsx_runtime.jsx("span", { className: "nx-warn", children: verification.passed + " / " + verification.total + " passed" }),
													],
												}),
												(verification.status === "passed" || verification.status === "failed" || verification.status === "partial") && react_jsx_runtime.jsx(Bar, {
													value: verification.passed,
													max: verification.total,
													tone: verification.failed > 0 ? "err" : "ok",
												}),
												visibleChecks.length > 0 && react_jsx_runtime.jsx("div", {
													className: "nx-checks",
													children: [
														visibleChecks.map((check) => react_jsx_runtime.jsx(CheckRow, { check }, check.name)),
														hiddenChecks > 0 && react_jsx_runtime.jsx("div", { className: "nx-sub", children: "+" + hiddenChecks + " more" }),
													],
												}),
											],
										}),
										review && react_jsx_runtime.jsxs(Section, {
											label: "Codex Reviews",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-attempt",
													children: [
														react_jsx_runtime.jsx("span", { children: formatCount(review.codexCalls) }),
														review.required && react_jsx_runtime.jsx("span", { className: "nx-badge nx-badge-warn", children: "REQUIRED" }),
													],
												}),
											],
										}),
										showContext && react_jsx_runtime.jsxs(Section, {
											label: "Context",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-attempt",
													children: [
														react_jsx_runtime.jsx("span", { children: formatTokens(usedTokens) }),
														react_jsx_runtime.jsx("span", { className: "nx-sub-inline", children: " / " + formatTokens(windowTokens) + " tokens" }),
													],
												}),
												react_jsx_runtime.jsx(Bar, { value: usedTokens, max: windowTokens, tone: "active" }),
											],
										}),
										git && react_jsx_runtime.jsxs(Section, {
											label: "Git",
											children: [
												react_jsx_runtime.jsxs("div", {
													className: "nx-value nx-attempt",
													children: [
														react_jsx_runtime.jsx("span", { className: "nx-branch", children: git.branch || "—" }),
														react_jsx_runtime.jsx("span", { className: "nx-sub-inline", children: typeof git.filesChanged === "number" ? git.filesChanged + (git.filesChanged === 1 ? " file changed" : " files changed") : null }),
													],
												}),
												(typeof git.insertions === "number" || typeof git.deletions === "number") && react_jsx_runtime.jsxs("div", {
													className: "nx-sub nx-diff",
													children: [
														react_jsx_runtime.jsx("span", { className: "nx-ins", children: "+" + formatCount(git.insertions) }),
														react_jsx_runtime.jsx("span", { className: "nx-del", children: "−" + formatCount(git.deletions) }),
														typeof git.untracked === "number" && git.untracked > 0 && react_jsx_runtime.jsx("span", { className: "nx-muted", children: git.untracked + " untracked" }),
													],
												}),
											],
										}),
										(controller || task) && react_jsx_runtime.jsxs("div", {
											className: "nx-foot",
											children: [
												controller && controller.status && react_jsx_runtime.jsx("span", { className: "nx-muted", children: "Controller " + controller.status + (controller.pid ? " · pid " + controller.pid : "") }),
												task && task.createdAtUtc && react_jsx_runtime.jsx("span", { className: "nx-muted", children: "Elapsed " + formatElapsed(task.createdAtUtc) }),
											],
										}),
									],
								}),
							}),
		],
	});
}
//#endregion

//#region drawer (shell.overlay entry)
/**
* The right-edge controller drawer. Registered into the additive shell.overlay
* list seat (root scope) — the native details column is left entirely alone.
* The overlay layer is click-through; only the drawer surface opts into pointer
* events, so the app stays usable around it.
*/
function ControllerDrawer({ useSessions }) {
	const sessionId = useSessions ? useSessions((s) => s && s.current) : undefined;
	const running = useSessions ? useSessions((s) => !!s && !!(s.byId && s.byId[s.current] && s.byId[s.current].running === true)) : false;
	const pressure = useSessions ? useSessions((s) => {
		if (!s || !s.byId || !s.byId[s.current] || !s.byId[s.current].projections) return undefined;
		const value = s.byId[s.current].projections.values ? s.byId[s.current].projections.values.contextPressure : undefined;
		if (value === undefined) return undefined;
		if (typeof value === "string") {
			try { return JSON.parse(value); } catch { return undefined; }
		}
		return value;
	}) : undefined;
	const { snapshot, failed } = useControllerSnapshot(sessionId);
	const open = react.useSyncExternalStore(subscribeOpenPref, getOpenSnapshot, () => readOpenPref());

	const bound = !!(snapshot && snapshot.binding);

	// Auto-open once per controller-bound session, honoring the persisted
	// preference; a user decision for the session wins from then on.
	react.useEffect(() => {
		if (!bound || open) return;
		if (decidedForSession === sessionId) return;
		if (!readOpenPref()) return;
		decideOpen(true, sessionId);
	}, [sessionId, bound, open]);

	const close = react.useCallback(() => {
		decideOpen(false, sessionId);
	}, [sessionId]);

	// Escape closes the drawer.
	react.useEffect(() => {
		if (!open) return;
		const onKey = (event) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, close]);

	// Coherence with the native details column: when the layout opens the details
	// column (native tool details), the controller drawer closes itself — the two
	// right-side surfaces never overlap.
	react.useEffect(() => {
		if (!open) return;
		const cell = document.querySelector('[data-slot="details"]');
		const column = cell ? cell.parentElement : null;
		if (!column) return;
		const observer = new ResizeObserver(() => {
			const width = column.getBoundingClientRect().width;
			if (width > 2) close();
		});
		observer.observe(column);
		return () => observer.disconnect();
	}, [open, close]);

	if (!open) return null;
	return react_jsx_runtime.jsx("div", {
		className: "nx-drawer",
		"data-nexus-drawer": true,
		"aria-label": "Controller panel",
		style: { width: "min(" + DRAWER_WIDTH + "px, calc(100vw - 40px))" },
		children: react_jsx_runtime.jsx(ControllerBody, {
			snapshot,
			failed,
			running,
			pressure,
			onClose: close,
		}),
	});
}
//#endregion

//#region header toggle
/** Additive session-header action that opens/closes the controller drawer. */
function ControllerToggle({ sessionId }) {
	const open = react.useSyncExternalStore(subscribeOpenPref, getOpenSnapshot, () => true);
	const onClick = () => {
		decideOpen(!open, sessionId);
	};
	return react_jsx_runtime.jsx("button", {
		type: "button",
		className: "nx-toggle" + (open ? " nx-toggle-on" : ""),
		"aria-label": "Controller panel",
		"aria-pressed": open,
		title: open ? "Hide controller panel" : "Show controller panel",
		onClick,
		children: react_jsx_runtime.jsx("svg", {
			viewBox: "0 0 16 16",
			width: "15",
			height: "15",
			"aria-hidden": true,
			children: react_jsx_runtime.jsx("path", {
				d: "M1 8h3l2-5 3 10 2-5h4",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round",
			}),
		}),
	});
}
//#endregion

//#region styles
/**
* Panel + drawer styles, scoped to the nx-* classes and the
* data-nexus-controller / data-nexus-drawer attributes. Every color comes
* from the DSH semantic tokens (which the @nexus/ui-brand theme already
* maps onto the Nexus palette), so light/dark/system themes keep working
* without any duplicate palette.
*/
const PANEL_CSS = [
	"[data-nexus-controller]{box-sizing:border-box;height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden}",
	"[data-nexus-controller] *,[data-nexus-controller] *::before,[data-nexus-controller] *::after{box-sizing:border-box}",
	"[data-nexus-drawer]{position:absolute;top:0;right:0;bottom:0;pointer-events:auto;z-index:1;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-12px 0 32px rgba(0,0,0,.22);animation:nx-drawer-in 180ms ease-out;max-width:100%}",
	"@keyframes nx-drawer-in{from{transform:translateX(28px);opacity:.35}to{transform:none;opacity:1}}",
	"@media (prefers-reduced-motion: reduce){[data-nexus-drawer]{animation:none}}",
	".nx-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;flex:none}",
	".nx-title{font-size:10px;font-weight:600;letter-spacing:.16em;color:var(--dsw-alias-label-tertiary)}",
	".nx-state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
	".nx-dot{width:7px;height:7px;border-radius:50%;flex:none}",
	".nx-pulse{animation:nx-pulse 1.6s ease-in-out infinite}",
	"@keyframes nx-pulse{0%,100%{opacity:1}50%{opacity:.4}}",
	"@media (prefers-reduced-motion: reduce){.nx-pulse{animation:none}}",
	".nx-close{width:22px;height:22px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;cursor:pointer;padding:0}",
	".nx-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-body{flex:1;min-height:0;overflow-y:auto;padding:0 14px 14px}",
	".nx-empty{padding:18px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}",
	".nx-empty-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}",
	".nx-empty-note{margin-top:2px;color:var(--dsw-alias-label-tertiary)}",
	".nx-section{padding:10px 0 11px;border-top:1px solid var(--dsw-alias-border-l1)}",
	".nx-section:first-child{border-top:none;padding-top:2px}",
	".nx-label{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}",
	".nx-section-body{display:flex;flex-direction:column;gap:3px}",
	".nx-value{font-size:12.5px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:6px;min-width:0}",
	".nx-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:0}",
	".nx-sub-inline{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
	".nx-muted{color:var(--dsw-alias-label-tertiary)}",
	".nx-ok{color:var(--dsw-alias-state-success-primary)}",
	".nx-warn{color:var(--dsw-alias-state-warn-primary)}",
	".nx-err{color:var(--dsw-alias-state-error-primary)}",
	".nx-model{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".nx-executor{min-width:0}",
	".nx-badge{font-size:9px;font-weight:700;letter-spacing:.08em;color:#fff;background:var(--dsw-alias-state-business-primary);border-radius:4px;padding:1px 5px;flex:none}",
	".nx-badge-warn{background:var(--dsw-alias-state-warn-primary)}",
	".nx-class{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:11px;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);border-radius:5px;padding:1px 6px}",
	".nx-task-row{display:flex;align-items:center;gap:6px}",
	".nx-task-id{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:12px;color:var(--dsw-alias-label-primary);font-weight:600;letter-spacing:.02em}",
	".nx-copy{width:18px;height:18px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:4px;cursor:pointer;padding:0}",
	".nx-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-copy-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}",
	".nx-task-desc{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
	".nx-attempt{align-items:baseline}",
	".nx-bar{height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin-top:5px}",
	".nx-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width 160ms ease}",
	".nx-checks{display:flex;flex-direction:column;gap:2px;margin-top:6px}",
	".nx-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}",
	".nx-check-glyph{width:13px;flex:none;font-size:10px;text-align:center}",
	".nx-check-pass{color:var(--dsw-alias-state-success-primary)}",
	".nx-check-fail{color:var(--dsw-alias-state-error-primary)}",
	".nx-check-skip{color:var(--dsw-alias-label-tertiary)}",
	".nx-check-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".nx-branch{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:11.5px}",
	".nx-diff{display:flex;gap:8px;margin-top:1px}",
	".nx-ins{color:var(--dsw-alias-state-success-primary)}",
	".nx-del{color:var(--dsw-alias-state-error-primary)}",
	".nx-foot{display:flex;flex-direction:column;gap:2px;padding:10px 0 2px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px}",
	".nx-toggle{width:26px;height:26px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0}",
	".nx-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-toggle-on{color:var(--dsw-alias-state-business-primary)}",
	".nx-toggle-on:hover{color:var(--dsw-alias-state-business-primary)}",
].join("");
//#endregion

//#region apply
/** Required client service: the UI slot registry. */
const inject = ["slots"];
function apply(ctx) {
	ctx.effect(() => {
		const tag = document.createElement("style");
		tag.dataset.plugin = "@nexus/controller";
		tag.dataset.pluginCss = "@nexus/controller/panel.css";
		tag.textContent = PANEL_CSS;
		document.head.appendChild(tag);
		return () => {
			tag.remove();
		};
	}, "nexus-controller: panel styles");
	// The controller UI lives in the ADDITIVE shell.overlay list seat as a
	// right-edge drawer. It deliberately does NOT register into `details`:
	// that seat is single-kind and owned by the native DetailsPanel, which
	// declares conversation.details.tool — a second registration at the same
	// priority is rejected, and a shadowing one would silently replace the
	// native tool-details panel.
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "nexus-controller",
		order: 100,
		label: "Controller",
	}, ControllerDrawer));
	// Additive per-session toggle in the session header action row.
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "nexus-controller",
		order: 90,
		label: "Controller",
	}, ControllerToggle));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.resolveDisplayState = resolveDisplayState;
exports.ControllerBody = ControllerBody;
return module.exports;
}
});
