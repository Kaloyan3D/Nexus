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
const ROOM_WIDTH = 600;
const ROOM_POLL_MS = 4000;
const ROOM_TABS = ["overview", "activity", "verification", "files"];

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

//#region polling (one shared 1.5s poll per session)
/**
 * ONE polling loop per session id, shared by every consumer (the drawer and
 * the composer executor pill): the first subscriber starts the loop, the
 * last one stops it. Compact polling stays lightweight — the drawer and the
 * pill never double-fetch the endpoint.
 */
const snapshotPolls = new Map(); // key -> { snapshot, failed, listeners, timer, inflight, started }
function controllerSnapshotKey(sessionId) {
	return String(sessionId || "");
}
function notifySnapshotListeners(key, entry) {
	for (const listener of [...entry.listeners]) {
		try { listener(entry.snapshot, entry.failed); } catch { /* never break the UI */ }
	}
}
function pollControllerSnapshot(key, entry) {
	if (entry.inflight || entry.cancelled) return;
	entry.inflight = true;
	fetch("./nexus/controller.json?session=" + encodeURIComponent(key), { cache: "no-store" })
		.then((response) => {
			if (!response.ok) throw new Error("controller state http " + response.status);
			return response.json();
		})
		.then((data) => {
			if (entry.cancelled) return;
			entry.snapshot = data;
			entry.failed = false;
			notifySnapshotListeners(key, entry);
		})
		.catch(() => {
			if (!entry.cancelled) {
				entry.failed = true;
				notifySnapshotListeners(key, entry);
			}
		})
		.finally(() => {
			entry.inflight = false;
		});
}
function ensureSnapshotPolling(key) {
	let entry = snapshotPolls.get(key);
	if (!entry) {
		entry = { snapshot: null, failed: false, listeners: new Set(), timer: null, inflight: false, started: false, cancelled: false };
		snapshotPolls.set(key, entry);
	}
	if (!entry.started) {
		entry.started = true;
		pollControllerSnapshot(key, entry);
		entry.timer = window.setInterval(() => pollControllerSnapshot(key, entry), POLL_MS);
	}
	return entry;
}
function stopSnapshotPolling(key, entry) {
	if (entry.timer !== null) { window.clearInterval(entry.timer); entry.timer = null; }
	entry.cancelled = true;
	snapshotPolls.delete(key);
}
function useControllerSnapshot(sessionId) {
	const key = controllerSnapshotKey(sessionId);
	const [state, setState] = react.useState({ snapshot: null, failed: false });
	react.useEffect(() => {
		const entry = ensureSnapshotPolling(key);
		const apply = () => setState({ snapshot: entry.snapshot, failed: entry.failed });
		entry.listeners.add(apply);
		apply();
		return () => {
			entry.listeners.delete(apply);
			if (entry.listeners.size === 0) stopSnapshotPolling(key, entry);
		};
	}, [key]);
	return state && typeof state === "object" ? state : { snapshot: null, failed: false };
}
//#endregion

//#region control-room state + polling (detail endpoint, open-only)
function readRoomOpenPref() {
	try { return window.localStorage.getItem("nexus.controller.room.open") === "1"; } catch { return false; }
}
function writeRoomOpenPref(open) {
	try {
		if (open) window.localStorage.setItem("nexus.controller.room.open", "1");
		else window.localStorage.removeItem("nexus.controller.room.open");
	} catch { /* localStorage unavailable: in-memory state still works */ }
}
function readRoomViewPref() {
	try {
		const value = window.localStorage.getItem("nexus.controller.room.view");
		return ROOM_TABS.includes(value) ? value : "overview";
	} catch { return "overview"; }
}
function writeRoomViewPref(view) {
	try { window.localStorage.setItem("nexus.controller.room.view", view); } catch { /* ignore */ }
}

/**
 * Detail snapshot for the Task Control Room. Polls /nexus/control-room.json
 * ONLY while enabled (the room is open) — the compact 1.5s path is untouched.
 */
function useDetailSnapshot(sessionId, enabled) {
	const [detail, setDetail] = react.useState(null);
	const [failed, setFailed] = react.useState(false);
	react.useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let timer = null;
		let inflight = false;
		const poll = async () => {
			if (inflight || cancelled) return;
			inflight = true;
			try {
				const response = await fetch("./nexus/control-room.json?session=" + encodeURIComponent(sessionId || ""), { cache: "no-store" });
				if (!response.ok) throw new Error("control room http " + response.status);
				const data = await response.json();
				if (cancelled) return;
				setDetail(data);
				setFailed(false);
			} catch {
				if (!cancelled) setFailed(true);
			} finally {
				inflight = false;
			}
		};
		poll();
		timer = window.setInterval(poll, ROOM_POLL_MS);
		return () => {
			cancelled = true;
			if (timer !== null) window.clearInterval(timer);
		};
	}, [sessionId, enabled]);
	return { detail, failed };
}

function formatTimeUtc(isoUtc) {
	if (!isoUtc) return null;
	const date = new Date(isoUtc);
	if (Number.isNaN(date.getTime())) return null;
	const pad = (n) => String(n).padStart(2, "0");
	return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

/** Routing-kind chip label (routing semantics, never model-name guessing). */
function routingKindLabel(kind) {
	if (kind === "primary") return "PRIMARY";
	if (kind === "review") return "REVIEW";
	if (kind === "escalation") return "ESCALATION";
	return null;
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
function ControllerBody({ snapshot, failed, running, pressure, onClose, onExpand }) {
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
					snapshot && snapshot.gate && snapshot.gate.status === "waiting" && react_jsx_runtime.jsx("span", {
						className: "nx-gate-badge",
						title: "Operator action required — open the Task Control Room",
						children: "OPERATOR",
					}),
					bound && onExpand && react_jsx_runtime.jsx("button", {
						type: "button",
						className: "nx-room-open",
						"aria-label": "Open task control room",
						title: "Open task control room",
						onClick: () => onExpand(),
						children: react_jsx_runtime.jsx("svg", {
							viewBox: "0 0 16 16",
							width: "13",
							height: "13",
							"aria-hidden": true,
							children: react_jsx_runtime.jsx("path", {
								d: "M6 3H3v3M10 3h3v3M6 13H3v-3M10 13h3v-3",
								stroke: "currentColor",
								strokeWidth: "1.4",
								strokeLinecap: "round",
							}),
						}),
					}),
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

//#region task control room (expanded drawer surface)
/**
 * Operator gate (TASK-0004). Buttons render ONLY from gate.allowedActions —
 * never inferred from the status. The browser POSTs identifiers only
 * (sessionId, gateId, actionId, requestId); the server validates currency,
 * advertising and replay idempotency. While a request is pending the buttons
 * disable, and a stale/conflicting response degrades to a quiet notice — it
 * can never crash the room.
 */
function GateActions({ gate, sessionId }) {
	const [pending, setPending] = react.useState(false);
	const [notice, setNotice] = react.useState(null);
	if (!gate || !gate.gateId) return null;
	const waiting = gate.status === "waiting";
	const allowed = waiting && Array.isArray(gate.allowedActions) ? gate.allowedActions : [];
	const postAction = react.useCallback((actionId) => {
		if (pending) return;
		setPending(true);
		setNotice(null);
		const requestId = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "req-" + Date.now() + "-" + Math.random().toString(36).slice(2));
		fetch("./nexus/gate-action.json", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, gateId: gate.gateId, actionId, requestId }),
			cache: "no-store",
		})
			.then((response) => response.json().catch(() => ({ ok: false, error: "gate-action-unreadable" })))
			.then((body) => {
				if (body && body.ok) {
					setNotice(null);
					// The snapshot refresh (mtime-keyed) picks up the new gate
					// and completion state on its next poll.
				} else if (body && body.replay) {
					setNotice("This action was already applied.");
				} else if (body && body.error === "gate-stale" || body && body.error === "gate-not-waiting") {
					setNotice("The gate changed — the refreshed state below is current.");
				} else if (body && body.error === "action-not-allowed" || body && body.error === "action-not-advertised") {
					setNotice("This action is not available for this gate.");
				} else if (body && body.error === "session-unbound") {
					setNotice("This session is no longer bound to the task.");
				} else {
					setNotice("The gate action could not be applied. Try again.");
				}
			})
			.catch(() => setNotice("The gate action could not be applied. Try again."))
			.finally(() => setPending(false));
	}, [pending, sessionId, gate]);
	if (!waiting) {
		return react_jsx_runtime.jsx("div", {
			className: "nx-gate-resolved",
			children: "Gate " + (gate.status || "resolved") + (gate.resolvedAtUtc ? " · " + formatTimeUtc(gate.resolvedAtUtc) : "") + (gate.actionId ? " · " + gate.actionId : ""),
		});
	}
	return react_jsx_runtime.jsxs("div", {
		className: "nx-gate",
		children: [
			react_jsx_runtime.jsxs("div", {
				className: "nx-gate-head",
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-gate-alert", children: "OPERATOR ACTION REQUIRED" }),
					react_jsx_runtime.jsx("span", { className: "nx-gate-reason", children: gate.reason || "review-required" }),
				],
			}),
			react_jsx_runtime.jsx("div", {
				className: "nx-gate-actions",
				children: allowed.map((actionId) => react_jsx_runtime.jsx("button", {
					type: "button",
					className: "nx-gate-btn nx-gate-btn-" + actionId,
					disabled: pending,
					"aria-label": "Gate action: " + actionId,
					onClick: () => postAction(actionId),
					children: actionId === "approve" ? "Approve" : actionId === "reject" ? "Reject" : actionId,
				}, actionId)),
			}),
			notice && react_jsx_runtime.jsx("div", { className: "nx-gate-notice", children: notice }),
		],
	});
}

function RoomOverview({ detail, running, failed }) {
	if (failed) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "Detail state unavailable" });
	}
	if (!detail) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "Loading…" });
	}
	if (!detail.binding || !detail.task) {
		return react_jsx_runtime.jsxs("div", {
			className: "nx-empty",
			children: [
				react_jsx_runtime.jsx("div", { className: "nx-empty-title", children: "No managed task" }),
				react_jsx_runtime.jsx("div", { className: "nx-empty-note", children: "This session is not bound to a controller task." }),
			],
		});
	}
	const task = detail.task;
	const execution = detail.execution;
	const reviews = detail.reviews;
	const failures = detail.failures;
	const controller = detail.controller;
	const displayState = resolveDisplayState(detail, running, failed);
	const showReasoningBadge = reasoningBadgeVisible(execution ? execution.model : null, execution ? execution.reasoning : null);
	const reviewModels = reviews && Array.isArray(reviews.decisions) && reviews.decisions.length > 0
		? reviews.decisions.map((decision) => decision.model).filter(Boolean)
		: [];
	const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
	const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
	const gates = detail.gates || null;
	const currentGate = gates && gates.current ? gates.current : null;
	const meta = [
		{ key: "Created", value: task.createdAtUtc },
		{ key: "Updated", value: task.updatedAtUtc },
		{ key: "Completed", value: task.completedAtUtc || "—" },
		{ key: "Base commit", value: task.baseCommit || "—" },
		{ key: "Worktree", value: task.worktree || "—" },
		{ key: "Attempts", value: attempts.length > 0 ? String(attempts[attempts.length - 1].sequence) : (task.attempt && task.attempt > 0 ? String(task.attempt) : "—") },
		{ key: "Controller", value: controller ? controller.status + (controller.pid ? " · pid " + controller.pid : "") : "—" },
	];
	return react_jsx_runtime.jsxs(react.Fragment, {
		children: [
			currentGate && react_jsx_runtime.jsx(GateActions, { gate: currentGate, sessionId: detail.binding.sessionId }),
			react_jsx_runtime.jsxs(Section, {
				label: "Status",
				children: [react_jsx_runtime.jsx(StatusPill, { state: displayState })],
			}),
			react_jsx_runtime.jsxs(Section, {
				label: "Attempt",
				children: latestAttempt
					? [
						react_jsx_runtime.jsx("div", { className: "nx-value", children: "Attempt " + latestAttempt.sequence + " · " + latestAttempt.status }),
						latestAttempt.startedAtUtc && react_jsx_runtime.jsx("div", {
							className: "nx-sub",
							children: "started " + formatTimeUtc(latestAttempt.startedAtUtc) + (latestAttempt.durationSeconds !== null && latestAttempt.durationSeconds !== undefined ? " · " + latestAttempt.durationSeconds + "s" : ""),
						}),
					]
					: [react_jsx_runtime.jsx("div", { className: "nx-value", children: "—" })],
			}),
			execution && react_jsx_runtime.jsxs(Section, {
				label: "Root Executor",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "nx-value nx-executor",
						children: [
							react_jsx_runtime.jsx("span", { className: "nx-model", children: execution.model || "—" }),
							showReasoningBadge && react_jsx_runtime.jsx("span", { className: "nx-badge", children: execution.reasoning.toUpperCase() }),
						],
					}),
					react_jsx_runtime.jsx("div", { className: "nx-sub", children: execution.provider || "—" }),
					react_jsx_runtime.jsxs("div", { className: "nx-sub", children: ["Execution class ", react_jsx_runtime.jsx("code", { className: "nx-class", children: execution.class || "—" })] }),
					execution.escalatedFrom ? react_jsx_runtime.jsx("div", { className: "nx-sub nx-muted", children: "Escalated from " + execution.escalatedFrom }) : null,
				],
			}),
			react_jsx_runtime.jsxs(Section, {
				label: "Review",
				children: [
					react_jsx_runtime.jsx("div", { className: "nx-value", children: (reviews && reviews.reviewRequired ? "Required" : "Not required") + " · Codex calls " + (reviews ? formatCount(reviews.codexCalls) : "—") }),
					reviewModels.length > 0 && react_jsx_runtime.jsx("div", { className: "nx-sub", children: reviewModels.join(", ") }),
				],
			}),
			react_jsx_runtime.jsxs(Section, {
				label: "Task",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "nx-value nx-task-row",
						children: [
							react_jsx_runtime.jsx("span", { className: "nx-task-id", children: task.taskId }),
							react_jsx_runtime.jsx(CopyButton, { text: task.taskId, label: "Copy task id" }),
						],
					}),
					task.description && react_jsx_runtime.jsx("div", { className: "nx-task-desc", title: task.description, children: task.description }),
					react_jsx_runtime.jsx("div", { className: "nx-meta-grid", children: meta.map((item) => react_jsx_runtime.jsxs("div", {
						className: "nx-meta-cell",
						children: [
							react_jsx_runtime.jsx("div", { className: "nx-meta-key", children: item.key }),
							react_jsx_runtime.jsx("div", { className: "nx-meta-val", title: item.value || "", children: item.value || "—" }),
						],
					}, item.key)) }),
				],
			}),
			react_jsx_runtime.jsxs(Section, {
				label: "Failure",
				children: failures && failures.current
					? [
						react_jsx_runtime.jsxs("div", {
							className: "nx-value nx-failure-row",
							children: [
								react_jsx_runtime.jsx("span", { className: "nx-failure-sig", children: failures.current }),
								react_jsx_runtime.jsx(CopyButton, { text: failures.current, label: "Copy failure signature" }),
							],
						}),
						typeof failures.sameFailureCount === "number" && failures.sameFailureCount > 0 ? react_jsx_runtime.jsx("div", { className: "nx-sub", children: "same failure seen " + failures.sameFailureCount + " times" }) : null,
					]
					: [react_jsx_runtime.jsx("div", { className: "nx-sub", children: "No failure recorded" })],
			}),
		],
	});
}

function activityKindTitle(kind) {
	switch (kind) {
		case "attempt-started": return "Attempt started";
		case "attempt-failed": return "Attempt failed";
		case "attempt-finished": return "Attempt finished";
		case "verification-started": return "Verification started";
		case "verification-finished": return "Verification finished";
		case "review-requested": return "Review requested";
		case "review-completed": return "Review completed";
		case "gate-created": return "Operator gate opened";
		case "gate-resolved": return "Gate resolved";
		case "task-completed": return "Task completed";
		case "routing": return "Routed";
		case "lifecycle": return "Lifecycle";
		default: return kind || "Event";
	}
}

function RoomActivity({ detail }) {
	if (!detail || !detail.binding) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "No managed task" });
	}
	// TASK-0004: the Activity tab shows ONLY real recorded events from the
	// controller's activity timeline (attempts, verification, reviews, gates,
	// routing, lifecycle). The derivation below is the legacy fallback for
	// snapshots that predate the timeline.
	const entries = [];
	if (Array.isArray(detail.activity) && detail.activity.length > 0) {
		for (const event of detail.activity) {
			if (event.kind === "routing") {
				const chip = event.chip || "PRIMARY";
				const title = chip === "REVIEW" ? "Review requested" : chip === "ESCALATION" ? "Escalated" : "Routed";
				entries.push({ at: event.atUtc, title, sub: event.sub || event.detail || null, chip });
			} else if (event.kind === "lifecycle") {
				const title = event.detail === "task-created" ? "Task created" : event.detail === "execution-class-selected" ? "Execution class selected" : activityKindTitle(event.kind);
				entries.push({ at: event.atUtc, title, sub: event.sub || null, chip: null });
			} else {
				entries.push({ at: event.atUtc, title: activityKindTitle(event.kind), sub: event.detail || null, chip: null });
			}
		}
	} else {
		for (const event of detail.lifecycle || []) {
			if (event.kind === "task-created") {
				entries.push({ at: event.timestampUtc, title: "Task created", sub: null, chip: null });
			} else if (event.kind === "execution-class-selected") {
				entries.push({ at: event.timestampUtc, title: "Execution class selected", sub: (event.executionClass || "—") + (event.reason ? " — " + event.reason : ""), chip: null });
			}
		}
		for (const record of detail.routingHistory || []) {
			const chip = routingKindLabel(record.kind);
			if (record.kind === "review") {
				entries.push({ at: record.timestampUtc, title: "Review requested", sub: (record.executionClass || "—") + (record.model ? " · " + record.model : ""), chip });
			} else if (record.kind === "escalation") {
				entries.push({ at: record.timestampUtc, title: "Escalated", sub: (record.executionClass || "—") + (record.escalatedFrom ? " from " + record.escalatedFrom : ""), chip });
			} else {
				entries.push({ at: record.timestampUtc, title: "Routed", sub: (record.executionClass || "—") + (record.model ? " · " + record.model : "") + (record.reasoning ? " · " + record.reasoning : ""), chip });
			}
		}
		for (const attempt of detail.attempts || []) {
			if (attempt.status === "failed") {
				entries.push({ at: attempt.startedAtUtc || attempt.failedAtUtc, title: "Attempt " + attempt.sequence + " failed", sub: attempt.failureSignature || null, chip: null });
			} else {
				entries.push({ at: attempt.startedAtUtc, title: "Attempt " + attempt.sequence + " started", sub: attempt.executionClass || null, chip: null });
			}
		}
	}
	entries.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
	if (entries.length === 0) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "No recorded activity for this task" });
	}
	return react_jsx_runtime.jsx("div", {
		className: "nx-timeline",
		children: entries.map((entry) => react_jsx_runtime.jsxs("div", {
			className: "nx-tl-row",
			children: [
				react_jsx_runtime.jsx("div", { className: "nx-tl-time", children: formatTimeUtc(entry.at) || "—" }),
				react_jsx_runtime.jsxs("div", {
					className: "nx-tl-body",
					children: [
						react_jsx_runtime.jsxs("div", {
							className: "nx-tl-title",
							children: [
								entry.chip && react_jsx_runtime.jsx("span", { className: "nx-kind-chip", children: entry.chip }),
								entry.title,
							],
						}),
						entry.sub && react_jsx_runtime.jsx("div", { className: "nx-tl-sub", children: entry.sub }),
					],
				}),
			],
		}, entry.at + entry.title)),
	});
}

function RoomVerification({ detail }) {
	if (!detail || !detail.binding) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "No managed task" });
	}
	const verification = detail.verification;
	if (!verification || (verification.status === "not-run" && (!verification.checks || verification.checks.length === 0))) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "Verification not run" });
	}
	return react_jsx_runtime.jsxs(react.Fragment, {
		children: [
			// TASK-0004.1: unmistakable overall status — never counts-only.
			react_jsx_runtime.jsxs("div", {
				className: "nx-verify-banner " + (verification.status === "failed" ? "nx-verify-fail" : "nx-verify-pass"),
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-verify-banner-label", children: verification.status === "failed" ? "FAILED" : "PASSED" }),
					react_jsx_runtime.jsx("span", { className: "nx-verify-banner-counts", children: formatCount(verification.passed) + " passed · " + formatCount(verification.failed) + " failed" + (verification.skipped > 0 ? " · " + formatCount(verification.skipped) + " skipped" : "") }),
				],
			}),
			// TASK-0004: verification is per-attempt with producer timestamps;
			// durations are derived and omitted when unavailable.
			(verification.attempt || verification.startedAtUtc || verification.finishedAtUtc) && react_jsx_runtime.jsx("div", {
				className: "nx-sub",
				children: [
					verification.attempt ? "Attempt " + verification.attempt : "",
					verification.startedAtUtc ? (verification.attempt ? " · " : "") + "started " + formatTimeUtc(verification.startedAtUtc) : "",
					verification.finishedAtUtc ? " · finished " + formatTimeUtc(verification.finishedAtUtc) : "",
					verification.durationSeconds !== null && verification.durationSeconds !== undefined ? " · " + verification.durationSeconds + "s" : "",
				].filter(Boolean).join(""),
			}),
			react_jsx_runtime.jsx("div", {
				className: "nx-checks",
				children: (verification.checks || []).map((check) => {
					const isFailed = check.status === "FAIL";
					// TASK-0004.1: failed checks show FAIL + exit code + duration
					// inline; exact start/finish timestamps and the command live
					// in the row tooltip (never invented when absent).
					const tooltip = [
						check.command ? "command: " + check.command : null,
						check.startedAtUtc ? "started " + check.startedAtUtc : null,
						check.finishedAtUtc ? "finished " + check.finishedAtUtc : null,
					].filter(Boolean).join(" · ");
					return react_jsx_runtime.jsxs("div", {
						className: "nx-check" + (isFailed ? " nx-check-failed" : ""),
						title: tooltip || undefined,
						children: [
							react_jsx_runtime.jsx("span", { className: "nx-check-glyph nx-check-" + (check.status === "PASS" ? "pass" : check.status === "FAIL" ? "fail" : "skip"), children: check.status === "PASS" ? "✓" : check.status === "FAIL" ? "✕" : "–" }),
							react_jsx_runtime.jsx("span", { className: "nx-check-name", title: check.name, children: check.name }),
							isFailed && react_jsx_runtime.jsx("span", { className: "nx-check-fail-tag", children: "FAIL" }),
							isFailed && check.exitCode !== null && check.exitCode !== undefined && react_jsx_runtime.jsx("span", { className: "nx-check-exit", children: "exit " + check.exitCode }),
							check.durationSeconds !== null && check.durationSeconds !== undefined && react_jsx_runtime.jsx("span", { className: "nx-check-duration", children: check.durationSeconds + "s" }),
							check.evidence && react_jsx_runtime.jsx("span", { className: "nx-check-evidence", title: check.evidence, children: check.evidence }),
						],
					}, check.name);
				}),
			}),
			verification.artifactPresent && react_jsx_runtime.jsxs("div", {
				className: "nx-foot",
				children: [
					react_jsx_runtime.jsx("div", { className: "nx-muted", children: "Artifact " + verification.artifactPath }),
					react_jsx_runtime.jsx(CopyButton, { text: verification.artifactPath, label: "Copy artifact path" }),
				],
			}),
		],
	});
}

function RoomFiles({ detail }) {
	if (!detail || !detail.binding) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "No managed task" });
	}
	const git = detail.git;
	if (!git || !git.files) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: "Git unavailable" });
	}
	const files = Array.isArray(git.files.files) ? git.files.files : [];
	if (files.length === 0) {
		return react_jsx_runtime.jsx("div", { className: "nx-empty", children: git.files.branch ? "Working tree clean · " + git.files.branch : "Working tree clean" });
	}
	return react_jsx_runtime.jsxs(react.Fragment, {
		children: [
			react_jsx_runtime.jsxs("div", {
				className: "nx-value",
				children: [
					react_jsx_runtime.jsx("span", { children: git.files.branch || "—" }),
					react_jsx_runtime.jsx("span", { className: "nx-sub-inline", children: " · " + formatCount(files.length) + " files" }),
				],
			}),
			react_jsx_runtime.jsx("div", {
				className: "nx-file-list",
				children: files.map((file) => react_jsx_runtime.jsxs("div", {
					className: "nx-file-row",
					children: [
						react_jsx_runtime.jsx("span", { className: "nx-file-status", children: file.status || "??" }),
						react_jsx_runtime.jsx("span", { className: "nx-file-path", title: file.path, children: file.path }),
						typeof file.insertions === "number" && react_jsx_runtime.jsxs("span", { className: "nx-file-diff", children: [react_jsx_runtime.jsx("span", { className: "nx-ins", children: "+" + formatCount(file.insertions) }), react_jsx_runtime.jsx("span", { className: "nx-del", children: " −" + formatCount(file.deletions) })] }),
					],
				}, file.path)),
			}),
		],
	});
}

function ControlRoom({ sessionId, running, onClose }) {
	const { detail, failed } = useDetailSnapshot(sessionId, true);
	const [view, setView] = react.useState(() => readRoomViewPref());
	const selectView = react.useCallback((next) => {
		setView(next);
		writeRoomViewPref(next);
	}, []);
	const task = detail && detail.binding && detail.binding.taskId ? detail.binding.taskId : null;
	return react_jsx_runtime.jsxs("div", {
		className: "nx-panel nx-room",
		"data-nexus-control-room": true,
		children: [
			react_jsx_runtime.jsxs("div", {
				className: "nx-room-head",
				children: [
					react_jsx_runtime.jsx("div", { className: "nx-room-title", children: "TASK CONTROL ROOM" }),
					task && react_jsx_runtime.jsx("div", { className: "nx-room-task", title: task, children: task }),
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "nx-close",
						"aria-label": "Collapse task control room",
						title: "Collapse to controller",
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
				className: "nx-room-tabbar",
				role: "tablist",
				children: ROOM_TABS.map((tab) => react_jsx_runtime.jsx("button", {
					type: "button",
					role: "tab",
					"aria-selected": view === tab,
					className: "nx-room-tab" + (view === tab ? " nx-room-tab-on" : ""),
					onClick: () => selectView(tab),
					children: tab.charAt(0).toUpperCase() + tab.slice(1),
				}, tab)),
			}),
			react_jsx_runtime.jsx("div", {
				className: "nx-body nx-room-body",
				children: view === "overview"
					? react_jsx_runtime.jsx(RoomOverview, { detail, running, failed })
					: view === "activity"
						? react_jsx_runtime.jsx(RoomActivity, { detail })
						: view === "verification"
							? react_jsx_runtime.jsx(RoomVerification, { detail })
							: react_jsx_runtime.jsx(RoomFiles, { detail }),
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
	const [roomOpen, setRoomOpenState] = react.useState(() => readRoomOpenPref());
	const setRoomOpen = react.useCallback((value) => {
		setRoomOpenState(value);
		writeRoomOpenPref(value);
	}, []);

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
			if (event.key === "Escape") {
				// Escape closes the expanded Control Room first, then the drawer.
				if (roomOpen) setRoomOpen(false);
				else close();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, roomOpen, close, setRoomOpen]);

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
	if (roomOpen && bound) {
		return react_jsx_runtime.jsx("div", {
			className: "nx-drawer nx-drawer--room",
			"data-nexus-drawer": true,
			"aria-label": "Task control room",
			style: { width: "min(" + ROOM_WIDTH + "px, calc(100vw - 24px))" },
			children: react_jsx_runtime.jsx(ControlRoom, {
				sessionId,
				running,
				onClose: () => setRoomOpen(false),
			}),
		});
	}
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
			onExpand: () => setRoomOpen(true),
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

//#region composer executor pill
/**
* Additive composer tool-row pills (conversation.input.right) that separate
* the two model values the composer shows (TASK-0003.3):
*
*   RUNNING    — the EFFECTIVE task executor assigned by Nexus deterministic
*                routing (the authoritative routing decision; read-only).
*   PREFERRED  — the session PREFERENCE (agent-default-model written by the
*                mode seat from the preset rootExecutor; the same value the
*                upstream model chip displays).
*
* Model identity and reasoning effort are SEPARATE (TASK-0003.3a): the
* base display model is "DeepSeek V4 Flash" (modelId deepseek-v4-flash) and
* the effort renders as its own badge (HIGH / MAX) — the settings model
* names no longer embed the tier. In Normal Engineering the preference is
* DeepSeek V4 Flash · MAX while deepseek_normal routes to the High tier
* (flash-high-direct / high): the preference is a ceiling, not a promise.
* The pills make that explicit next to the chip; both are read-only and
* never change the session model, the routing records, or the agent
* isolation. PREFERRED is hidden only when it is fully redundant (no
* effective executor → only PREFERRED shows; identical identity AND effort
* → only RUNNING shows). Below 480px the pills collapse to their compact
* form [RUNNING · HIGH] / [PREFERRED · MAX]; the tooltip always carries the
* full model name.
*/
function executorChipContent(snapshot) {
	if (!snapshot || snapshot.error) return null;
	const modelName = snapshot.execution && typeof snapshot.execution.model === "string" && snapshot.execution.model ? snapshot.execution.model : null;
	const effectiveReasoning = snapshot.execution && typeof snapshot.execution.reasoning === "string" && snapshot.execution.reasoning ? snapshot.execution.reasoning : null;
	const preference = snapshot.preference && typeof snapshot.preference.label === "string" && snapshot.preference.label ? snapshot.preference.label : null;
	const preferenceReasoning = snapshot.preference && typeof snapshot.preference.reasoning === "string" && snapshot.preference.reasoning ? snapshot.preference.reasoning : null;
	const reasoning = reasoningBadgeVisible(modelName, effectiveReasoning) ? effectiveReasoning : null;
	// PREFERRED adds information only when it differs from RUNNING (or when
	// there is no RUNNING value at all); equal values must not create noise.
	// Model identity and effort are separate (TASK-0003.3a): the same base
	// model at a different effort is a real difference (PREFERRED MAX vs
	// RUNNING HIGH) and keeps both chips; identical identity AND effort
	// collapses to the single RUNNING chip.
	const showPreference = preference !== null && (
		modelName === null ||
		preference.toUpperCase() !== modelName.toUpperCase() ||
		String(preferenceReasoning || '').toUpperCase() !== String(effectiveReasoning || '').toUpperCase()
	);
	if (modelName === null && !showPreference) return null;
	return {
		modelName,
		reasoning,
		preference: showPreference ? preference : null,
		preferenceReasoning: showPreference && reasoningBadgeVisible(preference, preferenceReasoning) ? preferenceReasoning : null,
	};
}
function ExecutorPill({ content }) {
	if (!content) return null;
	const chips = [];
	if (content.modelName) {
		const effort = content.reasoning ? String(content.reasoning).toUpperCase() : null;
		chips.push(react_jsx_runtime.jsx("span", {
			className: "nx-executor-pill",
			"data-nexus-executor": true,
			title: "RUNNING — " + content.modelName + (effort ? " · " + effort : "") + " — the model actually executing this task, assigned by Nexus deterministic routing. Read-only; it never changes the session model.",
			children: [
				react_jsx_runtime.jsx("span", { className: "nx-executor-pill-label", children: "RUNNING" }, "label"),
				react_jsx_runtime.jsx("span", { className: "nx-executor-pill-model", children: content.modelName }, "model"),
				effort ? react_jsx_runtime.jsx("span", { className: "nx-executor-pill-effort", children: effort }, "effort") : null,
			],
		}, "running"));
	}
	if (content.preference) {
		const effort = content.preferenceReasoning ? String(content.preferenceReasoning).toUpperCase() : null;
		const detail = "Preferred model: " + content.preference + (effort ? " · Maximum effort: " + effort : "") + ". Nexus may route individual tasks below this ceiling according to the active engineering policy.";
		chips.push(react_jsx_runtime.jsx("span", {
			className: "nx-executor-pill nx-executor-pill-pref",
			"data-nexus-preferred": true,
			title: detail,
			children: [
				react_jsx_runtime.jsx("span", { className: "nx-executor-pill-label", children: "PREFERRED" }, "label"),
				react_jsx_runtime.jsx("span", { className: "nx-executor-pill-model", children: content.preference }, "model"),
				effort ? react_jsx_runtime.jsx("span", { className: "nx-executor-pill-effort", children: effort }, "effort") : null,
			],
		}, "preferred"));
	}
	if (chips.length === 0) return null;
	return react_jsx_runtime.jsx("span", { className: "nx-executor-pills", children: chips });
}
function ExecutorChip({ session }) {
	const sessionId = session && typeof session.sessionId === "string" ? session.sessionId : null;
	const { snapshot } = useControllerSnapshot(sessionId);
	return react_jsx_runtime.jsx(ExecutorPill, { content: executorChipContent(snapshot) });
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
const GATE_CSS = [
	".nx-gate{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #d97706;border-radius:6px;background:var(--dsw-alias-bg-l2);margin-bottom:10px}",
	".nx-gate-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".nx-gate-alert{font-size:11px;font-weight:700;letter-spacing:.08em;color:#d97706}",
	".nx-gate-reason{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
	".nx-gate-actions{display:flex;gap:8px}",
	".nx-gate-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:600;padding:4px 12px;border-radius:5px;cursor:pointer}",
	".nx-gate-btn:disabled{opacity:.45;cursor:default}",
	".nx-gate-btn-approve{border-color:#16a34a;color:#16a34a}",
	".nx-gate-btn-approve:hover:not(:disabled){background:rgba(22,163,74,.12)}",
	".nx-gate-btn-reject{border-color:#dc2626;color:#dc2626}",
	".nx-gate-btn-reject:hover:not(:disabled){background:rgba(220,38,38,.12)}",
	".nx-gate-notice{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
	".nx-gate-resolved{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:6px 0 10px}",
	".nx-gate-badge{font-size:9px;font-weight:700;letter-spacing:.08em;color:#d97706;border:1px solid rgba(217,119,6,.5);border-radius:4px;padding:1px 5px;margin-left:6px}",
	".nx-check-duration{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-left:6px;flex:none}",
];

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
	".nx-verify-banner{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-radius:6px;margin-bottom:8px;background:var(--dsw-alias-interactive-bg-hover)}",
	".nx-verify-banner-label{font-weight:700;letter-spacing:.08em;font-size:12px}",
	".nx-verify-pass .nx-verify-banner-label{color:var(--dsw-alias-state-success-primary)}",
	".nx-verify-fail .nx-verify-banner-label{color:var(--dsw-alias-state-error-primary)}",
	".nx-verify-banner-counts{color:var(--dsw-alias-label-tertiary);font-size:11px}",
	".nx-check-failed{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:4px}",
	".nx-check-fail-tag{color:var(--dsw-alias-state-error-primary);font-weight:700;font-size:10px;letter-spacing:.05em}",
	".nx-check-exit{color:var(--dsw-alias-state-warn-primary);font-size:10.5px;font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)}",
	".nx-branch{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:11.5px}",
	".nx-diff{display:flex;gap:8px;margin-top:1px}",
	".nx-ins{color:var(--dsw-alias-state-success-primary)}",
	".nx-del{color:var(--dsw-alias-state-error-primary)}",
	".nx-foot{display:flex;flex-direction:column;gap:2px;padding:10px 0 2px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px}",
	".nx-toggle{width:26px;height:26px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0}",
	".nx-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-toggle-on{color:var(--dsw-alias-state-business-primary)}",
	".nx-toggle-on:hover{color:var(--dsw-alias-state-business-primary)}",
	".nx-room-open{width:26px;height:26px;display:grid;place-items:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0;margin-left:auto}",
	".nx-room-open:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-room{display:flex;flex-direction:column;height:100%}",
	".nx-room-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;flex:none}",
	".nx-room-title{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-primary)}",
	".nx-room-task{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px}",
	".nx-room-tabbar{display:flex;gap:2px;padding:0 14px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}",
	".nx-room-tab{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer}",
	".nx-room-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".nx-room-tab-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}",
	".nx-room-body{padding-top:10px}",
	".nx-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:8px}",
	".nx-meta-key{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
	".nx-meta-val{font-size:11px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".nx-timeline{display:flex;flex-direction:column;gap:0;padding:2px 0}",
	".nx-tl-row{display:flex;gap:10px;padding:6px 0;border-left:1px solid var(--dsw-alias-border-l1);margin-left:4px;padding-left:12px}",
	".nx-tl-time{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:62px;flex:none}",
	".nx-tl-body{min-width:0}",
	".nx-tl-title{font-size:11.5px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
	".nx-tl-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".nx-kind-chip{font-size:9px;font-weight:700;letter-spacing:.06em;padding:1px 5px;border-radius:4px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}",
	".nx-failure-row{display:flex;align-items:center;gap:6px;min-width:0}",
	".nx-failure-sig{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".nx-check-evidence{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:10px;color:var(--dsw-alias-label-tertiary)}",
	".nx-file-list{display:flex;flex-direction:column;gap:4px;margin-top:8px}",
	".nx-file-row{display:flex;align-items:baseline;gap:8px;min-width:0}",
	".nx-file-status{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary);width:24px;flex:none}",
	".nx-file-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:11px;flex:1;min-width:0}",
	".nx-file-diff{font-family:var(--ds-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);font-size:10.5px;flex:none}",
	".nx-muted{color:var(--dsw-alias-label-tertiary)}",
	".nx-executor-pill{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:min(260px,40vw);padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-elevated);white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:26px}",
	".nx-executor-pill-label{font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary);flex:none}",
	".nx-executor-pill-model{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}",
	".nx-executor-pill-effort{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);flex:none}",
	".nx-executor-pills{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0}",
	".nx-executor-pill-pref{background:transparent;border-color:var(--dsw-alias-border-l1)}",
	".nx-executor-pill-pref .nx-executor-pill-label{color:var(--dsw-alias-label-tertiary)}",
	"@media (max-width: 480px){.nx-executor-pill-model{display:none}}",
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
		tag.textContent = GATE_CSS.join("") + PANEL_CSS;
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
	// Additive composer tool-row pills (right of the upstream model chip):
	// RUNNING names the EFFECTIVE routed executor; PREFERRED labels the
	// session preference whenever it differs (or no executor is routed), so
	// the preference chip is never read as the active model. The seat is
	// additive-list and unoccupied upstream; both pills are read-only display.
	ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: "nexus-controller",
		order: 90,
		label: "Task executor",
	}, ExecutorChip));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
// Testability face: the snapshot hook itself, so deterministic suites can
// assert it never returns undefined (TASK-0003.1b regression — the shared
// poll's bare listener() call once collapsed the hook return to undefined).
exports.useControllerSnapshot = useControllerSnapshot;
exports.resolveDisplayState = resolveDisplayState;
exports.ControllerBody = ControllerBody;
exports.ControlRoom = ControlRoom;
exports.ROOM_TABS = ROOM_TABS;
exports.executorChipContent = executorChipContent;
exports.ExecutorPill = ExecutorPill;
exports.ExecutorChip = ExecutorChip;
exports.GateActions = GateActions;
exports.activityKindTitle = activityKindTitle;
return module.exports;
}
});
