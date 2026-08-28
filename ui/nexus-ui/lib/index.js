// @nexus/ui-brand — host half.
// The Nexus product identity is browser presentation: the client half
// (lib/client.js) fills the brand slots and stacks the Nexus theme tokens.
// This host row exists so the composition carries the plugin in every profile
// (web, tui, headless) and the client-modules registry can discover the
// package's dsh.client declaration. It is deliberately inert on the host:
// no services are injected, so profiles without a webServer still load it.
const name = "nexus-ui-brand";

/** Host plugin body — this package contributes browser presentation only. */
function apply() {}

export { apply, name };
