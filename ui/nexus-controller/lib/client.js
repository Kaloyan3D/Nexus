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
const ROOM_TABS = ["overview", "activity", "verification", "files", "engineering"];

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
// Phase 2: presentation is generic — the execution class describes semantics
// and the actual model/provider come from the routing record. Legacy class
// names (deepseek_normal & co.) stay readable and display through the same
// canonical labels.
const LEGACY_CLASS_ALIASES = { deepseek_normal: "engineer_normal", deepseek_deep: "engineer_deep", codex_review: "reviewer", codex_solve: "solver" };
const CLASS_DISPLAY = { deterministic: "Deterministic", engineer_normal: "Engineer Normal", engineer_deep: "Engineer Deep", reviewer: "Independent Review", solver: "Solve" };
const ROLE_DISPLAY = { primaryEngineer: "Primary Engineer", deepEngineer: "Deep Engineer", reviewer: "Reviewer", solver: "Solver", fallback: "Fallback" };
function canonicalClass(value) {
	if (typeof value !== "string" || value === "") return value;
	const key = value.trim().toLowerCase();
	return LEGACY_CLASS_ALIASES[key] || key;
}
function classDisplay(value) {
	return CLASS_DISPLAY[canonicalClass(value)] || (typeof value === "string" && value !== "" ? value : "—");
}
function roleDisplay(value) {
	return ROLE_DISPLAY[value] || value || null;
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
												react_jsx_runtime.jsx("div", { className: "nx-value", children: react_jsx_runtime.jsx("code", { className: "nx-class", children: classDisplay(execution.class) }) }),
												roleDisplay(execution.role) && react_jsx_runtime.jsx("div", { className: "nx-sub", children: "Role: " + roleDisplay(execution.role) }),
												execution.profile && react_jsx_runtime.jsx("div", { className: "nx-sub", children: "Profile: " + (execution.profileDisplayName || execution.profile) }),
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
											label: "Reviews",
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
		{ key: "Preferred profile", value: detail.preferredProfile ? (detail.preferredProfile.displayName || detail.preferredProfile.id) : "—" },
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
					react_jsx_runtime.jsxs("div", { className: "nx-sub", children: ["Execution class ", react_jsx_runtime.jsx("code", { className: "nx-class", children: classDisplay(execution.class) })] }),
					roleDisplay(execution.role) && react_jsx_runtime.jsx("div", { className: "nx-sub", children: "Role: " + roleDisplay(execution.role) }),
					execution.profile && react_jsx_runtime.jsx("div", { className: "nx-sub", children: "Profile: " + (execution.profileDisplayName || execution.profile) }),
					execution.escalatedFrom ? react_jsx_runtime.jsx("div", { className: "nx-sub nx-muted", children: "Escalated from " + execution.escalatedFrom }) : null,
				],
			}),
			react_jsx_runtime.jsxs(Section, {
				label: "Review",
				children: [
					react_jsx_runtime.jsx("div", { className: "nx-value", children: (reviews && reviews.reviewRequired ? "Required" : "Not required") + " · Review calls " + (reviews ? formatCount(reviews.codexCalls) : "—") }),
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

/**
* Phase M1.1: ONE authoritative user-facing catalog rule, shared by the
* dropdown, the initial profile choice, entry lookup, and readiness.
*
* CASE A — legacy host: the state has NO `nexusProfiles` property at all.
*          The Nexus Profile contract is absent, so the legacy Dual-only
*          `profiles` list stays the user-facing catalog.
* CASE B — current host: the property EXISTS. An empty array is the host
*          explicitly reporting an unavailable/invalid Nexus catalog —
*          it is authoritative and must NEVER fall back to `profiles`
*          (fail closed; the editor shows configuration unavailable).
*/
function hasNexusCatalogContract(state) {
	return !!state && typeof state === "object" && Object.prototype.hasOwnProperty.call(state, "nexusProfiles");
}

function userFacingProfiles(state) {
	if (!state || typeof state !== "object") return [];
	if (hasNexusCatalogContract(state)) {
		return Array.isArray(state.nexusProfiles) ? state.nexusProfiles : [];
	}
	return Array.isArray(state.profiles) ? state.profiles : [];
}

/** CASE B fail-closed signal: the Nexus contract exists but the catalog is empty. */
function isCatalogUnavailable(state) {
	return hasNexusCatalogContract(state) && userFacingProfiles(state).length === 0;
}

/**
* Initial profile choice for the editor form: the preferred profile when
* the authoritative user-facing catalog knows it, otherwise the FIRST
* catalog entry. With the Nexus contract present this is the Nexus catalog
* — never the legacy Dual list; legacy hosts keep the old behavior.
*/
function initialProfileChoice(state) {
	const catalog = userFacingProfiles(state);
	if (!Array.isArray(catalog) || catalog.length === 0) return null;
	const preferred = state && state.preferredProfile && state.preferredProfile.id ? String(state.preferredProfile.id) : null;
	const preferredKnown = catalog.some((p) => p && String(p.id) === preferred);
	return preferredKnown ? preferred : String(catalog[0].id);
}

const ENGINEERING_ROLES = ["primaryEngineer", "deepEngineer", "reviewer", "solver", "fallback"];
const ENGINEERING_ROLE_LABELS = {
	primaryEngineer: "Primary Engineer",
	deepEngineer: "Deep Engineer",
	reviewer: "Reviewer",
	solver: "Solver",
	fallback: "Fallback",
};

/**
* Shared Engineering editor state — ONE implementation of profile select,
* the built-in→Custom auto-switch, save (select | save-custom), and refresh.
* Both surfaces reuse it: the Control Room Engineering tab and the composer
* Engineering popover read/write the same endpoints
* (GET /nexus/engineering-profile.json, POST /nexus/engineering-profile-action.json),
* so the two surfaces always agree. No model compatibility logic lives here:
* roleRequirements/roleModels arrive resolved from the controller.
*/
/**
 * Phase M2.1 (TASK-0038): the editor's enable/load lifecycle is keyed on the
 * ENGINEERING SURFACE being enabled — not on a session existing. GET
 * /nexus/engineering-profile.json is GLOBAL Engineering Profile configuration
 * (catalog, registry, preferred profile), so the composer editor loads while
 * the user is still on the new-session hero screen (no sessionId yet). The
 * session id stays optional: it only names the session on a save action and
 * keeps the historical refetch-on-session-change behavior. Callers that pass
 * no `enabled` (the Control Room tab) keep the always-enabled behavior.
 */
/**
 * The load gate of the editor effect, exported for deterministic regression
 * coverage: the global profile state loads exactly when the Engineering
 * surface is enabled — session existence is never consulted (TASK-0038 G).
 */
function engineeringEditorLoadGate(surfaceEnabled, refresh) {
	if (!surfaceEnabled) return false;
	if (typeof refresh !== "function") return false;
	refresh();
	return true;
}

function useEngineeringEditor(sessionId, enabled) {
	const [state, setState] = react.useState(null);
	const [failed, setFailed] = react.useState(false);
	const [profileId, setProfileId] = react.useState(null);
	const [roles, setRoles] = react.useState(null);
	const [notice, setNotice] = react.useState(null);
	const [noticeTone, setNoticeTone] = react.useState("ok");
	const [saving, setSaving] = react.useState(false);
	const [dirty, setDirty] = react.useState(false);
	const [fetchedAt, setFetchedAt] = react.useState(0);

	const refresh = react.useCallback((then) => {
		fetch("./nexus/engineering-profile.json", { cache: "no-store" })
			.then((response) => {
				if (!response.ok) throw new Error("Engineering configuration unavailable");
				return response.json();
			})
			.then((data) => {
				if (!data || !Array.isArray(data.profiles)) throw new Error("Invalid engineering configuration");
				setState(data);
				setFailed(false);
				setFetchedAt(Date.now());
				// Phase M3: keep the shared engine mapping in lockstep with the
				// authoritative editor document (same fetch, same truth).
				publishNexusEngineState(data);
				if (then) then(data);
			})
			.catch(() => setFailed(true));
	}, []);

	const surfaceEnabled = enabled !== false;
	react.useEffect(() => {
		engineeringEditorLoadGate(surfaceEnabled, refresh);
	}, [surfaceEnabled, sessionId, refresh]);

	// initialize the form once state arrives (or after a save refreshes it)
	react.useEffect(() => {
		// Phase M1.1: the authoritative user-facing catalog (the Nexus Profile
		// contract when present, the legacy Dual list only on old hosts) decides
		// both the preferred-profile lookup and the initial fallback choice.
		const initialId = initialProfileChoice(state);
		if (!initialId) return;
		setProfileId(initialId);
		setRoles(bindingsFor(initialId));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state]);

	function bindingsFor(id) {
		if (!state) return null;
		const profile = state.profiles.find((p) => p && String(p.id) === id);
		if (!profile) return null;
		if (id === "custom") {
			// seed the operator's custom form from the last saved bindings,
			// falling back to the current built-in bindings as a baseline
			if (state.customRoles) return deepCloneRoles(state.customRoles);
			const current = state.profiles.find((p) => p && p.id !== "custom");
			return current && current.roles ? deepCloneRoles(current.roles) : null;
		}
		return profile.roles ? deepCloneRoles(profile.roles) : null;
	}

	function deepCloneRoles(source) {
		const out = {};
		for (const role of ENGINEERING_ROLES) {
			const binding = source && source[role];
			out[role] = binding && binding.model
				? { model: String(binding.model), reasoning: String(binding.reasoning || "") }
				: { model: "", reasoning: "" };
		}
		return out;
	}

	function modelEntry(modelId) {
		if (!state || !Array.isArray(state.registry)) return null;
		return state.registry.find((m) => m && String(m.id) === modelId) || null;
	}

	// Phase M1: the user-facing profile list is the top-level Nexus Profile
	// catalog (engine classification). Phase M1.1: the Dual-list fallback
	// happens ONLY when the host has no Nexus contract at all — a contract-
	// present catalog (even empty) is authoritative and never falls back.
	function nexusEntryFor(id) {
		if (!state) return null;
		const wanted = String(id || "").toLowerCase();
		const catalog = userFacingProfiles(state);
		return catalog.find((p) => p && String(p.id) === wanted) || null;
	}

	function selectProfile(nextId) {
		setProfileId(nextId);
		setDirty(false);
		setNotice(null);
		setRoles(bindingsFor(nextId));
	}

	function changeRole(role, patch) {
		const current = roles || bindingsFor(profileId);
		if (!current) return;
		const next = { ...current, [role]: { ...current[role], ...patch } };
		if (profileId && profileId !== "custom") {
			// Built-in profiles are immutable: editing a binding auto-creates
			// the operator's Custom profile (the built-in is never mutated).
			setProfileId("custom");
			setDirty(true);
			setNotice("Editing a built-in profile creates a Custom profile.");
			setNoticeTone("ok");
		}
		setRoles(next);
	}

	function save() {
		if (saving) return;
		// M1.1 gate mirrors the controller boundary: selection permission
		// depends on `selectable` ONLY. The engine classifies WHICH execution
		// architecture is used later; it never blocks the profile-preference
		// layer. The backend rejects selectable=false with profile-not-selectable.
		const entry = nexusEntryFor(profileId);
		if (entry && entry.selectable === false) return;
		setSaving(true);
		setNotice(null);
		const requestId = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "req-" + Date.now() + "-" + Math.random().toString(36).slice(2));
		const action = profileId === "custom" ? "save-custom" : "select";
		const body = { sessionId: sessionId || "", action, requestId };
		if (action === "save-custom") body.roles = roles;
		else body.profileId = profileId;
		fetch("./nexus/engineering-profile-action.json", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			cache: "no-store",
		})
			.then((response) => response.json().catch(() => ({ ok: false, error: "engineering-action-unreadable" })))
			.then((body) => {
				if (body && body.ok) {
					setNotice(action === "select" ? "Preferred profile updated. The change applies at the next safe execution boundary." : "Custom profile saved and set as preferred. The change applies at the next safe execution boundary.");
					setNoticeTone("ok");
					setDirty(false);
					refresh();
				} else {
					setNotice("Could not save: " + (body && body.error ? body.error : "unknown error"));
					setNoticeTone("err");
				}
			})
			.catch(() => {
				setNotice("Could not save the engineering profile. Try again.");
				setNoticeTone("err");
			})
			.finally(() => setSaving(false));
	}

	const selectedProfile = profileId ? nexusEntryFor(profileId) : null;
	const selectedEngine = selectedProfile && selectedProfile.engine ? String(selectedProfile.engine) : "dual";
	const selectedSelectable = selectedProfile ? selectedProfile.selectable !== false : false;
	// Readiness is engine-aware: Dual needs role bindings, a metadata-only
	// engine (Muse in M1) is ready without them. The authoritative catalog
	// (Nexus contract when present, legacy Dual list on old hosts) decides
	// whether anything is user-facing at all.
	const ready = !failed && !!state && userFacingProfiles(state).length > 0 && !!selectedProfile && (selectedEngine !== "dual" || !!roles);
	return { state, failed, profileId, roles, notice, noticeTone, saving, dirty, fetchedAt, refresh, selectProfile, changeRole, save, bindingsFor, modelEntry, selectedProfile, selectedEngine, selectedSelectable, ready };
}

/**
* Presentational editor fields shared by both surfaces. variant "room"
* renders the long PREFERRED PROFILE meta line; variant "composer" keeps
* the popover compact. All state and verbs come from useEngineeringEditor.
*/
/**
* Phase M1: Muse (and any future non-Dual engine) renders READ-ONLY
* foundation metadata instead of the Dual role editor. No role dropdowns,
* no editable bindings — Muse is never coerced into the Dual role schema.
*/
function museEditorRows(selectedProfile) {
	const muse = selectedProfile && selectedProfile.muse && typeof selectedProfile.muse === "object" ? selectedProfile.muse : null;
	const reasoning = muse && muse.reasoning && typeof muse.reasoning === "object" ? muse.reasoning : null;
	const statusText = selectedProfile && typeof selectedProfile.availability === "string" && selectedProfile.availability !== ""
		? selectedProfile.availability
		: (muse && typeof muse.status === "string" && muse.status !== "" ? muse.status : "unavailable");
	const rows = [
		["Engine", "Muse", "Muse-native agent plane — a separate engine, never Dual roles."],
		["Status", statusText.charAt(0).toUpperCase() + statusText.slice(1), "Muse profile availability."],
		["Reasoning", reasoning && reasoning.default ? String(reasoning.default) : "\u2014", "Default Muse reasoning effort."],
		["Max Reasoning", reasoning && reasoning.escalation ? String(reasoning.escalation) : "\u2014", "Muse escalation reasoning ceiling."],
		["Subagents", muse && muse.subagents && muse.subagents.enabled === false ? "Disabled" : "Enabled", "Muse subagent dispatch."],
		["Independent Review", muse && muse.review && muse.review.independent === false ? "Not available" : "Independent", "Independent Muse review."],
		["Execution", selectedProfile && selectedProfile.runnable === false ? "Contributor-gated" : "Available", "Muse runs on its own protected single-agent plane; provider egress is sanitized and exact-target enforced."],
	];
	return rows.map((row) => react_jsx_runtime.jsxs("div", {
		className: "nx-eng-row",
		children: [
			react_jsx_runtime.jsx("span", { className: "nx-eng-label", title: row[2], children: row[0] }),
			react_jsx_runtime.jsx("span", { className: "nx-eng-value", title: row[2], children: row[1] }),
		],
	}, "muse-" + row[0]));
}

function EngineeringEditorFields({ editor, variant }) {
	const { state, profileId, roles, dirty, notice, noticeTone, saving, selectProfile, changeRole, save, modelEntry } = editor;
	// Phase M1: engine-aware editor surface. Dual profiles keep the EXACT
	// role editor; Muse renders foundation metadata only and cannot be
	// selected. Legacy editor objects (no engine fields) stay Dual.
	const selectedProfile = editor.selectedProfile || null;
	const selectedEngine = editor.selectedEngine || (selectedProfile && selectedProfile.engine) || "dual";
	const selectedSelectable = editor.selectedSelectable !== false;
	// Phase M1.1: ONE catalog rule — Nexus contract authoritative (empty
	// fails closed upstream), legacy Dual list only when the property is absent.
	const catalog = userFacingProfiles(state);
	return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
		children: [
			react_jsx_runtime.jsx("div", {
				className: "nx-eng-head",
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-eng-label", children: "Profile" }, "label"),
					react_jsx_runtime.jsx("select", {
						className: "nx-eng-profile",
						value: profileId || "",
						onChange: (event) => selectProfile(event.target.value),
						"aria-label": "Preferred engineering profile",
						children: catalog.map((profile) => react_jsx_runtime.jsx("option", { value: String(profile.id), children: String(profile.displayName || profile.id) + (profile.engine === "muse" ? " \u2014 " + String(profile.availability || "gated") : profile.id === "custom" ? " (operator-defined)" : "") }, String(profile.id))),
					}, "profile"),
				],
			}, "head"),
			selectedEngine === "dual" ? ENGINEERING_ROLES.map((role) => {
				const binding = roles[role] || { model: "", reasoning: "" };
				const compatible = (state.roleModels && Array.isArray(state.roleModels[role]) ? state.roleModels[role] : []);
				const entry = modelEntry(binding.model);
				const reasoningLevels = entry && Array.isArray(entry.supportedReasoningLevels) ? entry.supportedReasoningLevels : [];
				const isCustom = profileId === "custom";
				return react_jsx_runtime.jsxs("div", {
					className: "nx-eng-row",
					children: [
						react_jsx_runtime.jsx("span", { className: "nx-eng-label", title: role, children: ENGINEERING_ROLE_LABELS[role] || role }),
						react_jsx_runtime.jsx("select", {
							className: "nx-eng-select",
							value: binding.model,
							disabled: !isCustom,
							"aria-label": role + " model",
							onChange: (event) => changeRole(role, { model: event.target.value, reasoning: "" }),
							children: compatible.map((modelId) => {
								const m = modelEntry(modelId);
								return react_jsx_runtime.jsx("option", { value: modelId, children: (m ? String(m.displayName || m.id) : modelId) + (m && m.vendor ? " · " + m.vendor : "") }, modelId);
							}),
						}),
						react_jsx_runtime.jsx("select", {
							className: "nx-eng-reason",
							value: binding.reasoning,
							disabled: !isCustom,
							"aria-label": role + " reasoning",
							onChange: (event) => changeRole(role, { reasoning: event.target.value }),
							children: reasoningLevels.map((level) => react_jsx_runtime.jsx("option", { value: level, children: level }, level)),
						}),
					],
				}, role);
			}) : museEditorRows(selectedProfile),
			(dirty || profileId === "custom") && react_jsx_runtime.jsx("div", {
				className: "nx-eng-hint",
				children: "Custom bindings apply to the selected role when the next task starts (or escalates). Built-in profiles are never modified.",
			}, "hint"),
			notice && react_jsx_runtime.jsx("div", { className: "nx-eng-notice " + (noticeTone === "ok" ? "nx-eng-notice-ok" : "nx-eng-notice-err"), children: notice }, "notice"),
			!selectedSelectable && react_jsx_runtime.jsx("div", { className: "nx-eng-hint", children: "This profile is not selectable yet (profile-not-selectable). It unlocks when Nexus marks it selectable." }, "locked"),
			selectedEngine === "muse" && react_jsx_runtime.jsx("div", { className: "nx-eng-hint", children: "Muse engine: new sessions run on the Muse agent plane (single agent, no subagents, no independent review). The current conversation keeps its existing plane." }, "muse-engine-hint"),
			react_jsx_runtime.jsx("button", {
				type: "button",
				className: "nx-eng-save",
				disabled: saving || !selectedSelectable,
				title: selectedSelectable ? undefined : "profile-not-selectable \u2014 this profile is not selectable yet.",
				onClick: () => save(),
				children: saving ? "Saving…" : (profileId === "custom" ? "Save Custom Profile" : "Select Profile"),
			}, "save"),
			variant === "room" && react_jsx_runtime.jsx("div", { className: "nx-eng-meta", children: "PREFERRED PROFILE: " + String((state.preferredProfile && state.preferredProfile.displayName) || (state.preferredProfile && state.preferredProfile.id) || "none") + " · the RUNNING execution (class/role/model/provider) is shown in the Overview tab and is never rewritten by a save." }, "meta"),
		],
	});
}

//#region Registry R3 — staged Engineering Mode configuration (TASK-0047)
/**
* Registry-backed Engineering Mode UI (R3 of NEXUS_REGISTRY_ARCHITECTURE.md).
*
* The selector is populated from Registry ModeDefinition manifests
* (GET ./nexus/registry/v1/modes): Engineering v1 (Deprecated / Legacy),
* v2 (Active / Legacy) and v3 (Planned / Preview). No legacy profile
* combination and no internal agent-preset id ever appears here.
*
* R3 is the configuration experience, NOT the execution cutover: every save
* stages a versioned preference under data/registry/ for future activation.
* The running session keeps its legacy bindings; the legacy editor below
* stays the authoritative runtime control until R6. v3 renders its slot
* manifest read-only with all execution controls disabled.
*/
const REGISTRY_API = "./nexus/registry/v1";
const REGISTRY_PREF_KEY = "nexus.registry.mode";
const REGISTRY_MODE_ORDER = ["engineering-v1", "engineering-v2", "engineering-v3"];
const REGISTRY_MODE_STATUS_LABEL = {
	deprecated: "Deprecated / Legacy",
	"active-legacy": "Active / Legacy",
	active: "Active",
	planned: "Planned / Preview",
};
const REGISTRY_ROLE_LABELS = {
	primaryEngineer: "Primary Engineer",
	deepEngineer: "Deep Engineer",
	fallback: "Fallback",
	reviewer: "Reviewer",
	solver: "Solver",
	visualReviewer: "Visual Reviewer (optional)",
};

function registryStatusLabel(status) {
	return REGISTRY_MODE_STATUS_LABEL[status] || String(status || "unknown");
}
function registrySeam(name) {
	try {
		const w = typeof window !== "undefined" ? window : null;
		if (!w) return null;
		const v = w[name];
		return v === undefined ? null : v;
	} catch { return null; }
}
function registryReadPref() {
	try {
		if (typeof window === "undefined" || !window.localStorage) return "engineering-v2";
		const v = window.localStorage.getItem(REGISTRY_PREF_KEY);
		if (v && REGISTRY_MODE_ORDER.indexOf(v) !== -1) return v;
	} catch { /* storage unavailable: fall through */ }
	return "engineering-v2";
}
function registryWritePref(value) {
	try { window.localStorage.setItem(REGISTRY_PREF_KEY, value); } catch { /* best effort */ }
}
function registryJson(response) {
	return response.json().catch(() => null);
}
function registryClone(value) {
	return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}
function registryModeById(doc, modeId) {
	const modes = doc && Array.isArray(doc.modes) ? doc.modes : [];
	return modes.find((m) => m && m.id === modeId) || null;
}
function registrySlotOfRole(mode, role) {
	for (const slot of (mode && mode.slots) || []) {
		if (slot && Array.isArray(slot.internalRoles) && slot.internalRoles.indexOf(role) !== -1) return slot;
	}
	return null;
}
function registryRouteById(list, id) {
	return (list || []).find((r) => r && r.routeId === id) || null;
}
function registryCapacityText(cap) {
	if (!cap || cap.value === null || cap.value === undefined) return "unknown";
	return formatTokens(cap.value) + " (" + (cap.provenance || "declared") + ")";
}
function registryModelsOfSlot(eligible, ineligible) {
	const map = new Map();
	const mark = (r, isEligible) => {
		if (!r) return;
		if (!map.has(r.logicalModelId)) {
			map.set(r.logicalModelId, { id: r.logicalModelId, display: r.modelDisplayName || r.logicalModelId, eligible: 0, reasons: [] });
		}
		const entry = map.get(r.logicalModelId);
		if (isEligible) entry.eligible += 1;
		else if (r.ineligibleReason) entry.reasons.push(r.ineligibleReason);
	};
	for (const r of eligible || []) mark(r, true);
	for (const r of ineligible || []) mark(r, false);
	return [...map.values()];
}

function useRegistryModes() {
	const seam = registrySeam("__NX_TEST_REGISTRY_MODES__");
	const [doc, setDoc] = react.useState(seam);
	const [failed, setFailed] = react.useState(false);
	const [loading, setLoading] = react.useState(seam === null);
	const refresh = react.useCallback(() => {
		const test = registrySeam("__NX_TEST_REGISTRY_MODES__");
		if (test !== null) {
			setDoc(test);
			setFailed(false);
			setLoading(false);
			return;
		}
		if (typeof fetch === "undefined") {
			setFailed(true);
			setLoading(false);
			return;
		}
		setLoading(true);
		fetch(REGISTRY_API + "/modes", { cache: "no-store" })
			.then((res) => registryJson(res).then((body) => {
				if (!res.ok || !body || body.ok !== true || !Array.isArray(body.modes)) throw new Error("registry modes unavailable");
				setDoc(body);
				setFailed(false);
			}))
			.catch(() => setFailed(true))
			.finally(() => setLoading(false));
	}, []);
	react.useEffect(() => {
		if (seam === null) refresh();
	}, [refresh, seam]);
	return { doc, failed, loading, refresh };
}

function registrySeamedConfig(seamAll, m, a) {
	if (!seamAll || typeof seamAll !== "object") return null;
	const key = m + "|" + (a || "");
	if (seamAll[key] !== undefined) return seamAll[key];
	if (seamAll[m] !== undefined) return seamAll[m];
	return null;
}

function useRegistryConfiguration(modeId, adopt) {
	const [doc, setDoc] = react.useState(() => registrySeamedConfig(registrySeam("__NX_TEST_REGISTRY_CONFIG__"), modeId, adopt));
	const [failed, setFailed] = react.useState(false);
	const [loading, setLoading] = react.useState(() => registrySeamedConfig(registrySeam("__NX_TEST_REGISTRY_CONFIG__"), modeId, adopt) === null);
	const refresh = react.useCallback(() => {
		const test = registrySeamedConfig(registrySeam("__NX_TEST_REGISTRY_CONFIG__"), modeId, adopt);
		if (test !== null) {
			setDoc(test);
			setFailed(false);
			setLoading(false);
			return;
		}
		if (!modeId || typeof fetch === "undefined") {
			setFailed(!!modeId);
			setLoading(false);
			return;
		}
		setLoading(true);
		const url = REGISTRY_API + "/configuration?mode=" + encodeURIComponent(modeId) + (adopt ? "&adopt=" + encodeURIComponent(adopt) : "");
		fetch(url, { cache: "no-store" })
			.then((res) => registryJson(res).then((body) => {
				if (!res.ok || !body || body.ok !== true || !body.result) throw new Error("registry configuration unavailable");
				setDoc(body.result);
				setFailed(false);
			}))
			.catch(() => setFailed(true))
			.finally(() => setLoading(false));
	}, [modeId, adopt]);
	react.useEffect(() => {
		const test = registrySeamedConfig(registrySeam("__NX_TEST_REGISTRY_CONFIG__"), modeId, adopt);
		setDoc(test);
		setFailed(false);
		setLoading(test === null);
		if (test === null) refresh();
	}, [modeId, adopt, refresh]);
	return { doc, failed, loading, refresh };
}

function registrySeamedEligible(modeId, slotIds) {
	const testAll = registrySeam("__NX_TEST_REGISTRY_ELIGIBLE__");
	if (!modeId || !testAll || typeof testAll !== "object") return null;
	const next = {};
	for (const slotId of slotIds || []) {
		const t = testAll[modeId + "/" + slotId];
		if (t === undefined) return null;
		next[slotId] = t;
	}
	return next;
}

function useRegistryEligible(modeId, slotIds) {
	const key = (slotIds || []).join(",");
	const [bySlot, setBySlot] = react.useState(() => registrySeamedEligible(modeId, slotIds) || {});
	const [loading, setLoading] = react.useState(() => registrySeamedEligible(modeId, slotIds) === null);
	const refresh = react.useCallback(() => {
		const testAll = registrySeam("__NX_TEST_REGISTRY_ELIGIBLE__");
		const next = {};
		let allSeamed = !!modeId;
		for (const slotId of slotIds || []) {
			const t = testAll && typeof testAll === "object" ? testAll[modeId + "/" + slotId] : undefined;
			if (t === undefined) {
				allSeamed = false;
				break;
			}
			next[slotId] = t;
		}
		if (allSeamed) {
			setBySlot(next);
			setLoading(false);
			return;
		}
		if (!modeId || (slotIds || []).length === 0 || typeof fetch === "undefined") {
			setBySlot({});
			setLoading(false);
			return;
		}
		setLoading(true);
		Promise.all((slotIds || []).map((slotId) =>
			fetch(REGISTRY_API + "/eligible?mode=" + encodeURIComponent(modeId) + "&slot=" + encodeURIComponent(slotId), { cache: "no-store" })
				.then((res) => registryJson(res).then((body) => [slotId, res.ok && body && body.ok === true ? body : null]))
				.catch(() => [slotId, null])
		)).then((pairs) => {
			const mapped = {};
			for (const [slotId, body] of pairs) {
				mapped[slotId] = body
					? { eligible: body.eligible || [], ineligible: body.ineligible || [] }
					: { eligible: [], ineligible: [], failed: true };
			}
			setBySlot(mapped);
			setLoading(false);
		});
	}, [modeId, key]);
	react.useEffect(() => {
		refresh();
	}, [refresh]);
	return { bySlot, loading, refresh };
}

function registryDraftFromDoc(doc) {
	if (!doc) return null;
	if (!doc.config) {
		return {
			previewOnly: true,
			reason: doc.reason || "mode-not-runnable",
			dirty: false,
			notice: null,
			noticeTone: "ok",
			validation: [],
			resolutionId: null,
			baseRevision: null,
			config: null,
			adoptedFrom: null,
		};
	}
	return {
		previewOnly: false,
		config: registryClone(doc.config),
		baseRevision: doc.persisted ? doc.revision : null,
		dirty: false,
		notice: null,
		noticeTone: "ok",
		validation: Array.isArray(doc.validation) ? doc.validation : [],
		resolutionId: null,
		adoptedFrom: doc.adoptedFrom || null,
	};
}

function registryAssignmentOf(draft, slotId) {
	return draft && draft.config && draft.config.slots ? draft.config.slots[slotId] || null : null;
}

function RegistrySlotCard({ slot, assignment, eligible, ineligible, disabled, onAssign }) {
	const models = registryModelsOfSlot(eligible, ineligible);
	const eligibleList = eligible || [];
	const chosenRoute = (assignment && registryRouteById(eligibleList, assignment.routeId)) || null;
	const chosenIneligible = !chosenRoute && assignment ? (ineligible || []).find((r) => r && r.routeId === assignment.routeId) || null : null;
	const tier = chosenRoute ? chosenRoute.dataUseTier : null;

	function pickModel(modelId) {
		const routes = eligibleList.filter((r) => r.logicalModelId === modelId);
		if (routes.length === 0) return;
		const keep = assignment && routes.some((r) => r.routeId === assignment.routeId) ? assignment.routeId : routes[0].routeId;
		const route = registryRouteById(routes, keep) || routes[0];
		const reasoning = assignment && route.reasoningLevels.indexOf(assignment.reasoning) !== -1 ? assignment.reasoning : route.reasoningLevels[0];
		onAssign({ logicalModelId: modelId, routeId: route.routeId, reasoning }, "Model changed to " + (route.modelDisplayName || modelId) + "; provider reset to " + (route.providerName || route.providerId) + " with reasoning " + reasoning + ".");
	}
	function pickRoute(routeId) {
		const route = registryRouteById(eligibleList, routeId);
		if (!route || !assignment) return;
		const reasoning = route.reasoningLevels.indexOf(assignment.reasoning) !== -1 ? assignment.reasoning : route.reasoningLevels[0];
		const note = reasoning === assignment.reasoning
			? "Provider changed to " + (route.providerName || route.providerId) + "; model kept as " + (route.modelDisplayName || route.logicalModelId) + "."
			: "Provider changed to " + (route.providerName || route.providerId) + "; reasoning reset to " + reasoning + " (the previous level is not supported on this route).";
		onAssign({ logicalModelId: route.logicalModelId, routeId: route.routeId, reasoning }, note);
	}
	function pickReasoning(reasoning) {
		if (!assignment) return;
		onAssign({ logicalModelId: assignment.logicalModelId, routeId: assignment.routeId, reasoning }, null);
	}

	const reasoningLevels = chosenRoute ? chosenRoute.reasoningLevels : [];
	return react_jsx_runtime.jsxs("div", {
		className: "nx-reg-slot",
		children: [
			react_jsx_runtime.jsx("div", { className: "nx-reg-slot-head", children: (slot && slot.label) || slot.id }),
			react_jsx_runtime.jsxs("div", {
				className: "nx-eng-row",
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-eng-label", children: "Model" }),
					react_jsx_runtime.jsx("select", {
						className: "nx-eng-select",
						value: assignment ? assignment.logicalModelId : "",
						disabled: disabled || models.length === 0,
						"aria-label": slot.id + " model",
						onChange: (event) => pickModel(event.target.value),
						children: models.map((m) => react_jsx_runtime.jsx("option", {
							value: m.id,
							disabled: m.eligible === 0,
							title: m.eligible === 0 ? "No eligible route: " + (m.reasons[0] || "incompatible with this slot") : m.id,
							children: m.display + (m.eligible === 0 ? " (no eligible route)" : ""),
						}, m.id)),
					}),
				],
			}),
			react_jsx_runtime.jsxs("fieldset", {
				className: "nx-reg-routes",
				children: [
					react_jsx_runtime.jsx("legend", { className: "nx-eng-label", children: "Provider" }),
					eligibleList.filter((r) => assignment && r.logicalModelId === assignment.logicalModelId).map((r) => react_jsx_runtime.jsxs("label", {
						className: "nx-reg-radio",
						title: "Connection " + (r.connectionStatus || "unknown") + " · " + (r.accessType || "unknown") + " access",
						children: [
							react_jsx_runtime.jsx("input", {
								type: "radio",
								name: "nx-reg-" + slot.id,
								checked: !!assignment && assignment.routeId === r.routeId,
								disabled,
								onChange: () => pickRoute(r.routeId),
							}),
							react_jsx_runtime.jsx("span", { children: (r.providerName || r.providerId) + " · " + (r.connectionStatus || "unknown") }),
						],
					}, r.routeId)),
					(ineligible || []).filter((r) => assignment && r.logicalModelId === assignment.logicalModelId).map((r) => react_jsx_runtime.jsxs("label", {
						className: "nx-reg-radio nx-reg-radio-off",
						title: r.ineligibleReason || "not eligible for this slot",
						children: [
							react_jsx_runtime.jsx("input", { type: "radio", disabled: true }),
							react_jsx_runtime.jsx("span", { children: (r.providerName || r.providerId) + " — unavailable (" + (r.ineligibleReason || "incompatible") + ")" }),
						],
					}, "off-" + r.routeId)),
				],
			}),
			react_jsx_runtime.jsxs("div", {
				className: "nx-eng-row",
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-eng-label", children: "Reasoning" }),
					react_jsx_runtime.jsx("select", {
						className: "nx-eng-reason",
						value: assignment ? assignment.reasoning : "",
						disabled: disabled || reasoningLevels.length === 0,
						"aria-label": slot.id + " reasoning",
						title: reasoningLevels.length === 0 ? "No eligible route selected" : "Levels supported by the chosen route",
						onChange: (event) => pickReasoning(event.target.value),
						children: reasoningLevels.map((level) => react_jsx_runtime.jsx("option", { value: level, children: level }, level)),
					}),
				],
			}),
			chosenRoute ? react_jsx_runtime.jsx("div", {
				className: "nx-eng-meta",
				children: "Connection " + (chosenRoute.connectionStatus || "unknown") + " · " + (chosenRoute.accessType || "unknown") + " · transport " + (chosenRoute.transport || "unknown") + " · context " + registryCapacityText(chosenRoute.contextWindow) + " · output " + registryCapacityText(chosenRoute.maxOutputTokens),
			}) : null,
			chosenIneligible ? react_jsx_runtime.jsx("div", {
				className: "nx-eng-notice nx-eng-notice-err",
				children: "Saved route is not runnable: " + (chosenIneligible.ineligibleReason || "incompatible") + ". Choose an eligible provider above.",
			}) : null,
			!chosenRoute && !chosenIneligible ? react_jsx_runtime.jsx("div", {
				className: "nx-eng-notice nx-eng-notice-err",
				children: "No route selected for this slot.",
			}) : null,
			tier === "contributor" ? react_jsx_runtime.jsx("div", {
				className: "nx-reg-tier",
				children: "Contributor data-use tier: repository content shared through this route is governed by the provider's contributor policy. Routes never fall back across tiers silently.",
			}) : null,
		],
	}, slot.id);
}

function RegistryAdvanced({ mode, draft, bySlot, disabled, onOverride, onClearOverride }) {
	const roles = ((mode && mode.internalRoles) || []).concat(((mode && mode.optionalCapabilities) || []).filter((c) => ((mode && mode.internalRoles) || []).indexOf(c) === -1));
	if (roles.length === 0) return null;
	return react_jsx_runtime.jsxs("div", {
		className: "nx-reg-adv",
		children: [
			react_jsx_runtime.jsx("div", { className: "nx-reg-adv-head", children: "Advanced role overrides" }),
			roles.map((role) => {
				const slot = registrySlotOfRole(mode, role);
				const slotId = slot ? slot.id : null;
				const base = slotId && draft.config.slots[slotId] ? draft.config.slots[slotId] : null;
				const overrides = draft.config.roleOverrides || {};
				const override = overrides[role] || null;
				const effective = override || base;
				const differs = !!override && !!base && JSON.stringify(override) !== JSON.stringify(base);
				let pool = [];
				if (role === "visualReviewer") {
					pool = Object.values(bySlot || {}).reduce((acc, s) => acc.concat((s && s.eligible) || []), []).filter((r) => r && r.capabilities && r.capabilities.imageInput === true);
				} else if (slotId && bySlot && bySlot[slotId]) {
					pool = bySlot[slotId].eligible || [];
				}
				const models = registryModelsOfSlot(pool, []);
				const routePool = effective ? pool.filter((r) => r.logicalModelId === effective.logicalModelId) : [];
				const chosenRoute = effective ? registryRouteById(pool, effective.routeId) : null;
				const levels = chosenRoute ? chosenRoute.reasoningLevels : [];
				return react_jsx_runtime.jsxs("div", {
					className: "nx-reg-adv-row",
					children: [
						react_jsx_runtime.jsxs("div", {
							className: "nx-reg-adv-title",
							children: [
								react_jsx_runtime.jsx("span", { children: REGISTRY_ROLE_LABELS[role] || role }),
								!slotId ? react_jsx_runtime.jsx("span", { className: "nx-reg-tag", children: "optional" }) : null,
								override ? react_jsx_runtime.jsx("span", { className: "nx-reg-tag", children: differs ? "differs from " + (slot ? slot.label : "slot") : "override = slot value" }) : react_jsx_runtime.jsx("span", { className: "nx-reg-tag nx-reg-tag-dim", children: slot ? "follows " + slot.label + " slot" : "unset" }),
							],
						}),
						react_jsx_runtime.jsxs("div", {
							className: "nx-eng-row",
							children: [
								react_jsx_runtime.jsx("select", {
									className: "nx-eng-select",
									value: effective ? effective.logicalModelId : "",
									disabled: disabled || models.length === 0,
									"aria-label": role + " model override",
									title: slot ? "Independent override; the " + slot.label + " slot is untouched" : "Independent optional-role binding",
									onChange: (event) => {
										const modelId = event.target.value;
										const routes = pool.filter((r) => r.logicalModelId === modelId);
										if (routes.length === 0 || modelId === "") return;
										const route = routes[0];
										onOverride(role, { logicalModelId: modelId, routeId: route.routeId, reasoning: route.reasoningLevels[0] });
									},
									children: [react_jsx_runtime.jsx("option", { value: "", children: "—" }, "_empty")].concat(models.map((m) => react_jsx_runtime.jsx("option", { value: m.id, children: m.display }, m.id))),
								}),
								react_jsx_runtime.jsx("select", {
									className: "nx-eng-select",
									value: effective ? effective.routeId : "",
									disabled: disabled || routePool.length === 0,
									"aria-label": role + " route override",
									onChange: (event) => {
										const route = registryRouteById(pool, event.target.value);
										if (!route || !effective || event.target.value === "") return;
										onOverride(role, { logicalModelId: route.logicalModelId, routeId: route.routeId, reasoning: route.reasoningLevels.indexOf(effective.reasoning) !== -1 ? effective.reasoning : route.reasoningLevels[0] });
									},
									children: [react_jsx_runtime.jsx("option", { value: "", children: "—" }, "_empty")].concat(routePool.map((r) => react_jsx_runtime.jsx("option", { value: r.routeId, children: r.providerName || r.providerId }, r.routeId))),
								}),
								react_jsx_runtime.jsx("select", {
									className: "nx-eng-reason",
									value: effective ? effective.reasoning : "",
									disabled: disabled || levels.length === 0,
									"aria-label": role + " reasoning override",
									onChange: (event) => {
										if (!effective || event.target.value === "") return;
										onOverride(role, { logicalModelId: effective.logicalModelId, routeId: effective.routeId, reasoning: event.target.value });
									},
									children: [react_jsx_runtime.jsx("option", { value: "", children: "—" }, "_empty")].concat(levels.map((level) => react_jsx_runtime.jsx("option", { value: level, children: level }, level))),
								}),
								override ? react_jsx_runtime.jsx("button", {
									type: "button",
									className: "nx-reg-clear",
									disabled,
									title: "Clear override and follow the slot again",
									"aria-label": "Clear " + role + " override",
									onClick: () => onClearOverride(role),
									children: "Clear",
								}) : null,
							],
						}),
					],
				}, role);
			}),
		],
	});
}

function RegistryValidationList({ validation }) {
	if (!validation || validation.length === 0) return null;
	return react_jsx_runtime.jsx("div", {
		className: "nx-reg-errors",
		role: "alert",
		children: validation.map((e, i) => react_jsx_runtime.jsx("div", {
			className: "nx-eng-notice nx-eng-notice-err",
			children: (e.code || "invalid") + " · " + (e.path || "") + " — " + (e.message || ""),
		}, String(i) + "-" + (e.code || "e"))),
	});
}

function RegistryConfigBody({ mode, doc, bySlot, draft, onAssign, onOverride, onClearOverride, onSave, saving, onReload, adopt, onAdoptChange }) {
	if (!mode) return null;
	if ((draft && draft.previewOnly) || mode.executable === false) {
		const slots = (mode && mode.slots) || (doc && doc.slotsManifest) || [];
		return react_jsx_runtime.jsxs("div", {
			children: [
				react_jsx_runtime.jsx("div", {
					className: "nx-eng-notice",
					children: "Planned / Preview — " + ((draft && draft.reason) || (mode && mode.executableReason) || "not runnable") + ". Orchestration is not implemented in R3; slot assignments are shown for review only and cannot be saved or executed.",
				}),
				slots.map((slot) => react_jsx_runtime.jsxs("div", {
					className: "nx-reg-slot",
					children: [
						react_jsx_runtime.jsx("div", { className: "nx-reg-slot-head", children: (slot && slot.label) || (slot && slot.id) }),
						react_jsx_runtime.jsx("div", {
							className: "nx-eng-meta",
							children: "Roles: " + ((slot && slot.internalRoles) || []).join(", ") + (slot && slot.required === false ? " · optional" : " · required"),
						}),
						react_jsx_runtime.jsx("select", { className: "nx-eng-select", disabled: true, value: "", "aria-label": slot.id + " (preview only)", onChange: () => {}, children: react_jsx_runtime.jsx("option", { value: "", children: "Preview only — unavailable" }) }),
					],
				}, slot.id)),
			],
		});
	}
	if (!draft || !draft.config) {
		return react_jsx_runtime.jsx("div", { className: "nx-eng-notice", children: "Loading mode configuration…" });
	}
	const validation = draft.validation || [];
	const valid = validation.length === 0;
	return react_jsx_runtime.jsxs("div", {
		children: [
			!doc.persisted && doc.adoptable ? react_jsx_runtime.jsxs("div", {
				className: "nx-eng-row",
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-eng-label", title: "Adopting a legacy profile seeds a reviewable draft; nothing is saved until you choose Save, and legacy files are never rewritten.", children: "Seed from" }),
					react_jsx_runtime.jsx("select", {
						className: "nx-eng-select",
						value: adopt || doc.adoptedFrom || "",
						disabled: draft.dirty || saving,
						"aria-label": "Legacy profile to seed this mode",
						title: draft.dirty ? "Save or reload before changing the seed" : "Adopting is deliberate and reviewable",
						onChange: (event) => onAdoptChange(event.target.value),
						children: doc.adoptable.map((id) => react_jsx_runtime.jsx("option", { value: id, children: id }, id)),
					}),
				],
			}) : null,
			!doc.persisted ? react_jsx_runtime.jsx("div", {
				className: "nx-eng-hint",
				children: "Preview seeded from legacy profile " + (doc.adoptedFrom || "unknown") + " — reviewable, not yet saved. Adopting never rewrites legacy profiles.",
			}) : null,
			(mode.slots || []).map((slot) => react_jsx_runtime.jsx(RegistrySlotCard, {
				slot,
				assignment: registryAssignmentOf(draft, slot.id),
				eligible: bySlot && bySlot[slot.id] ? bySlot[slot.id].eligible || [] : [],
				ineligible: bySlot && bySlot[slot.id] ? bySlot[slot.id].ineligible || [] : [],
				disabled: saving,
				onAssign: (patch, announcement) => onAssign(slot.id, patch, announcement),
			}, slot.id)),
			mode.id === "engineering-v1" ? react_jsx_runtime.jsx(RegistryAdvanced, {
				mode,
				draft,
				bySlot,
				disabled: saving,
				onOverride,
				onClearOverride,
			}) : null,
			react_jsx_runtime.jsx(RegistryValidationList, { validation }),
			valid ? react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-ok", children: "Valid staged configuration." }) : null,
			draft.notice ? react_jsx_runtime.jsx("div", {
				className: "nx-eng-notice " + (draft.noticeTone === "err" ? "nx-eng-notice-err" : "nx-eng-notice-ok"),
				children: draft.notice,
			}) : null,
			react_jsx_runtime.jsxs("div", {
				className: "nx-reg-save-row",
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "nx-eng-save",
						disabled: saving || !valid,
						title: !valid ? "Resolve validation errors before saving" : "Stage this configuration for future activation",
						onClick: onSave,
						children: saving ? "Saving…" : (doc.persisted ? "Save staged configuration" : "Adopt & save staged configuration"),
					}),
					react_jsx_runtime.jsx("span", {
						className: "nx-eng-meta",
						children: doc.persisted ? "Saved revision " + doc.revision + (doc.savedAtUtc ? " · " + doc.savedAtUtc : "") : "Not saved yet",
					}),
					draft.resolutionId ? react_jsx_runtime.jsx("span", { className: "nx-eng-meta", title: "Compiled resolution id", children: "· " + String(draft.resolutionId).slice(0, 12) + "…" }) : null,
					draft.noticeTone === "err" && draft.stale ? react_jsx_runtime.jsx("button", {
						type: "button",
						className: "nx-reg-clear",
						onClick: onReload,
						children: "Reload saved configuration",
					}) : null,
				],
			}),
		],
	});
}

function RegistryPanel({ sessionId, legacyRuntimeName }) {
	const modes = useRegistryModes();
	const [selected, setSelected] = react.useState(registryReadPref);
	const [adopts, setAdopts] = react.useState({});
	const [drafts, setDrafts] = react.useState({});
	const [saving, setSaving] = react.useState(false);
	const mode = registryModeById(modes.doc, selected);
	const adopt = adopts[selected] || null;
	const config = useRegistryConfiguration(selected, adopt);
	const slotIds = mode && mode.slots ? mode.slots.map((s) => s.id) : [];
	const eligible = useRegistryEligible(mode && mode.executable === false ? null : selected, mode && mode.executable === false ? [] : slotIds);
	// The stored draft wins; otherwise derive a transient draft from the loaded
	// document so the configuration paints (and static smoke renders) without
	// waiting for the init effect. First edits materialize it via baseDraft().
	const freshBase = !config.loading && config.doc && !drafts[selected] ? registryDraftFromDoc(config.doc) : null;
	const draft = drafts[selected] || freshBase || null;

	react.useEffect(() => {
		if (!selected || !config.doc || config.loading) return;
		setDrafts((prev) => {
			if (prev[selected]) return prev;
			const next = registryDraftFromDoc(config.doc);
			if (!next) return prev;
			return { ...prev, [selected]: next };
		});
	}, [selected, config.doc, config.loading]);

	const draftConfigJson = draft && draft.dirty && !draft.previewOnly ? JSON.stringify(draft.config) : null;
	react.useEffect(() => {
		if (!draftConfigJson || !selected) return;
		if (registrySeam("__NX_TEST_REGISTRY_CONFIG__") !== null || typeof fetch === "undefined") return;
		if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
		const timer = window.setTimeout(() => {
			let parsed = null;
			try { parsed = JSON.parse(draftConfigJson); } catch { return; }
			fetch(REGISTRY_API + "/validate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ config: parsed }),
				cache: "no-store",
			}).then((res) => registryJson(res).then((body) => {
				const errors = body && body.ok === true ? [] : (body && Array.isArray(body.details) ? body.details : [{ code: "validation-unavailable", path: "", message: "Validation is unavailable right now." }]);
				setDrafts((prev) => {
					if (!prev[selected] || JSON.stringify(prev[selected].config) !== draftConfigJson) return prev;
					return { ...prev, [selected]: { ...prev[selected], validation: errors } };
				});
			})).catch(() => {});
		}, 400);
		return () => { try { window.clearTimeout(timer); } catch {} };
	}, [selected, draftConfigJson]);

	function selectMode(next) {
		setSelected(next);
		registryWritePref(next);
	}
	function patchDraft(next, announcement) {
		setDrafts((prev) => {
			const current = prev[selected] || freshBase;
			if (!current || current.previewOnly) return prev;
			return { ...prev, [selected]: { ...current, config: next, dirty: true, notice: announcement || current.notice, noticeTone: "ok", stale: false } };
		});
	}
	function assignSlot(slotId, patch, announcement) {
		if (!draft || draft.previewOnly) return;
		const next = registryClone(draft.config);
		next.slots = { ...(next.slots || {}), [slotId]: patch };
		patchDraft(next, announcement);
	}
	function overrideRole(role, assignment) {
		if (!draft || draft.previewOnly) return;
		const next = registryClone(draft.config);
		next.roleOverrides = { ...(next.roleOverrides || {}), [role]: assignment };
		patchDraft(next, "Override set for " + (REGISTRY_ROLE_LABELS[role] || role) + "; the slot assignment is untouched.");
	}
	function clearOverride(role) {
		if (!draft || draft.previewOnly) return;
		const next = registryClone(draft.config);
		if (next.roleOverrides) delete next.roleOverrides[role];
		patchDraft(next, "Override cleared for " + (REGISTRY_ROLE_LABELS[role] || role) + "; it follows the slot again.");
	}
	function reloadSaved() {
		setDrafts((prev) => {
			const next = { ...prev };
			delete next[selected];
			return next;
		});
		config.refresh();
		eligible.refresh();
	}
	function changeAdopt(profileId) {
		setAdopts((prev) => ({ ...prev, [selected]: profileId }));
		setDrafts((prev) => {
			const next = { ...prev };
			delete next[selected];
			return next;
		});
	}
	function save() {
		const current = drafts[selected] || freshBase;
		if (!current || current.previewOnly || saving) return;
		if (typeof fetch === "undefined") return;
		setSaving(true);
		const payload = {
			modeId: selected,
			config: current.config,
			expectedRevision: current.baseRevision,
			source: current.baseRevision === null && current.adoptedFrom ? "legacy-adopt" : "operator-save",
			adoptedFrom: current.baseRevision === null ? current.adoptedFrom : null,
		};
		fetch(REGISTRY_API + "/configuration", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			cache: "no-store",
		}).then((res) => registryJson(res).then((body) => {
			if (res.ok && body && body.ok === true) {
				setDrafts((prev) => ({
					...prev,
					[selected]: { ...(prev[selected] || current), config: registryClone(current.config), dirty: false, previewOnly: false, baseRevision: body.revision, notice: "Saved as a staged preference (revision " + body.revision + "). Running sessions are unchanged — activation lands with R6.", noticeTone: "ok", stale: false, resolutionId: body.resolutionId || null, validation: (prev[selected] && prev[selected].validation) || current.validation || [] },
				}));
				config.refresh();
				modes.refresh();
			} else if (res.status === 409) {
				setDrafts((prev) => ({
					...prev,
					[selected]: { ...(prev[selected] || current), notice: "Save rejected: the saved configuration changed elsewhere (stale revision). Reload and re-apply your edits.", noticeTone: "err", stale: true },
				}));
			} else {
				const details = body && Array.isArray(body.details) ? body.details : [];
				setDrafts((prev) => {
					const prior = prev[selected] || current;
					return {
						...prev,
						[selected]: { ...prior, notice: "Save rejected: " + ((body && body.error) || "validation failed") + ".", noticeTone: "err", stale: false, validation: details.length > 0 ? details : prior.validation },
					};
				});
			}
		})).catch(() => {
			setDrafts((prev) => ({
				...prev,
				[selected]: { ...(prev[selected] || current), notice: "Could not save the staged configuration. Try again.", noticeTone: "err", stale: false },
			}));
		}).finally(() => setSaving(false));
	}

	const pendingModes = REGISTRY_MODE_ORDER.filter((id) => drafts[id] && drafts[id].dirty);
	const savedEntry = mode && mode.persisted ? "revision " + mode.savedRevision + (mode.savedValid ? " · valid" : " · INVALID — review below") : "none yet";
	const validationState = !draft ? "—" : draft.previewOnly ? "not applicable (preview only)" : (draft.validation || []).length === 0 ? "valid" : "invalid (" + draft.validation.length + ")";
	const optionList = REGISTRY_MODE_ORDER.map((id) => registryModeById(modes.doc, id)).filter(Boolean);

	return react_jsx_runtime.jsx(Section, {
		label: "Engineering Modes (Registry)",
		children: modes.failed ? react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Registry mode catalog is unavailable right now." })
		: modes.loading || !modes.doc ? react_jsx_runtime.jsx("div", { className: "nx-eng-notice", children: "Loading Registry modes…" })
		: react_jsx_runtime.jsxs("div", {
			children: [
				react_jsx_runtime.jsx("div", {
					className: "nx-reg-banner",
					children: "Staged configuration (R3 preview): saves here are versioned preferences for future activation. They never modify the running session — the legacy controls below stay authoritative until R6.",
				}),
				react_jsx_runtime.jsxs("div", {
					className: "nx-eng-row",
					children: [
						react_jsx_runtime.jsx("span", { className: "nx-eng-label", children: "Mode" }),
						react_jsx_runtime.jsx("select", {
							className: "nx-eng-profile",
							value: selected,
							disabled: saving,
							"aria-label": "Registry Engineering Mode",
							onChange: (event) => selectMode(event.target.value),
							children: optionList.map((m) => react_jsx_runtime.jsx("option", {
								value: m.id,
								title: (m.displayName || m.id) + " — " + registryStatusLabel(m.status),
								children: (m.displayName || m.id) + " — " + registryStatusLabel(m.status) + (m.executable === false ? " · preview only" : "") + (drafts[m.id] && drafts[m.id].dirty ? " · ● unsaved" : ""),
							}, m.id)),
						}),
					],
				}),
				react_jsx_runtime.jsxs("div", {
					className: "nx-reg-status",
					children: [
						react_jsx_runtime.jsx("div", { className: "nx-eng-meta", children: "Saved Registry preference: " + (mode ? (mode.displayName || mode.id) + " · " + savedEntry : "—") }),
						react_jsx_runtime.jsx("div", { className: "nx-eng-meta", children: "Current legacy runtime: " + (legacyRuntimeName || "none") + " (unchanged by Registry saves)" }),
						react_jsx_runtime.jsx("div", { className: "nx-eng-meta", children: "Pending staged changes: " + (pendingModes.length > 0 ? pendingModes.join(", ") + " (kept while switching modes)" : "none") }),
						react_jsx_runtime.jsx("div", { className: "nx-eng-meta", children: "Validation: " + validationState }),
					],
				}),
				config.failed ? react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Mode configuration is unavailable right now." })
				: config.loading || !config.doc ? react_jsx_runtime.jsx("div", { className: "nx-eng-notice", children: "Loading mode configuration…" })
				: react_jsx_runtime.jsx(RegistryConfigBody, {
					mode,
					doc: config.doc,
					bySlot: eligible.bySlot,
					draft,
					onAssign: assignSlot,
					onOverride: overrideRole,
					onClearOverride: clearOverride,
					onSave: save,
					saving,
					onReload: reloadSaved,
					adopt,
					onAdoptChange: changeAdopt,
				}),
			],
		}),
	});
}
//#endregion

function EngineeringEditor({ sessionId }) {
	const editor = useEngineeringEditor(sessionId);
	// R3: the Registry panel is independent of the legacy editor state, so it
	// renders in every branch below. The legacy editor keeps its exact
	// previous states (unavailable / loading / fields) as the second section:
	// it stays the authoritative runtime control until R6.
	const legacyPreferred = editor.state && editor.state.preferredProfile
		? String(editor.state.preferredProfile.displayName || editor.state.preferredProfile.id || "none")
		: "none";
	let legacyBody;
	if (editor.failed) {
		legacyBody = react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Engineering configuration is unavailable right now." });
	} else if (isCatalogUnavailable(editor.state)) {
		// Phase M1.1 CASE B: a current host with an EMPTY Nexus catalog is
		// explicitly reporting an unavailable/invalid catalog — fail closed
		// (never fall back to the legacy Dual list).
		legacyBody = react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Engineering configuration is unavailable right now." });
	} else if (!editor.ready) {
		legacyBody = react_jsx_runtime.jsx("div", { className: "nx-eng-notice", children: "Loading engineering configuration…" });
	} else {
		legacyBody = react_jsx_runtime.jsx(EngineeringEditorFields, { editor, variant: "room" });
	}
	return react_jsx_runtime.jsxs(react.Fragment, {
		children: [
			react_jsx_runtime.jsx(RegistryPanel, { sessionId, legacyRuntimeName: legacyPreferred }),
			react_jsx_runtime.jsx(Section, {
				label: "Engineering Profile",
				children: legacyBody,
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
							: view === "engineering"
								? react_jsx_runtime.jsx(EngineeringEditor, { sessionId })
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

//#region nexus mode bridge (shared client-state contract, TASK-0038)
/**
 * Phase M2.1 mode ownership: the composer must classify the PRE-SESSION
 * (hero / no-session) posture from the mode selector's authoritative client
 * state — never from "no session == legacy", which is what let the upstream
 * DSH model selector survive a restart on the hero screen while the mode
 * picker already showed "Normal Engineering".
 *
 * The contract is a real shared client-state service, not DOM scraping:
 * @nexus/mode-selector publishes its mode store as the `nexusModeState`
 * cordis service; `current` carries the STABLE agent-preset id
 * ("aih-engineering" / "aih-deepseek") — never a display label and never a
 * model id. This bridge is the controller's late-binding consumer: the
 * composition boots the controller row before the mode-selector row, so the
 * service arrives through ctx.inject(["nexusModeState"], ...) after apply;
 * the bridge re-announces both the attachment and every store patch to the
 * React subscription below, which is what makes a hero mode change update
 * the composer posture immediately (no session creation, no refresh, no
 * polling). If the service never appears (mode selector absent), the bridge
 * stays empty and the mode derivation fails closed — the controller still
 * boots.
 */
let nexusModeFacade = null;
let nexusModeFacadeDetach = null;
let nexusModeVersion = 0;
const nexusModeListeners = new Set();
function announceNexusMode() {
	nexusModeVersion += 1;
	for (const listener of [...nexusModeListeners]) {
		try { listener(); } catch { /* bridge observers must not break the composer */ }
	}
}
/** Attach (or clear with null) the shared mode-state facade. Test-visible. */
function attachNexusModeState(facade) {
	const next = facade && typeof facade.getSnapshot === "function" && typeof facade.subscribe === "function" ? facade : null;
	if (next === nexusModeFacade) return;
	if (nexusModeFacadeDetach) {
		const detach = nexusModeFacadeDetach;
		nexusModeFacadeDetach = null;
		try { detach(); } catch { /* a broken prior facade must not block a new one */ }
	}
	nexusModeFacade = next;
	if (nexusModeFacade) {
		nexusModeFacadeDetach = nexusModeFacade.subscribe(announceNexusMode);
	}
	announceNexusMode();
}
/** useSyncExternalStore-compatible subscription over the bridge. */
function subscribeNexusMode(listener) {
	nexusModeListeners.add(listener);
	return () => nexusModeListeners.delete(listener);
}
/** The authoritative pre-session mode: a stable preset id, or "" when the
 * shared state has not landed (the derivation then falls through). */
function currentNexusModePreset() {
	if (!nexusModeFacade) return "";
	const snapshot = nexusModeFacade.getSnapshot();
	return snapshot && typeof snapshot.current === "string" ? snapshot.current : "";
}
//#endregion

//#region nexus engine bridge (shared client-state contract, Phase M3)
/**
* Phase M3 (TASK-0040): the ENGINE mapping of the preferred Nexus profile,
* published as the shared `nexusEngineState` cordis service. The snapshot is
* derived from the engineering editor's authoritative GET document — the same
* state the profile seat renders — so the mode selector can map the user-facing
* Normal Engineering mode onto the preferred engine's INTERNAL agent plane
* (muse → 'aih-muse') for every NEW (blank) session. Dual preferences publish
* engine:'dual' with a null agent preset (no mapping, pre-M3 behavior). A null
* snapshot (no editor fetch yet, or a legacy host) also means no mapping —
* consumers fail closed to the unmodified mode id.
*/
let nexusEngineSnapshot = null;
const nexusEngineListeners = new Set();
function announceNexusEngine() {
	for (const listener of [...nexusEngineListeners]) {
		try { listener(); } catch { /* bridge observers must not break the composer */ }
	}
}
/** Publish (or clear with null) the engine mapping derived from editor state. Test-visible. */
function publishNexusEngineState(editorState) {
	let snapshot = null;
	if (editorState && typeof editorState === "object") {
		const preferred = editorState.preferredProfile && editorState.preferredProfile.id ? String(editorState.preferredProfile.id) : null;
		let engine = "dual";
		if (preferred && Array.isArray(editorState.nexusProfiles)) {
			const wanted = preferred.toLowerCase();
			const entry = editorState.nexusProfiles.find((p) => p && String(p.id || "").toLowerCase() === wanted);
			if (entry && entry.engine) engine = String(entry.engine);
		}
		const presets = editorState.engineAgentPresets && typeof editorState.engineAgentPresets === "object" ? editorState.engineAgentPresets : {};
		// Defense in depth: the catalog validator already omits malformed
		// bindings; the publisher enforces the pinned agent-preset id grammar
		// again so a malformed id can never cross the service boundary.
		const agentPreset = typeof presets[engine] === "string" && /^[a-z0-9][a-z0-9-]*$/.test(presets[engine]) ? presets[engine] : null;
		const route = editorState.preferredRoute;
		const preferredRoute = engine === "muse" && route && typeof route.provider === "string" && route.provider && typeof route.model === "string" && route.model
			? { provider: route.provider, model: route.model }
			: null;
		snapshot = { engine, engineAgentPreset: agentPreset, preferredProfileId: preferred, preferredRoute };
	}
	const changed = JSON.stringify(snapshot) !== JSON.stringify(nexusEngineSnapshot);
	nexusEngineSnapshot = snapshot;
	if (changed) announceNexusEngine();
}
function subscribeNexusEngine(listener) {
	nexusEngineListeners.add(listener);
	return () => nexusEngineListeners.delete(listener);
}
function nexusEngineStateSnapshot() {
	return nexusEngineSnapshot;
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
/**
* Derive the composer PREFERRED engineer from a loaded editor state: the
* preferred profile's primaryEngineer binding resolved through the same
* registry the editor dropdowns render. Mirrors the snapshot's
* composer.preferredEngineer field (status.cjs) field-for-field.
*/
function preferredEngineerFromEditorState(editorState) {
	if (!editorState || !editorState.preferredProfile || !Array.isArray(editorState.profiles)) return null;
	const profileId = String(editorState.preferredProfile.id || "");
	const profile = editorState.profiles.find((p) => p && String(p.id) === profileId);
	const binding = profile && profile.roles ? profile.roles.primaryEngineer : null;
	if (!binding || !binding.model) return null;
	const entry = Array.isArray(editorState.registry) ? editorState.registry.find((m) => m && String(m.id) === binding.model) || null : null;
	return {
		profileId,
		profileDisplayName: String(editorState.preferredProfile.displayName || profileId),
		modelId: String(binding.model),
		modelDisplayName: entry ? String(entry.displayName || entry.id || binding.model) : String(binding.model),
		vendor: entry && entry.vendor ? String(entry.vendor) : null,
		reasoning: String(binding.reasoning || ""),
	};
}

/**
* PREFERRED engineer for the composer pill (engineering mode only). The
* editor state is refetched immediately after a successful save, so while
* it is FRESHER than the last polled snapshot it carries the new preference
* before the poll does; otherwise the polled snapshot — the shared truth
* both surfaces agree on — wins. Never consulted for RUNNING.
*/
function composerPreferredEngineer(snapshot, editor) {
	const composer = snapshot && snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : null;
	if (!composer || composer.mode !== "engineering") return null;
	const snapshotAt = Date.parse(String(snapshot.generatedAtUtc || "")) || 0;
	const editorAt = editor && typeof editor.fetchedAt === "number" ? editor.fetchedAt : 0;
	if (editor && editor.state && editorAt >= snapshotAt) {
		const derived = preferredEngineerFromEditorState(editor.state);
		if (derived) return derived;
	}
	return composer.preferredEngineer && typeof composer.preferredEngineer === "object" ? composer.preferredEngineer : null;
}

function executorChipContent(snapshot, editor, composerMode) {
	if (!snapshot || snapshot.error) return null;
	const composer = snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : null;
	// TASK-0038: the pills obey the SAME authoritative mode the chip derived
	// (snapshot -> session preset -> shared mode selection). The snapshot's
	// own composer block is only the fallback when the caller has no derived
	// mode — otherwise a hero Engineering posture (mode selection, no composer
	// block yet) would still render the legacy agent-default-model preference.
	const engineeringMode = composerMode !== undefined
		? composerMode === "engineering"
		: !!(composer && composer.mode === "engineering");
	const modelName = snapshot.execution && typeof snapshot.execution.model === "string" && snapshot.execution.model ? snapshot.execution.model : null;
	const effectiveReasoning = snapshot.execution && typeof snapshot.execution.reasoning === "string" && snapshot.execution.reasoning ? snapshot.execution.reasoning : null;
	let preference = null;
	let preferenceReasoning = null;
	if (engineeringMode) {
		// Normal Engineering mode: PREFERRED is the preferred profile's
		// primaryEngineer binding (Model Registry displayName) — NEVER the
		// legacy DSH agent-default-model selection. An unsatisfiable binding
		// omits the chip entirely (fail-closed: no misleading label).
		const preferred = composerPreferredEngineer(snapshot, editor);
		if (preferred) {
			preference = preferred.modelDisplayName || preferred.modelId || null;
			preferenceReasoning = preferred.reasoning || null;
		}
	} else {
		preference = snapshot.preference && typeof snapshot.preference.label === "string" && snapshot.preference.label ? snapshot.preference.label : null;
		preferenceReasoning = snapshot.preference && typeof snapshot.preference.reasoning === "string" && snapshot.preference.reasoning ? snapshot.preference.reasoning : null;
	}
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
/**
* Composer Engineering selector (Normal Engineering mode only): the compact
* trigger + anchored popover that REPLACES the legacy DSH model selector as
* the operator's effective model-preference control. Reuses the shared
* editor hook — the exact same profile/role state, validation, and save
* flow as the Control Room Engineering tab; unsaved edits survive closing
* and reopening because the state lives here, above the popover.
*/
function EngineeringSelector({ editor }) {
	const [open, setOpen] = react.useState(false);
	const rootRef = react.useRef(null);
	react.useEffect(() => {
		if (!open) return;
		const closeOutside = (event) => {
			if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
		};
		const closeEscape = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", closeOutside);
		document.addEventListener("keydown", closeEscape);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
			document.removeEventListener("keydown", closeEscape);
		};
	}, [open]);
	const ready = !editor.failed && editor.ready;
	return react_jsx_runtime.jsxs("span", {
		className: "nx-eng-composer",
		ref: rootRef,
		children: [
			react_jsx_runtime.jsx("button", {
				type: "button",
				className: "nx-eng-trigger",
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				title: "Engineering profile — the PREFERRED engineer applies at the next safe execution boundary",
				onClick: () => setOpen(!open),
				children: [
					react_jsx_runtime.jsx("span", { className: "nx-eng-trigger-label", children: editor.failed || isCatalogUnavailable(editor.state) ? "Engineering configuration unavailable" : !ready ? "Profile · Loading" : "Profile" }, "label"),
					react_jsx_runtime.jsx("span", { className: "nx-eng-trigger-caret", children: "▾" }, "caret"),
				],
			}),
			open && react_jsx_runtime.jsx("div", {
				className: "nx-eng-popover",
				role: "dialog",
				"aria-label": "Engineering profile",
				children: editor.failed
					? react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Engineering configuration is unavailable right now." })
					: editor.state && isCatalogUnavailable(editor.state)
						? react_jsx_runtime.jsx("div", { className: "nx-eng-notice nx-eng-notice-err", children: "Engineering configuration is unavailable right now." })
						: !ready
							? react_jsx_runtime.jsx("div", { className: "nx-eng-notice", children: "Loading engineering configuration…" })
							: react_jsx_runtime.jsx(EngineeringEditorFields, { editor, variant: "composer" }),
			}),
		],
	});
}

/**
* Composer mode derivation shared by the preference owner and executor pills.
*/
/**
 * The stable preset-id → composer-mode classification. The SAME ids the
 * mode selector offers and a session carries for its whole life; display
 * labels and model ids are deliberately never consulted.
 */
const NEXUS_COMPOSER_PRESET_MODES = Object.freeze({
	"aih-engineering": "engineering",
	"aih-muse": "engineering",
	"aih-deepseek": "legacy",
});
/** Classify a preset id, or return null when it is not a known Nexus mode. */
function classifyNexusPreset(preset) {
	if (typeof preset !== "string" || preset === "") return null;
	return Object.prototype.hasOwnProperty.call(NEXUS_COMPOSER_PRESET_MODES, preset)
		? NEXUS_COMPOSER_PRESET_MODES[preset]
		: null;
}
/**
 * Phase M2.1 restart fix (TASK-0037) + mode-ownership fix (TASK-0038):
 * derive the composer mode from the authoritative source for the CURRENT
 * lifecycle state, before the first polled snapshot arrives and after it.
 *
 * Root cause of the hero bug (TASK-0038): the pre-session (hero / no-session)
 * state was classified as legacy outright, so the mode picker could already
 * show "Normal Engineering" while the composer still rendered the upstream
 * DSH model seat and no Engineering Profile UI. A session-less scope is a
 * lifecycle state with its OWN authority — the mode selector's client
 * state — never a legacy verdict.
 *
 * Resolution order:
 *   1. ACTIVE SESSION — the authoritative snapshot.composer.mode wins once
 *      loaded (it folds the session binding, the preset, and the routing
 *      policy into one server-side verdict);
 *   2. ACTIVE SESSION — before that, the session's agent preset (client-side
 *      ConversationSnapshot carries agentPreset / projectionValues.agentPreset,
 *      and a composer-less snapshot still names the preset on its binding)
 *      classifies the boot: aih-engineering/aih-muse -> engineering,
 *      aih-deepseek -> legacy;
 *   3. PRE-SESSION (hero, including a session object without a preset yet) —
 *      the mode selector's authoritative client state (nexusPreset: the
 *      staged selection or the persisted default) classifies the posture;
 *      a staged hero mode change lands here synchronously;
 *   4. anything else — including a failed/absent snapshot (endpoint
 *      unavailable) and no mode state at all — fails CLOSED toward
 *      engineering, keeping the Profile UI mounted with its loading states
 *      until an authoritative mode lands.
 *
 * A session-less snapshot is deliberately NOT authoritative for the hero:
 * it describes the persisted DEFAULT mode, which a staged hero selection
 * outranks until a session is created.
 */
function composerModeOfSession(session, snapshot, nexusPreset) {
	if (session) {
		const composer = snapshot && snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : null;
		if (composer && composer.mode === "engineering") return { mode: "engineering", source: "snapshot" };
		if (composer && composer.mode === "legacy") return { mode: "legacy", source: "snapshot" };
		let preset = typeof session.agentPreset === "string" ? session.agentPreset : "";
		if (preset === "" && session.projectionValues && typeof session.projectionValues === "object" && typeof session.projectionValues.agentPreset === "string") {
			preset = session.projectionValues.agentPreset;
		}
		if (preset === "" && snapshot && snapshot.binding && typeof snapshot.binding.preset === "string") {
			// A snapshot whose composer block has not landed yet still names the
			// session's agent preset on its binding — a stronger signal than the
			// client-side projection alone.
			preset = snapshot.binding.preset;
		}
		const sessionMode = classifyNexusPreset(preset);
		if (sessionMode) return { mode: sessionMode, source: "session-preset" };
	}
	// Pre-session (or a session whose preset is not known yet): the mode
	// selector's client state is the authority for "which Nexus mode is
	// currently selected/default".
	const selectedMode = classifyNexusPreset(nexusPreset);
	if (selectedMode) return { mode: selectedMode, source: "mode-selection" };
	return { mode: "engineering", source: "boot-fail-closed" };
}

function useComposerState(session, explicitSessionId) {
	const sessionId = explicitSessionId || (session && typeof session.sessionId === "string" ? session.sessionId : null);
	const { snapshot } = useControllerSnapshot(sessionId);
	// Phase M2.1 (TASK-0038): the pre-session posture rides the shared
	// nexusModeState service (subscription re-renders synchronously with the
	// mode picker's store, so a hero mode change updates immediately).
	const nexusPreset = react.useSyncExternalStore(subscribeNexusMode, currentNexusModePreset, currentNexusModePreset);
	const derivedMode = composerModeOfSession(session, snapshot, nexusPreset);
	const engineeringMode = derivedMode.mode === "engineering";
	// The global profile catalog loads whenever the Engineering surface is
	// enabled — hero included (no sessionId gate; the endpoint is global).
	const editor = useEngineeringEditor(sessionId, engineeringMode);
	// Follow external preference changes (e.g. saved from the Control Room)
	// without clobbering unsaved operator edits in the open popover.
	const composer = snapshot && snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : null;
	const preferredProfileId = composer && composer.preferredEngineer && typeof composer.preferredEngineer === "object" ? String(composer.preferredEngineer.profileId || "") : "";
	const dirtyRef = react.useRef(editor.dirty);
	dirtyRef.current = editor.dirty;
	const seenProfileRef = react.useRef(preferredProfileId);
	react.useEffect(() => {
		if (!engineeringMode) return;
		if (seenProfileRef.current === preferredProfileId) return;
		seenProfileRef.current = preferredProfileId;
		if (!dirtyRef.current) editor.refresh();
	}, [engineeringMode, preferredProfileId, editor.refresh]);
    return { snapshot, editor, derivedMode, nexusPreset };
}

// Additive execution status has no responsibility for the preference control.
function ExecutorChip({ session }) {
    const { snapshot, editor, derivedMode } = useComposerState(session);
    return react_jsx_runtime.jsx(ExecutorPill, {
        content: executorChipContent(snapshot, derivedMode.mode === "engineering" ? editor : null, derivedMode.mode),
    });
}

// Installed into the pinned model seat by Patch-NexusComposer.ps1. The original
// upstream component is supplied as a React element, so its hooks run ONLY in
// legacy mode. No DOM mutation, slot priority race, or copied Model/Effort UI.
function ComposerPreference({ sessionId, useSession, useSessions, legacy }) {
    const session = useSession ? useSession((value) => value) : null;
    const sessions = useSessions ? useSessions((value) => value) : null;
    const summary = sessions && sessions.byId ? sessions.byId[sessionId] : null;
    // A blank session still displays the hero picker. Its staged selection
    // outranks a polled snapshot of the previous preset during mode switching.
    const current = !sessionId || (summary && summary.blank) ? null : session;
    const { editor, derivedMode, nexusPreset } = useComposerState(current, sessionId);
    if (derivedMode.mode === "legacy" && !legacy) return null;
    return react_jsx_runtime.jsx("span", {
        "data-nexus-preference-owner": derivedMode.mode === "engineering" ? "profiles" : "upstream-model",
        "data-nexus-composer-mode": derivedMode.mode,
        "data-nexus-mode-source": derivedMode.source,
        "data-nexus-preset": nexusPreset,
        children: derivedMode.mode === "engineering"
            ? react_jsx_runtime.jsx(EngineeringSelector, { editor })
            : legacy,
    });
}
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
".nx-eng{display:flex;flex-direction:column;gap:8px;padding:2px 0 6px}",
".nx-eng-row{display:flex;align-items:center;gap:6px;min-width:0}",
".nx-eng-label{flex:none;width:104px;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-weight:600;letter-spacing:.02em}",
".nx-eng-select{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:3px 4px;font-family:var(--ds-font-family-ui, inherit)}",
".nx-eng-select:disabled{opacity:.55;cursor:not-allowed}",
".nx-eng-reason{flex:none;width:82px;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:3px 4px;font-family:var(--ds-font-family-ui, inherit)}",
".nx-eng-value{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-primary);padding:3px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".nx-eng-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}",
".nx-eng-profile{flex:1;font-size:11.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:4px 6px;font-family:var(--ds-font-family-ui, inherit)}",
".nx-eng-notice{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover)}",
".nx-eng-notice-ok{color:var(--dsw-alias-state-success-primary)}",
".nx-eng-notice-err{color:var(--dsw-alias-state-error-primary)}",
".nx-eng-save{align-self:flex-start;margin-top:2px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-business-primary);border:none;border-radius:6px;padding:5px 14px;cursor:pointer}",
".nx-eng-save:disabled{opacity:.5;cursor:wait}",
".nx-eng-meta{font-size:10px;color:var(--dsw-alias-label-tertiary);line-height:1.45}",
".nx-eng-hint{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
".nx-reg-banner{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1);margin-bottom:6px}",
".nx-reg-status{display:flex;flex-direction:column;gap:2px;margin:6px 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3, transparent)}",
".nx-reg-slot{display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:6px 0;min-width:0}",
".nx-reg-slot-head{font-size:11px;font-weight:700;color:var(--dsw-alias-label-primary);letter-spacing:.02em}",
".nx-reg-routes{border:none;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:3px}",
".nx-reg-routes legend{padding:0;margin-bottom:2px}",
".nx-reg-radio{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}",
".nx-reg-radio input{flex:none}",
".nx-reg-radio span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".nx-reg-radio-off{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}",
".nx-reg-tier{font-size:10.5px;font-weight:600;color:var(--dsw-alias-state-warn-primary);line-height:1.45}",
".nx-reg-adv{margin:8px 0;padding:8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;display:flex;flex-direction:column;gap:6px;min-width:0}",
".nx-reg-adv-head{font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}",
".nx-reg-adv-row{display:flex;flex-direction:column;gap:3px;min-width:0}",
".nx-reg-adv-title{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-primary)}",
".nx-reg-tag{font-size:9px;font-weight:600;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
".nx-reg-tag-dim{opacity:.7}",
".nx-reg-clear{align-self:flex-start;font-size:10px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 8px;cursor:pointer}",
".nx-reg-errors{display:flex;flex-direction:column;gap:3px;margin:4px 0}",
".nx-reg-save-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}",
".nx-executor-chip{display:inline-flex;align-items:center;gap:8px;min-width:0}",
".nx-eng-composer{position:relative;display:inline-flex;align-items:center}",
".nx-eng-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-elevated);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer}",
".nx-eng-trigger:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg)}",
".nx-eng-trigger-caret{font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary)}",
".nx-eng-popover{position:absolute;bottom:calc(100% + 8px);right:0;z-index:60;width:360px;max-width:min(92vw,420px);max-height:72vh;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 30px rgba(0,0,0,.3);color:var(--dsw-alias-label-secondary);font-size:11px}",
".nx-eng-popover .nx-eng-profile{max-width:216px}",
".nx-eng-popover .nx-eng-save{margin-top:4px}",
].join("");
//#endregion

//#region apply
/** Required client service: the UI slot registry. */
const inject = ["slots", "workspaces"];
function apply(ctx) {
	ctx.provide("nexusComposerPreference", { Component: ComposerPreference });
	// Phase M3 (TASK-0040): the shared engine mapping service consumed by the
	// mode selector (see the nexus engine bridge region). Published by this
	// plugin because the engineering editor owns the authoritative GET state;
	// the snapshot is null until the first editor fetch lands.
	ctx.provide("nexusEngineState", {
		getSnapshot: () => nexusEngineStateSnapshot(),
		subscribe: subscribeNexusEngine,
	});
	if (ctx.workspaces && ctx.workspaces.list) {
	// Keep the UI Workspace registry and Nexus Phase 3.1 repository foundation
	// on one identity path. Existing/recent workspaces are reconciled once at
	// startup; newly opened folders are reconciled when the Workspace baseline
	// changes. The host canonicalizes and validates every path.
	ctx.effect(() => {
		let disposed = false;
		const registered = /* @__PURE__ */ new Set();
		const registerPath = async (path) => {
			const key = String(path || "").replaceAll("/", "\\").toLocaleLowerCase();
			if (key === "" || registered.has(key)) return;
			registered.add(key);
			try {
				const response = await fetch("/nexus/workspace-registration.json", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path })
				});
				if (!response.ok) registered.delete(key);
			} catch {
				registered.delete(key);
			}
		};
		const reconcile = () => {
			if (disposed) return;
			const snapshot = ctx.workspaces.list.getSnapshot();
			if (snapshot.phase !== "ready") return;
			for (const workspace of snapshot.items) registerPath(workspace.path);
		};
		const unsubscribe = ctx.workspaces.list.subscribe(reconcile);
		reconcile();
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, "nexus-controller: Phase 3.1 workspace reconciliation");
	// `aih -Open <path>` uses a URL-scoped handoff. It never mutates server cwd
	// and works against an already-running universal Nexus process: register or
	// reuse the DSH Workspace, then create/open its blank session. The query is
	// consumed exactly once so reload cannot create another conversation.
	ctx.effect(() => {
		const url = new URL(window.location.href);
		const requestedPath = url.searchParams.get("nexus-open");
		if (requestedPath === null || requestedPath.trim() === "") return;
		let disposed = false;
		let started = false;
		const consume = async () => {
			if (disposed || started) return;
			const snapshot = ctx.workspaces.list.getSnapshot();
			if (snapshot.phase !== "ready") return;
			started = true;
			try {
				const registration = await fetch("/nexus/workspace-registration.json", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: requestedPath })
				});
				if (!registration.ok) throw new Error("Nexus workspace registration failed");
				const key = requestedPath.replaceAll("/", "\\").replace(/[\\]+$/g, "").toLocaleLowerCase();
				let workspace = snapshot.items.find((item) => item.path.replaceAll("/", "\\").replace(/[\\]+$/g, "").toLocaleLowerCase() === key);
				if (workspace === void 0) workspace = await ctx.workspaces.create({ path: requestedPath });
				if (!disposed) ctx.workspaces.startSession(workspace.workspaceId);
			} catch (reason) {
				console.warn("Nexus workspace handoff failed:", reason);
			} finally {
				url.searchParams.delete("nexus-open");
				window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
			}
		};
		const unsubscribe = ctx.workspaces.list.subscribe(consume);
		consume();
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, "nexus-controller: launcher workspace handoff");
	}
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
	// Phase M2.1 (TASK-0038): consume the mode selector's authoritative client
	// state (see the nexus mode bridge region). The nested inject is
	// order-independent: the composition boots this plugin before
	// @nexus/mode-selector, so the shared state arrives here whenever the
	// service is provided; if it never is (mode selector absent from the
	// composition), the composer keeps its fail-closed derivation and the
	// controller still boots.
	ctx.inject(["nexusModeState"], (scope) => {
		attachNexusModeState(scope.nexusModeState);
	});
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
exports.composerModeOfSession = composerModeOfSession;
exports.classifyNexusPreset = classifyNexusPreset;
exports.ComposerPreference = ComposerPreference;
exports.attachNexusModeState = attachNexusModeState;
exports.subscribeNexusMode = subscribeNexusMode;
exports.currentNexusModePreset = currentNexusModePreset;
exports.publishNexusEngineState = publishNexusEngineState;
exports.subscribeNexusEngine = subscribeNexusEngine;
exports.nexusEngineStateSnapshot = nexusEngineStateSnapshot;
exports.ExecutorPill = ExecutorPill;
exports.ExecutorChip = ExecutorChip;
exports.GateActions = GateActions;
exports.EngineeringEditor = EngineeringEditor;
exports.useEngineeringEditor = useEngineeringEditor;
exports.engineeringEditorLoadGate = engineeringEditorLoadGate;
exports.EngineeringEditorFields = EngineeringEditorFields;
exports.RegistryPanel = RegistryPanel;
exports.RegistrySlotCard = RegistrySlotCard;
exports.RegistryAdvanced = RegistryAdvanced;
exports.RegistryConfigBody = RegistryConfigBody;
exports.useRegistryModes = useRegistryModes;
exports.useRegistryConfiguration = useRegistryConfiguration;
exports.useRegistryEligible = useRegistryEligible;
exports.registryDraftFromDoc = registryDraftFromDoc;
exports.registryModelsOfSlot = registryModelsOfSlot;
exports.EngineeringSelector = EngineeringSelector;
exports.preferredEngineerFromEditorState = preferredEngineerFromEditorState;
exports.hasNexusCatalogContract = hasNexusCatalogContract;
exports.userFacingProfiles = userFacingProfiles;
exports.isCatalogUnavailable = isCatalogUnavailable;
exports.initialProfileChoice = initialProfileChoice;
exports.activityKindTitle = activityKindTitle;
return module.exports;
}
});
