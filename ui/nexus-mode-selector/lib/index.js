// @nexus/mode-selector — host half.
// The package is intentionally inert on the host. Its browser half owns the
// Nexus new-session mode lifecycle and synchronizes preset + model through the
// public DSH client services, so no installed upstream bundle is monkey-patched.
const name = "nexus-mode-selector";

function apply() {}

export { apply, name };
