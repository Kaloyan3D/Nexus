window.__ModuleLoader__.load({
  id: "@nexus/mode-selector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    // Internal bootstrap ONLY (Phase M2.1): the MODE KEYS are the agent-preset
    // ids a session carries for its whole life ("aih-engineering" /
    // "aih-deepseek") and are the stable contract the controller's composer
    // boot heuristic classifies on. The model values below are the LEGACY DSH
    // agent-default-model bindings applied at session creation; in engineering
    // mode the Engineering Profile selector supersedes them, so treat this
    // table as UI bootstrap plumbing, not as a model-preference surface.
    const MODE_SELECTIONS = Object.freeze({
      "aih-engineering": Object.freeze({
        provider: "flash-max-direct",
        model: "deepseek-v4-flash",
        reasoningEffort: "max"
      }),
      "aih-deepseek": Object.freeze({
        provider: "flash-max-direct",
        model: "deepseek-v4-flash",
        reasoningEffort: "max"
      })
    });
    const SUPPORTED_MODES = new Set(Object.keys(MODE_SELECTIONS));
    const AGENT_PRESET_SETTINGS_NS = "agent-presets";

    function presetOf(session) {
      if (session && typeof session.agentPreset === "string") return session.agentPreset;
      const value = session && session.projectionValues && session.projectionValues.agentPreset;
      return typeof value === "string" ? value : void 0;
    }

    function currentSession(scope) {
      const state = scope.sessions.list.getSnapshot();
      return state.current === void 0 ? void 0 : state.byId[state.current];
    }

    function displayedPreset(session, fallback) {
      const value = presetOf(session);
      return value !== void 0 && SUPPORTED_MODES.has(value) ? value : fallback;
    }

    function sameSelection(left, right) {
      return !!left && left.provider === right.provider && left.model === right.model && (left.reasoningEffort || void 0) === (right.reasoningEffort || void 0);
    }

    // Phase M3 (TASK-0040): the ENGINE plane of a new session follows the
    // preferred Nexus profile, not the mode label. The mode picker keeps its
    // two user-facing modes; when the controller's shared `nexusEngineState`
    // says the preferred profile selects engine=muse, the Normal Engineering
    // mode maps onto the engine's INTERNAL agent preset ('aih-muse') for the
    // blank session about to be configured. Every other engine — and any
    // condition where the mapping is not provably available (service absent,
    // snapshot null, malformed id, host without the preset) — maps to the
    // mode id itself, which is exactly the pre-M3 behavior. Fail closed to
    // legacy, never to a guessed preset id.
    function resolveEnginePreset(engineState, knownPresetIds, modeId) {
      if (modeId !== "aih-engineering") return modeId;
      if (!engineState || typeof engineState.getSnapshot !== "function") return modeId;
      let snapshot;
      try { snapshot = engineState.getSnapshot(); } catch { return modeId; }
      if (!snapshot || snapshot.engine !== "muse") return modeId;
      const agentPreset = typeof snapshot.engineAgentPreset === "string" ? snapshot.engineAgentPreset : "";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(agentPreset)) return modeId;
      if (!knownPresetIds || !knownPresetIds.has(agentPreset)) return modeId;
      return agentPreset;
    }

    function createModeStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        patch: (patch) => {
          snapshot = { ...snapshot, ...patch };
          for (const listener of [...listeners]) {
            try { listener(); } catch { /* UI observers must not break mode state */ }
          }
        }
      };
    }

    function createModeController(scope) {
      // Pinned DSH separates RPC (connection.api) from events (remote.$on).
      const api = scope.get("connection").api;
      const store = createModeStore({ options: [], current: "", busy: false, error: null });
      let fallback = "";
      let staged;
      let applying = false;
      let disposed = false;
      // Phase M3: the shared engine mapping arrives late (the controller row
      // boots before this plugin and publishes `nexusEngineState`); it is
      // attached like the controller's own mode bridge. Null until then.
      let engineState = null;
      let stopEngineState = null;
      let knownPresetIds = new Set();
      let engineAutoApplyFailed = false;

      async function load() {
        try {
        const { result } = await api.agentPresets.list({});
        if (disposed) return;
        if (!result.ok) {
          store.patch({ error: result.error.message || "Unable to read Nexus modes." });
          return;
        }
        const presets = result.value.presets || [];
        knownPresetIds = new Set(presets.map((preset) => preset && preset.id ? String(preset.id) : "").filter(Boolean));
        const options = presets
          .filter((preset) => SUPPORTED_MODES.has(preset.id) && preset.broken === void 0)
          .map((preset) => ({ id: preset.id, name: preset.name || preset.id, description: preset.description || "" }));
        const defaultPreset = presets.find((preset) => SUPPORTED_MODES.has(preset.id) && preset.isDefault && preset.broken === void 0);
        fallback = defaultPreset ? defaultPreset.id : options[0] ? options[0].id : "";
        const session = currentSession(scope);
        store.patch({
          options,
          current: staged !== void 0 ? staged : session === void 0 ? fallback : displayedPreset(session, fallback),
          error: options.length === 0 ? "Nexus modes are not installed." : null
        });
        } catch (error) {
          if (!disposed) store.patch({ error: error instanceof Error ? error.message : String(error) });
        }
      }

      async function persistDefault(id) {
        const { result } = await api.settings.update({ ns: AGENT_PRESET_SETTINGS_NS, patch: { default: id } });
        if (!result.ok) throw new Error(result.error.message || "Failed to persist the Nexus mode.");
      }

      async function syncModel(sessionId, id) {
        const selection = MODE_SELECTIONS[id];
        if (!selection) return;
        const directory = scope.modelDirectories.directoryFor(sessionId);
        try { await directory.load(); } catch { /* select below carries the authoritative failure */ }
        if (sameSelection(directory.store.getSnapshot().current, selection)) return;
        await directory.select(selection);
      }

      async function settleAppliedMode(session, id) {
        await syncModel(session.id, id);
        staged = void 0;
        fallback = id;
        try {
          await persistDefault(id);
          store.patch({ current: id, busy: false, error: null });
        } catch (error) {
          store.patch({
            current: id,
            busy: false,
            error: "Mode applied, but Nexus could not save it as the default: " + (error instanceof Error ? error.message : String(error))
          });
        }
      }

      async function applyStaged() {
        if (disposed || applying) return;
        const id = staged;
        if (id === void 0) {
          const session = currentSession(scope);
          const current = session === void 0 ? fallback : displayedPreset(session, fallback);
          if (current && current !== store.getSnapshot().current) store.patch({ current });
          // Phase M3: engine-derived plane auto-application. The preferred
          // profile's engine decides the agent plane for every NEW (blank)
          // session even without an explicit mode re-selection: a muse
          // preference maps the Normal Engineering mode onto 'aih-muse'. Dual
          // preferences resolve to the mode id itself (no behavior change),
          // and a non-blank session is never reconfigured here (the engine
          // applies from the next session; the profile seat says so).
          if (!engineAutoApplyFailed && session !== void 0 && session.blank && current && SUPPORTED_MODES.has(current)) {
            const effectiveId = resolveEnginePreset(engineState, knownPresetIds, current);
            if (presetOf(session) !== effectiveId) {
              staged = current;
              void applyStaged();
            }
          }
          return;
        }
        const session = currentSession(scope);
        if (session === void 0) return;

        // Permanent replacement for the old upstream monkey patch: choosing a
        // mode while an older running Session is still current keeps the stage
        // alive until New Session produces (or reuses) a blank Session.
        if (!session.blank) {
          // A running Session must never be reconfigured underneath its history.
          // If it already carries this preset, the visible choice needs no work;
          // otherwise keep the stage for the blank Session that New Session creates.
          if (presetOf(session) === id) {
            staged = void 0;
            store.patch({ current: id, busy: false, error: null });
          }
          return;
        }

        // Phase M3: the MODE id the user chose is what gets persisted and
        // displayed; the AGENT PLANE applied to the blank session is the
        // engine-mapped one (muse preference → 'aih-muse').
        const effectiveId = resolveEnginePreset(engineState, knownPresetIds, id);
        applying = true;
        store.patch({ busy: true, error: null });
        try {
          if (presetOf(session) !== effectiveId) {
            const { result } = await api.agentPresets.select({ sessionId: session.id, agentPreset: effectiveId });
            if (!result.ok) throw new Error(result.error.message || "Failed to apply the Nexus mode.");
            scope.sessions.noteAgentPreset(session.id, result.value.agentPreset);
          }
          engineAutoApplyFailed = false;
          await settleAppliedMode(session, id);
        } catch (error) {
          engineAutoApplyFailed = true;
          if (!disposed) {
            store.patch({ busy: false, error: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          applying = false;
        }
      }

      async function select(id) {
        if (!SUPPORTED_MODES.has(id) || store.getSnapshot().busy) return;
        staged = id;
        store.patch({ current: id, error: null });
        await applyStaged();
      }

      const stopSessions = scope.sessions.list.subscribe(() => { void applyStaged(); });
      const stopSettings = scope.remote.$on("settings/document-updated", (ns) => {
        if (ns === AGENT_PRESET_SETTINGS_NS && staged === void 0) void load();
      });

      function attachEngineState(facade) {
        if (stopEngineState) {
          try { stopEngineState(); } catch { /* bridge teardown must not break mode state */ }
          stopEngineState = null;
        }
        engineState = facade && typeof facade.getSnapshot === "function" ? facade : null;
        engineAutoApplyFailed = false;
        if (engineState && typeof engineState.subscribe === "function") {
          stopEngineState = engineState.subscribe(() => {
            engineAutoApplyFailed = false;
            if (!disposed) void applyStaged();
          });
        }
        if (!disposed) void applyStaged();
      }

      return {
        store,
        load,
        select,
        attachEngineState,
        dispose: () => {
          disposed = true;
          if (stopEngineState) {
            try { stopEngineState(); } catch { /* best-effort bridge cleanup */ }
            stopEngineState = null;
          }
          stopSessions();
          stopSettings();
        }
      };
    }

    function NexusModePicker({ useNexusMode, load, select }) {
      const state = useNexusMode((value) => value);
      react.useEffect(() => { void load(); }, [load]);
      if (!state || (state.options.length === 0 && !state.error)) return null;
      return react_jsx_runtime.jsxs("div", {
        style: { display: "flex", alignItems: "center", gap: 8, minHeight: 30 },
        children: [
          react_jsx_runtime.jsx("span", {
            style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", letterSpacing: ".04em" },
            children: "MODE"
          }),
          react_jsx_runtime.jsx("select", {
            value: state.current,
            disabled: state.busy || state.options.length === 0,
            title: state.error || "Choose the Nexus mode for the next session",
            onChange: (event) => { void select(event.target.value); },
            style: {
              height: 30,
              maxWidth: 260,
              padding: "0 28px 0 10px",
              borderRadius: 8,
              border: "1px solid var(--dsw-alias-border-l2)",
              background: "var(--dsw-alias-bg-layer-3)",
              color: state.error ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)",
              fontSize: 12,
              fontWeight: 600,
              cursor: state.busy ? "wait" : "pointer"
            },
            children: state.options.map((option) => react_jsx_runtime.jsx("option", {
              value: option.id,
              title: option.description,
              children: option.name
            }, option.id))
          }),
          state.busy ? react_jsx_runtime.jsx("span", {
            style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)" },
            children: "Applying…"
          }) : null,
          state.error ? react_jsx_runtime.jsx("span", {
            style: { maxWidth: 280, fontSize: 10, color: "var(--dsw-alias-state-error-primary)" },
            children: state.error
          }) : null
        ]
      });
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.inject([
        "slots",
        "sessions",
        "modelDirectories",
        "connection",
        "remote"
      ], (scope) => {
        const controller = createModeController(scope);
        // Phase M2.1 (TASK-0038): publish this picker's authoritative client
        // state as the shared `nexusModeState` cordis service. `current` is
        // the STABLE agent-preset id ("aih-engineering" / "aih-deepseek") —
        // never a display label and never a model id — so the controller's
        // composer seat classifies the pre-session (hero) posture from the
        // exact state this picker renders, including a mode change staged
        // before any session exists (the store patches synchronously on
        // select). The facade is deliberately tiny (getSnapshot/subscribe);
        // the store above remains the single source of truth.
        scope.provide("nexusModeState", {
          getSnapshot: () => controller.store.getSnapshot(),
          subscribe: (listener) => controller.store.subscribe(listener),
        });
        // Phase M3 (TASK-0040): consume the controller's shared engine
        // mapping (preferred profile engine → internal agent preset). The
        // controller row boots before this plugin, so the service is already
        // provided when this inject runs; if the controller is absent the
        // mapping stays null and every mode resolves to itself (pre-M3).
        ctx.inject(["nexusEngineState"], (engineScope) => {
          controller.attachEngineState(engineScope.nexusEngineState);
        });
        scope.effect(() => controller.dispose, "nexus-mode-selector: controller lifecycle");
        scope.slots.inject("conversation.hero.agentPreset", () => scope.slots.register({
          name: "conversation.hero.agentPreset",
          priority: -100,
          label: "Nexus mode",
          inject: () => ({
            hooks: { nexusMode: controller.store },
            load: controller.load,
            select: controller.select
          })
        }, NexusModePicker));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.MODE_SELECTIONS = MODE_SELECTIONS;
    exports.presetOf = presetOf;
    exports.sameSelection = sameSelection;
    exports.resolveEnginePreset = resolveEnginePreset;
    exports.createModeController = createModeController;
    return module.exports;
  }
});
