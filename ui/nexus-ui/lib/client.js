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
			"--dsw-alias-border-l2-darkmode-thin": { dark: NEXUS_PALETTE.border, light: "#0000001A" },
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
			"--dsw-alias-interactive-bg-active": { dark: "#7C5CFF2E", light: "#7C5CFF14" },
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
			"--dsw-specific-input-major": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-login-input": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-menu": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-selector": { dark: NEXUS_PALETTE.elevated, light: NEXUS_PALETTE.lightElevated },
			"--dsw-specific-sidebar-fill": { dark: NEXUS_PALETTE.sidebar, light: NEXUS_PALETTE.lightSurface },
			"--dsw-specific-sidebar-nav-item-active": { dark: "#221D38", light: NEXUS_PALETTE.lightNavActive },
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
			"body[data-ds-dark-theme]{--dsh-scrollbar-width:10px}",
			//#region phase 1.5 — compact premium layout
			// Main content: widen the chat column for every conversation phase.
			"[data-phase]{--dsh-chat-content-width:900px}",
			// Hero: headline at product scale (28-32px), tighter vertical rhythm.
			"[data-phase=hero] [class*=headline]{font-size:30px;line-height:34px}",
			"[data-phase=hero] [class*=stack]{gap:8px}",
			"[data-phase=hero] [class*=composerHero]{padding-bottom:16px}",
			"[data-phase=hero] [data-input-mirror=true]{min-height:44px}",
			"[data-phase=hero] [class*=root]:has(> [class*=stack]){padding:0 16px}",
			// Hero chips (mode seat + workspace chip): Nexus surface treatment.
			"[data-phase=hero] button[aria-haspopup=menu]{background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2)}",
			"[data-phase=hero] button[aria-haspopup=menu]:hover{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l3)}",
			// Composer: elevated surface, clear border, polished focus, 8-10px radius.
			"[data-composer-card]{border-radius:10px;font-size:15px;line-height:22px;border-color:var(--dsw-alias-border-l2)}",
			"[data-composer-card]:focus-within{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px #7C5CFF26,var(--dsw-shadow-lv2)}",
			// The card is the only bordered surface: the inner editable area is
			// fully borderless/transparent and keeps no independent focus border.
			"[data-composer-card] textarea,[data-composer-card] textarea:focus,[data-composer-card] textarea:focus-visible{outline:none;border:none;box-shadow:none;background:transparent}",
			"[data-input-scroll=true]{padding-top:8px}",
			// Preview badge: de-emphasized (no product meaning on Nexus).
			"[data-phase=hero] [class*=previewBadge]{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:1px 6px 0}",
			// Sidebar brand: icon-only mark (34px hero / 30px expanded / 26px rail);
			// the NEXUS wordmark renders via the brand-name slot.
			".nexus-brand-mark{display:block;width:34px;height:34px}",
			"[data-slot=sidebar] .nexus-brand-mark{width:30px;height:30px}",
			"[data-sidebar-collapsed] [data-slot=sidebar] .nexus-brand-mark{width:26px;height:26px}",
			"[data-slot=sidebar] [class*=brandIdentity]{height:32px}",
			"[data-sidebar-collapsed] [data-slot=sidebar] [class*=brandName]{display:none}",
			// Sidebar density: tighter logo row and inline padding.
			"[data-slot=sidebar] [class*=logoRow]{height:52px;margin-bottom:4px}",
			"[data-sidebar-collapsed] [data-slot=sidebar] [class*=logoRow]{height:36px;margin-bottom:12px;padding:0}",
			"[data-slot=sidebar]>div{--dsh-sidebar-inline-padding:10px}",
			"[data-slot=sidebar] [class*=navItem]:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			// Selected rows in pickers/menus get a subtle violet treatment.
			"[role=menuitem][aria-selected=true],[role=option][aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}"
			//#endregion
		].join("");
		//#endregion
		//#region nexus brand components
		/**
		* The official Nexus icon mark. Sized purely with CSS so the slot host's
		* intrinsic size does not constrain it: 34px in the conversation hero,
		* 30px in the expanded sidebar brand row, 26px in the collapsed rail.
		* The NEXUS wordmark renders separately through the sidebar.brand.name
		* slot. The asset is copied into the web frontend dist by
		* scripts/Patch-NexusUi.ps1 (step 2d) and served from /assets/.
		* @param props - host-supplied mark presentation (size + positioning class).
		* @returns the Nexus icon mark.
		*/
		function NexusMark({ size, className }) {
			return (0, react_jsx_runtime.jsx)("img", {
				className: className ? "nexus-brand-mark " + className : "nexus-brand-mark",
				src: "/assets/nexus-mark.png",
				alt: "",
				"aria-hidden": "true"
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
