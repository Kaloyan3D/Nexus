window.__ModuleLoader__.load({
  id: "@nexus/mode-selector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

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
      const store = createModeStore({ options: [], current: "", busy: false, error: null });
      let fallback = "";
      let staged;
      let applying = false;
      let disposed = false;

      async function load() {
        const result = await scope.remote.agentPresets.list();
        if (disposed) return;
        if (!result.ok) {
          store.patch({ error: result.error.message || "Unable to read Nexus modes." });
          return;
        }
        const presets = result.value.presets || [];
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
      }

      async function persistDefault(id) {
        const result = await scope.remote.settings.update(AGENT_PRESET_SETTINGS_NS, { default: id }, void 0);
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

        applying = true;
        store.patch({ busy: true, error: null });
        try {
          if (presetOf(session) !== id) {
            const result = await scope.remote.agentPresets.select(session.id, id);
            if (!result.ok) throw new Error(result.error.message || "Failed to apply the Nexus mode.");
          }
          await settleAppliedMode(session, id);
        } catch (error) {
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

      return {
        store,
        load,
        select,
        dispose: () => {
          disposed = true;
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
        "remote",
        "remote.agentPresets",
        "remote.settings"
      ], (scope) => {
        const controller = createModeController(scope);
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
    exports.createModeController = createModeController;
    return module.exports;
  }
});
