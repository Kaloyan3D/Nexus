window.__ModuleLoader__.load({
	id: "@nexus/ui-brand",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region nexus design intent
		/**
		* The single source of the Nexus palette. Every theme token below is
		* derived from these values; a future Nexus redesign edits this object and
		* the token map, not scattered files.
		*/
		const NEXUS_PALETTE = {
			background: "#09090B",
			sidebar: "#0D0D10",
			surface: "#111116",
			elevated: "#17171D",
			elevated2: "#1F1F26",
			border: "#27272F",
			textPrimary: "#F5F5F7",
			textSecondary: "#A1A1AA",
			textMuted: "#71717A",
			textDimmed: "#52525B",
			accent: "#7C5CFF",
			accentHover: "#9177FF",
			accentSoft: "#7C5CFF33",
			accentLine: "#7C5CFF80",
			accentDimmed: "#7C5CFF59",
			secondary: "#49C6E5",
			secondaryHover: "#6FD3EC",
			success: "#32D583",
			warning: "#F5A524",
			error: "#F04438",
			scrollbar: "#3F3F46",
			// light-scheme counterparts
			lightBackground: "#FFFFFF",
			lightSurface: "#F7F7F8",
			lightElevated: "#FFFFFF",
			lightPlatform: "#F2F2F4",
			lightBorder: "#E4E4E7",
			lightBorderStrong: "#D4D4D8",
			lightTextPrimary: "#18181B",
			lightTextSecondary: "#52525B",
			lightTextMuted: "#71717A",
			lightNavActive: "#E9E6F7",
			lightNavHover: "#EFEFF1",
			lightSuccess: "#16A34A",
			lightWarning: "#D97706",
			lightError: "#DC2626"
		};
		//#endregion
		//#region nexus semantic token map
		/**
		* Map the Nexus palette onto the DSH semantic token system
		* (@deepseek-ai/dsh-client-ui-theme design-platform.css). Each entry is a
		* { light, dark } pair consumed by the theme service's overrideTokens
		* layer, so the user's Appearance preference keeps working.
		*/
		const NEXUS_THEME_TOKENS = {
			"--dsw-alias-bg-base": { dark: NEXUS_PALETTE.background, light: NEXUS_PALETTE.lightBackground },
			"--dsw-alias-bg-layer-1": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightSurface },
			"--dsw-alias-bg-layer-2": { dark: NEXUS_PALETTE.surface, light: NEXUS_PALETTE.lightSurface },
			"--dsw-alias-bg-layer-3": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-alias-bg-mask-1": { dark: "#00000066", light: "#0000003D" },
			"--dsw-alias-bg-mask-2": { dark: "#00000040", light: "#0000001F" },
			"--dsw-alias-bg-mask-3": { dark: "#00000080", light: "#0000007A" },
			"--dsw-alias-bg-mask-drop": { dark: "#0D0D10B3", light: "#FFFFFFB3" },
			"--dsw-alias-bg-module-platform": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-bg-multi-select": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-bg-overlay": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightElevated },
			"--dsw-alias-bg-skeleton": { dark: "#FFFFFF0D", light: "#0000000A" },
			"--dsw-alias-border-inverted": { dark: "#FFFFFF12", light: "#00000014" },
			"--dsw-alias-border-inverted2": { dark: "#FFFFFF14", light: "#0000001A" },
			"--dsw-alias-border-l1": { dark: "#27272F66", light: "#0000000A" },
			"--dsw-alias-border-l2-darkmode-thin": { dark: "#27272F80", light: "#0000001A" },
			"--dsw-alias-border-l2": { dark: NEXUS_PALETTE.border, light: NEXUS_PALETTE.lightBorder },
			"--dsw-alias-border-l3": { dark: "#27272FE6", light: NEXUS_PALETTE.lightBorderStrong },
			"--dsw-alias-border-l4": { dark: NEXUS_PALETTE.border, light: "#00000029" },
			"--dsw-alias-brand-primary": { dark: NEXUS_PALETTE.accent, light: NEXUS_PALETTE.accent },
			"--dsw-alias-brand-primary-invert": { dark: NEXUS_PALETTE.textPrimary, light: NEXUS_PALETTE.lightBackground },
			"--dsw-alias-brand-primary-new-colorprimary-new-color": { dark: NEXUS_PALETTE.accent, light: NEXUS_PALETTE.accent },
			"--dsw-alias-brand-text": { dark: NEXUS_PALETTE.textPrimary, light: NEXUS_PALETTE.lightTextPrimary },
			"--dsw-alias-button-contrast-fill": { dark: NEXUS_PALETTE.textPrimary, light: "#FFFFFF" },
			"--dsw-alias-button-elevated-fill": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-alias-button-floating-fill": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightElevated },
			"--dsw-alias-button-floating-hover": { dark: NEXUS_PALETTE.border, light: NEXUS_PALETTE.lightBorder },
			"--dsw-alias-button-ghost-active-border": { dark: NEXUS_PALETTE.accentLine, light: NEXUS_PALETTE.accentLine },
			"--dsw-alias-button-ghost-active-fill": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-button-ghost-active-hover": { dark: NEXUS_PALETTE.border, light: NEXUS_PALETTE.lightBorder },
			"--dsw-alias-button-info-fill": { dark: NEXUS_PALETTE.secondary, light: NEXUS_PALETTE.secondary },
			"--dsw-alias-button-info-hover": { dark: NEXUS_PALETTE.secondaryHover, light: NEXUS_PALETTE.secondaryHover },
			"--dsw-alias-button-primary-dimmed": { dark: NEXUS_PALETTE.accentDimmed, light: NEXUS_PALETTE.accentDimmed },
			"--dsw-alias-button-primary-fill": { dark: NEXUS_PALETTE.accent, light: NEXUS_PALETTE.accent },
			"--dsw-alias-button-primary-hover": { dark: NEXUS_PALETTE.accentHover, light: NEXUS_PALETTE.accentHover },
			"--dsw-alias-button-tool-bar-fill": { dark: "#27272F80", light: "#0000001F" },
			"--dsw-alias-button-tool-bar-fill-invisible": { dark: "#17171D5C", light: "#FFFFFF" },
			"--dsw-alias-button-tool-bar-hover": { dark: "#27272F99", light: "#00000029" },
			"--dsw-alias-interactive-bg-active": { dark: "#FFFFFF1F", light: "#00000012" },
			"--dsw-alias-interactive-bg-hover": { dark: "#FFFFFF12", light: "#00000008" },
			"--dsw-alias-interactive-bg-hover-accent": { dark: NEXUS_PALETTE.accentSoft, light: NEXUS_PALETTE.accentSoft },
			"--dsw-alias-interactive-bg-hover-danger": { dark: "#F0443826", light: "#DC262614" },
			"--dsw-alias-interactive-bg-hover-solid": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-label-caption": { dark: NEXUS_PALETTE.textMuted, light: NEXUS_PALETTE.lightTextMuted },
			"--dsw-alias-label-dimmed": { dark: NEXUS_PALETTE.textDimmed, light: "#A1A1AA" },
			"--dsw-alias-label-primary": { dark: NEXUS_PALETTE.textPrimary, light: NEXUS_PALETTE.lightTextPrimary },
			"--dsw-alias-label-primary-bluish": { dark: NEXUS_PALETTE.textPrimary, light: NEXUS_PALETTE.lightTextPrimary },
			"--dsw-alias-label-primary-dimmed": { dark: "#E4E4E7", light: "#3F3F46" },
			"--dsw-alias-label-primary-foreground": { dark: NEXUS_PALETTE.background, light: NEXUS_PALETTE.lightBackground },
			"--dsw-alias-label-primary-inverted": { dark: NEXUS_PALETTE.background, light: NEXUS_PALETTE.lightBackground },
			"--dsw-alias-label-secondary": { dark: NEXUS_PALETTE.textSecondary, light: NEXUS_PALETTE.lightTextSecondary },
			"--dsw-alias-label-tertiary": { dark: NEXUS_PALETTE.textMuted, light: NEXUS_PALETTE.lightTextMuted },
			"--dsw-alias-markdown-citation": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-markdown-code-block": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightSurface },
			"--dsw-alias-markdown-code-block-banner": { dark: NEXUS_PALETTE.surface, light: NEXUS_PALETTE.lightSurface },
			"--dsw-alias-markdown-code-segment-selected": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightElevated },
			"--dsw-alias-markdown-code-segment-unselected": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightSurface },
			"--dsw-alias-markdown-inline-code": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-markdown-placeholder": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-markdown-tag": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-alias-scrollbar-bg-l1": { dark: NEXUS_PALETTE.border, light: NEXUS_PALETTE.lightBorderStrong },
			"--dsw-alias-scrollbar-bg-l2": { dark: NEXUS_PALETTE.border, light: NEXUS_PALETTE.lightBorderStrong },
			"--dsw-alias-scrollbar-hover-l1": { dark: NEXUS_PALETTE.scrollbar, light: NEXUS_PALETTE.lightTextMuted },
			"--dsw-alias-scrollbar-hover-l2": { dark: NEXUS_PALETTE.scrollbar, light: NEXUS_PALETTE.lightTextMuted },
			"--dsw-alias-state-business-primary": { dark: NEXUS_PALETTE.accent, light: NEXUS_PALETTE.accent },
			"--dsw-alias-state-business-tertiary": { dark: "#221D38", light: "#F1EDFB" },
			"--dsw-alias-state-error-primary": { dark: NEXUS_PALETTE.error, light: NEXUS_PALETTE.lightError },
			"--dsw-alias-state-error-secondary": { dark: NEXUS_PALETTE.error, light: NEXUS_PALETTE.lightError },
			"--dsw-alias-state-success-primary": { dark: NEXUS_PALETTE.success, light: NEXUS_PALETTE.lightSuccess },
			"--dsw-alias-state-success-secondary": { dark: NEXUS_PALETTE.success, light: NEXUS_PALETTE.lightSuccess },
			"--dsw-alias-state-success-tertiary": { dark: "#0F2A1B", light: "#E6F7EE" },
			"--dsw-alias-state-warn-label": { dark: NEXUS_PALETTE.warning, light: NEXUS_PALETTE.lightWarning },
			"--dsw-alias-state-warn-primary": { dark: NEXUS_PALETTE.warning, light: NEXUS_PALETTE.lightWarning },
			"--dsw-alias-state-warn-secondary": { dark: NEXUS_PALETTE.warning, light: NEXUS_PALETTE.lightWarning },
			"--dsw-alias-state-warn-tertiary": { dark: "#2E2410", light: "#FEF6E7" },
			"--dsw-alias-toast-bg": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.elevated2 },
			"--dsw-alias-tooltip-bg": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.elevated2 },
			"--dsw-specific-bubble": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-bubble-highlight": { dark: NEXUS_PALETTE.elevated2, light: NEXUS_PALETTE.lightPlatform },
			"--dsw-specific-input-major": { dark: NEXUS_PALETTE.surface, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-login-input": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-menu": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-selector": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-sidebar-fill": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightSurface },
			"--dsw-specific-sidebar-nav-item-active": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightNavActive },
			"--dsw-specific-sidebar-nav-item-active-accent": { dark: NEXUS_PALETTE.accent, light: NEXUS_PALETTE.accent },
			"--dsw-specific-sidebar-nav-item-hover": { dark: NEXUS_PALETTE.surface, light: NEXUS_PALETTE.lightNavHover },
			"--dsw-specific-tip": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-linear-gradient-think": { dark: "linear-gradient(180deg, #17171D 20.19%, #17171D00 100%)", light: "linear-gradient(180deg, #FFFFFF 20.19%, #FFFFFF00 100%)" },
			"--dsw-linear-think-select": { dark: "linear-gradient(180deg, #1F1F26 20.19%, #1F1F2600 100%)", light: "linear-gradient(180deg, #F2F2F4 20.19%, #F2F2F400 100%)" },
			"--dsw-shadow-lv1": { dark: "0 1px 2px #00000040", light: "0 2px 4px #0000000D" },
			"--dsw-shadow-lv1-blur": { dark: "0 4px 12px #00000033", light: "0 4px 12px #00000005" },
			"--dsw-shadow-lv2": { dark: "0 4px 12px #0000004D", light: "0 4px 12px #00000005, 0 2px 8px #0000000A" },
			"--dsw-shadow-lv3": { dark: "0 0 1px #00000080, 0 0 4px #00000033, 0 12px 32px #00000066", light: "0 0 1px #00000033, 0 0 4px #00000005, 0 12px 32px #00000014" },
			"--dsw-mask-blur": { dark: "blur(2px)", light: "blur(2px)" }
		};
		//#endregion
		//#region nexus structural styles
		/**
		* Structural refinements that are not expressible as DSH semantic tokens:
		* motion timing, focus rings, and surface radius. All selectors use the
		* stable data-attribute contract of the Web client, never hashed CSS-module
		* class names, so an upstream rebuild cannot silently break them.
		*/
		const NEXUS_CSS = [
			":root{--ds-transition-duration:.15s;--ds-transition-duration-fast:.12s;--ds-transition-duration-slow:.25s}",
			":where(button,[role=button],textarea,input,select,[role=menuitem],[tabindex]):focus-visible{outline:2px solid #7C5CFF80;outline-offset:1px}",
			"[data-composer-card]{border-radius:10px}",
			"[data-phase=hero] button[aria-haspopup=menu]{border-radius:8px}",
			"body[data-ds-dark-theme]::-webkit-scrollbar-thumb{border-radius:5px}",
			"body[data-ds-dark-theme]{--dsh-scrollbar-width:10px}"
		].join("");
		//#endregion
		//#region nexus brand components
		/**
		* The geometric Nexus mark: a hexagonal node ring with a hub core — a
		* network nexus, not a DeepSeek fish. Rendered inline so the sidebar and
		* conversation hero slots need no asset pipeline.
		* @param props - host-supplied mark presentation (size + positioning class).
		* @returns the Nexus mark svg.
		*/
		function NexusMark({ size, className }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				className,
				"aria-hidden": "true",
				children: [
					(0, react_jsx_runtime.jsx)("path", {
						d: "M12 2.8 19.97 7.6v8.8L12 21.2 4.03 16.4V7.6Z",
						stroke: NEXUS_PALETTE.accent,
						strokeWidth: "1.7",
						strokeLinejoin: "round",
						fill: "none"
					}),
					(0, react_jsx_runtime.jsx)("path", {
						d: "M12 12V2.8M12 12l7.97 4.4M12 12 4.03 16.4",
						stroke: NEXUS_PALETTE.accent,
						strokeWidth: "1.4",
						strokeLinecap: "round",
						opacity: "0.5"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "12",
						cy: "12",
						r: "2.4",
						fill: NEXUS_PALETTE.textPrimary
					})
				]
			});
		}
		/**
		* The Nexus wordmark rendered into the sidebar's brand-name slot.
		* @returns the NEXUS wordmark span.
		*/
		function NexusBrandName() {
			return (0, react_jsx_runtime.jsx)("span", {
				style: { letterSpacing: "0.12em", marginRight: "-0.12em", fontWeight: "600" },
				children: "NEXUS"
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the UI slot registry and the theme token service. */
		const inject = ["slots", "theme"];
		/**
		* Fill every shipped brand slot with the Nexus identity and stack the
		* Nexus visual system over the DSH semantic tokens.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.theme.overrideTokens("@nexus/ui-brand", NEXUS_THEME_TOKENS), "nexus-ui: theme tokens");
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "@nexus/ui-brand";
				tag.dataset.pluginCss = "@nexus/ui-brand/theme.css";
				tag.textContent = NEXUS_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "nexus-ui: structural stylesheet");
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark" }, NexusMark);
				yield ctx.slots.register({ name: "sidebar.brand.name" }, NexusBrandName);
				yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, NexusMark);
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
