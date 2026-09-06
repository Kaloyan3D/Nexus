'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nexusProfiles = require('../config/Nexus-Profiles.cjs')

let passed = 0
function pass(name) {
  passed += 1
  console.log('PASS: ' + name)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function setOrDelete(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeFixture(repoRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-'))
  for (const name of ['routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'nexus-profiles.json', 'muse-profiles.json']) {
    copyFile(path.join(repoRoot, 'config', name), path.join(root, 'config', name))
  }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), 'engineering-profile: glm-codex\n', 'utf8')
  return root
}

function main() {
  const repoRoot = path.resolve(__dirname, '..')
  const savedDsh = process.env.DSH_AIH_PROFILE
  const savedActive = process.env.AIH_ACTIVE_PROFILE

  try {
    const catalog = nexusProfiles.loadNexusProfileCatalog(repoRoot)
    assert.deepEqual(nexusProfiles.validateCatalogDocument(catalog), [])
    pass('top-level Nexus profile catalog validates')

    const listed = nexusProfiles.listNexusProfiles(repoRoot)
    const ids = listed.map((profile) => profile.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.includes('deepseek-codex'))
    assert.ok(ids.includes('glm-codex'))
    assert.ok(ids.includes('muse-spark-1.3-contributor'))
    pass('catalog ids are unique and expose both engine families')

    const deepSeek = nexusProfiles.resolveNexusProfile(repoRoot, 'deepseek-codex')
    assert.ok(deepSeek)
    assert.equal(deepSeek.engine, 'dual')
    assert.equal(deepSeek.runnable, true)
    assert.equal(deepSeek.config.id, 'deepseek-codex')
    assert.ok(deepSeek.config.roles.primaryEngineer)
    pass('DeepSeek + Codex resolves through the existing Dual profile registry')

    const glm = nexusProfiles.resolveNexusProfile(repoRoot, 'GLM-CODEX')
    assert.ok(glm)
    assert.equal(glm.engine, 'dual')
    assert.equal(glm.source.kind, 'engineering-profile')
    assert.ok(glm.config.roles.reviewer)
    pass('GLM + Codex resolves case-insensitively as a Dual profile')

    const muse = nexusProfiles.resolveNexusProfile(repoRoot, 'muse-spark-1.3-contributor')
    assert.ok(muse)
    assert.equal(muse.engine, 'muse')
    assert.equal(muse.source.kind, 'muse-profile')
    assert.equal(muse.selectable, false)
    assert.equal(muse.runnable, false)
    assert.equal(muse.availability, 'contributor-gated')
    assert.equal(muse.config.reasoning.default, 'xhigh')
    assert.equal(muse.config.subagents.enabled, false)
    pass('Muse resolves to its own agent engine while staying contributor-gated (M3 activation gate held)')

    assert.equal(nexusProfiles.resolveNexusProfile(repoRoot, 'does-not-exist'), null)
    pass('unknown profile fails closed with no fallback')

    const duplicateErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [
        { id: 'same', engine: 'dual', source: { kind: 'engineering-profile', profileId: 'a' } },
        { id: 'SAME', engine: 'muse', source: { kind: 'muse-profile', profileId: 'b' } },
      ],
    })
    assert.ok(duplicateErrors.some((error) => error.includes('duplicate-id:same')))
    pass('duplicate profile ids are rejected case-insensitively')

    const mismatchErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [
        { id: 'wrong', engine: 'muse', source: { kind: 'engineering-profile', profileId: 'wrong' } },
      ],
    })
    assert.ok(mismatchErrors.some((error) => error.includes('source-kind-mismatch')))
    pass('engine/source mismatches are rejected')

    const fixture = makeFixture(repoRoot)
    writeJson(path.join(fixture, 'data', 'custom-engineering-profile.json'), {
      schemaVersion: 1,
      profileId: 'custom',
      displayName: 'Custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3-flash', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'glm-5.3', reasoning: 'max' },
      },
    })
    const custom = nexusProfiles.resolveNexusProfile(fixture, 'custom')
    assert.ok(custom)
    assert.equal(custom.engine, 'dual')
    assert.equal(custom.selectable, true)
    assert.equal(custom.config.id, 'custom')
    pass('operator Custom profile is dynamically classified as Dual')

    setOrDelete('DSH_AIH_PROFILE', undefined)
    setOrDelete('AIH_ACTIVE_PROFILE', undefined)
    let active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'glm-codex')
    pass('settings engineering-profile participates in active Nexus profile resolution')

    process.env.AIH_ACTIVE_PROFILE = 'deepseek-codex'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'deepseek-codex')
    pass('AIH_ACTIVE_PROFILE overrides settings using the existing precedence')

    process.env.DSH_AIH_PROFILE = 'muse-spark-1.3-contributor'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'muse-spark-1.3-contributor')
    assert.equal(active.engine, 'muse')
    assert.equal(active.runnable, false)
    pass('DSH_AIH_PROFILE can resolve Muse metadata without silently falling back to Dual')

    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-deepseek')
    assert.equal(active.id, 'deepseek-codex')
    assert.equal(active.engine, 'dual')
    pass('profileOverrideAllowed=false keeps the DeepSeek-only preset locked')

    process.env.DSH_AIH_PROFILE = 'unknown-profile'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active, null)
    pass('invalid preferred profile fails closed instead of selecting a different engine')

    // ── Phase M1 integration: the Engineering Profile editor adapter is
    //    Nexus-profile-aware while the Dual state stays byte-compatible.
    const engineering = require('../ui/nexus-controller/lib/engineering.cjs')

    // 1. GET adapter state exposes the top-level Nexus classification
    const adapterState = engineering.buildEngineeringProfileState({
      installRoot: fixture,
      dataRoot: fixture,
      settingsPath: path.join(fixture, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(adapterState.profiles.map((p) => p.id), ['deepseek-codex', 'glm-codex'], 'Dual profile state keeps its exact legacy shape (no Muse bleed)')
    pass('adapter Dual profile list is unchanged by the Nexus classification')
    const adapterNexus = adapterState.nexusProfiles.map((p) => p.id)
    assert.ok(adapterNexus.includes('deepseek-codex') && adapterNexus.includes('glm-codex') && adapterNexus.includes('muse-spark-1.3-contributor'))
    pass('adapter state exposes the top-level Nexus profile catalog')

    // 2. Dual entries keep delegating role bindings; Muse carries Muse metadata only
    const adapterGlm = adapterState.nexusProfiles.find((p) => p.id === 'glm-codex')
    assert.equal(adapterGlm.engine, 'dual')
    assert.equal(adapterGlm.selectable, true)
    assert.equal(adapterGlm.runnable, true)
    assert.equal(adapterGlm.availability, 'ready')
    assert.equal(adapterGlm.roles.primaryEngineer.model, 'glm-5.3-flash')
    assert.equal(adapterGlm.muse, null)
    pass('GLM + Codex resolves as dual with Engineering Profile role bindings')

    const adapterMuse = adapterState.nexusProfiles.find((p) => p.id === 'muse-spark-1.3-contributor')
    assert.equal(adapterMuse.engine, 'muse')
    assert.equal(adapterMuse.selectable, false)
    assert.equal(adapterMuse.runnable, false)
    assert.equal(adapterMuse.availability, 'contributor-gated')
    assert.equal(adapterMuse.source.kind, 'muse-profile')
    assert.equal(adapterMuse.roles, null, 'Muse is never coerced into Dual roles')
    assert.equal(adapterMuse.muse.reasoning.default, 'xhigh')
    assert.equal(adapterMuse.muse.reasoning.escalation, 'xhigh', 'escalation is the Contributor ceiling xhigh, not the Standard-only max')
    assert.equal(adapterMuse.muse.subagents.enabled, false)
    assert.equal(adapterMuse.muse.review.independent, false)
    assert.equal(adapterMuse.muse.contributorProtection.required, true)
    assert.equal(adapterMuse.muse.status, 'contributor-gated')
    pass('Muse metadata is exposed from the Muse registry (contributor-gated until outbound protection ships)')

    // 3. Custom save still classifies as Dual in the Nexus list
    writeJson(path.join(fixture, 'data', 'custom-engineering-profile.json'), {
      schemaVersion: 1,
      profileId: 'custom',
      displayName: 'Custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3-flash', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'glm-5.3', reasoning: 'max' },
      },
    })
    const customState = engineering.buildEngineeringProfileState({
      installRoot: fixture,
      dataRoot: fixture,
      settingsPath: path.join(fixture, 'data', 'settings.yaml'),
      customProfilePath: path.join(fixture, 'data', 'custom-engineering-profile.json'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const customEntry = customState.nexusProfiles.find((p) => p.id === 'custom')
    assert.ok(customEntry, 'custom entry classified once the operator saves one')
    assert.equal(customEntry.engine, 'dual')
    assert.equal(customEntry.selectable, true)
    assert.equal(customEntry.builtin, false)
    assert.equal(customEntry.roles.primaryEngineer.model, 'glm-5.3-flash')
    const museAfterCustom = customState.nexusProfiles.find((p) => p.id === 'muse-spark-1.3-contributor')
    assert.equal(museAfterCustom.engine, 'muse')
    assert.equal(museAfterCustom.selectable, false)
    pass('Custom stays dual and Muse is never rewritten into Custom by saves')

    // 4. Fail-closed: missing/invalid catalog degrades to an EMPTY list
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-bare-'))
    fs.mkdirSync(path.join(bareRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(bareRoot, 'data', 'settings.yaml'), 'engineering-profile: glm-codex\n', 'utf8')
    const bareState = engineering.buildEngineeringProfileState({
      installRoot: bareRoot,
      dataRoot: bareRoot,
      settingsPath: path.join(bareRoot, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(bareState.nexusProfiles, [], 'missing catalog: no profiles exposed, state degrades safely')
    pass('missing Nexus catalog degrades to an empty editor list')

    const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-bad-'))
    for (const name of ['engineering-profiles.json', 'model-registry.json', 'muse-profiles.json']) copyFile(path.join(repoRoot, 'config', name), path.join(corruptRoot, 'config', name))
    writeJson(path.join(corruptRoot, 'config', 'nexus-profiles.json'), {
      schemaVersion: 1,
      profiles: [{ id: 'bad', engine: 'muse', source: { kind: 'engineering-profile', profileId: 'bad' } }],
    })
    const corruptState = engineering.buildEngineeringProfileState({
      installRoot: corruptRoot,
      dataRoot: corruptRoot,
      settingsPath: path.join(corruptRoot, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(corruptState.nexusProfiles, [], 'invalid catalog: fail closed instead of guessing')
    pass('invalid Nexus catalog fails closed with an empty editor list')

    // 5. Muse can never be expressed as a Custom save (role-based contract)
    assert.equal(
      engineering.validateSaveCustomPayload({ primaryEngineer: null, deepEngineer: null, reviewer: null, solver: null, fallback: null }, null),
      'missing role binding: primaryEngineer',
      'a Muse-shaped metadata payload cannot satisfy the Dual custom contract',
    )
    pass('save-custom validation remains Dual-role authoritative')

    // 6. Client renders Muse as read-only foundation metadata — no Dual role
    //    editor, no empty role dropdowns, Select blocked — and keeps the
    //    exact Dual rendering for Dual profiles (same vm+react technique as
    //    the NexusControllerPanel suite).
    const requireFromApp = require('node:module').createRequire(path.join(repoRoot, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    const vm = require('node:vm')
    const clientSource = fs.readFileSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'client.js'), 'utf8')
    let moduleExports = null
    const sandbox = {
      console,
      URL,
      setTimeout,
      clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(clientSource, sandbox)
    assert.equal(typeof moduleExports.EngineeringEditor, 'function', 'EngineeringEditor exported')
    assert.equal(typeof moduleExports.EngineeringEditorFields, 'function', 'EngineeringEditorFields exported')

    const glmRoles = {
      primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' },
      deepEngineer: { model: 'glm-5.3-flash', reasoning: 'max' },
      reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
      solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
      fallback: { model: 'glm-5.3', reasoning: 'max' },
    }
    const registryEntries = [
      { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', vendor: 'Z.ai', supportedReasoningLevels: ['off', 'high'] },
      { id: 'gpt-5.6-sol', displayName: 'Codex GPT-5.6 Sol', vendor: 'OpenAI', supportedReasoningLevels: ['low', 'medium', 'high'] },
      { id: 'glm-5.3', displayName: 'GLM-5.3', vendor: 'Z.ai', supportedReasoningLevels: ['off', 'high', 'max'] },
    ]
    const nexusEntries = [
      { id: 'glm-codex', displayName: 'GLM + Codex', engine: 'dual', selectable: true, runnable: true, availability: 'ready', source: { kind: 'engineering-profile', profileId: 'glm-codex' }, builtin: true, roles: glmRoles, muse: null },
      { id: 'muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3 Contributor', engine: 'muse', selectable: false, runnable: false, availability: 'contributor-gated', source: { kind: 'muse-profile', profileId: 'muse-spark-1.3-contributor' }, builtin: true, roles: null, muse: { id: 'muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3 Contributor', status: 'contributor-gated', reasoning: { default: 'xhigh', escalation: 'xhigh' }, subagents: { enabled: false }, review: { independent: false }, contributorProtection: { required: true } } },
    ]
    function editorFixture(selectedProfile, selectedEngine, selectedSelectable, roles) {
      return {
        state: {
          schemaVersion: 1,
          profiles: [{ id: 'glm-codex', displayName: 'GLM + Codex', builtin: true, roles: glmRoles }],
          nexusProfiles: nexusEntries,
          registry: registryEntries,
          roleModels: { primaryEngineer: ['glm-5.3-flash'], deepEngineer: ['glm-5.3-flash'], reviewer: ['gpt-5.6-sol'], solver: ['gpt-5.6-sol'], fallback: ['glm-5.3'], visualReviewer: [] },
          preferredProfile: { id: 'glm-codex', displayName: 'GLM + Codex' },
        },
        failed: false,
        profileId: selectedProfile.id,
        roles: roles || null,
        dirty: false, notice: null, noticeTone: 'ok', saving: false, fetchedAt: 0,
        selectedProfile, selectedEngine, selectedSelectable, ready: true,
        refresh() {}, selectProfile() {}, changeRole() {}, save() {}, bindingsFor() { return roles || null },
        modelEntry(id) { return registryEntries.find((m) => m.id === id) || null },
      }
    }

    // 6a. Muse: metadata rows, NO role rows, NO role selects, Select disabled
    const museEditor = editorFixture(nexusEntries[1], 'muse', false, null)
    const museHtml = renderToStaticMarkup(jsxRuntime.jsx(moduleExports.EngineeringEditorFields, { editor: museEditor, variant: 'room' }))
    for (const label of ['Primary Engineer', 'Deep Engineer', 'Reviewer', 'Solver', 'Fallback']) {
      assert.ok(!museHtml.includes(label), 'Muse renders no Dual role row: ' + label)
    }
    assert.equal((museHtml.match(/<select/g) || []).length, 1, 'Muse renders ONLY the profile dropdown (no empty role dropdowns)')
    for (const text of ['>Engine<', '>Status<', 'Contributor-gated', '>Reasoning<', 'xhigh', '>Max Reasoning<', '>xhigh<', '>Subagents<', 'Disabled', '>Independent Review<', 'Not available', '>Execution<']) {
      assert.ok(museHtml.includes(text), 'Muse metadata rendered: ' + text)
    }
    assert.ok(museHtml.includes('disabled'), 'Muse Select button is disabled')
    assert.ok(museHtml.includes('profile-not-selectable'), 'Muse Select button names the deterministic rejection code')
    assert.ok(museHtml.includes('not selectable yet'), 'Muse renders the not-selectable hint')
    assert.ok(museHtml.includes('Muse Spark 1.3 Contributor \u2014 contributor-gated'), 'Muse dropdown option visibly carries its contributor-gated state')
    pass('client renders Muse as read-only foundation metadata without a Dual role editor')

    // 6b. Dual: the exact legacy editor surface (11 selects, role rows, enabled save)
    const dualEditor = editorFixture(nexusEntries[0], 'dual', true, glmRoles)
    const dualHtml = renderToStaticMarkup(jsxRuntime.jsx(moduleExports.EngineeringEditorFields, { editor: dualEditor, variant: 'room' }))
    assert.equal((dualHtml.match(/<select/g) || []).length, 11, 'Dual profile keeps profile dropdown + 5 role rows (model + reasoning)')
    for (const label of ['Primary Engineer', 'Deep Engineer', 'Reviewer', 'Solver', 'Fallback']) {
      assert.ok(dualHtml.includes(label), 'Dual role row still rendered: ' + label)
    }
    assert.ok(dualHtml.includes('Select Profile'), 'Dual built-in keeps the Select Profile action')
    assert.ok(!dualHtml.includes('Not available yet'), 'Dual editor shows no Muse execution gate')
    assert.ok(!dualHtml.includes('profile-not-selectable'), 'Dual editor never renders the Muse rejection title')
    pass('client Dual role editor remains unchanged in behavior')

    // 6c. EngineeringEditor readiness: Muse state (roles=null) renders the
    //     metadata surface instead of hanging in the loading gate. The hook
    //     is injected through the same deterministic patch the panel suite
    //     uses; one helper serves every EngineeringEditor render below.
    const hookHeader = 'function useEngineeringEditor(sessionId, enabled) {'
    const hookPatch = hookHeader + '\n\tif (typeof window !== "undefined" && window.__NX_TEST_EDITOR__ !== undefined) return window.__NX_TEST_EDITOR__;'
    assert.ok(clientSource.includes(hookHeader), 'shared editor hook header found in client.js')
    function renderEditorWithInjection(editorValue, component, props) {
      const patchedSource = clientSource.replace(hookHeader, hookPatch)
      let injectedModule = null
      const injectedSandbox = {
        console,
        URL,
        setTimeout,
        clearTimeout,
        window: {
          __ModuleLoader__: {
            load(def) {
              injectedModule = def.factory((name) => {
                if (name === 'react') return react
                if (name === 'react/jsx-runtime') return jsxRuntime
                throw new Error('unexpected require: ' + name)
              })
            },
          },
          __NX_TEST_EDITOR__: editorValue,
          localStorage: { getItem() { return null }, setItem() {} },
          setInterval() { return 1 },
          clearInterval() {},
        },
        document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
      }
      vm.createContext(injectedSandbox)
      vm.runInContext(patchedSource, injectedSandbox)
      return renderToStaticMarkup(jsxRuntime.jsx(injectedModule[component], props))
    }
    const museTabHtml = renderEditorWithInjection(museEditor, 'EngineeringEditor', { sessionId: 'session-0001' })
    assert.ok(museTabHtml.includes('>Engine<'), 'Engineering tab renders the Muse metadata surface for a Muse selection')
    assert.ok(!museTabHtml.includes('Primary Engineer'), 'Engineering tab renders no Dual role editor for Muse')
    assert.ok(!museTabHtml.includes('Loading engineering configuration'), 'Muse selection does not hang in the loading gate')
    pass('UI adapter does not require Dual roles for Muse (readiness is engine-aware)')

    // ── Phase M1.1 cleanup: selectable-only gating, fail-closed catalog,
    //    authoritative initialization, and JS/PS resolver parity. ──

    // 7. client save() gating is selectable-only — no engine-based rejection
    assert.ok(!clientSource.includes('entry.engine !== "dual"'), 'client save() contains no engine-based rejection')
    assert.ok(clientSource.includes('if (entry && entry.selectable === false) return;'), 'client save() rejects on selectable only')
    pass('client save() does not reject on engine — selectable only')

    // 8. catalog fallback: contract-present empty NEVER falls back; legacy does
    const legacyCatalogState = { profiles: [{ id: 'glm-codex', displayName: 'GLM + Codex' }] }
    const emptyContractState = { profiles: [{ id: 'glm-codex', displayName: 'GLM + Codex' }], nexusProfiles: [] }
    assert.equal(moduleExports.hasNexusCatalogContract(legacyCatalogState), false, 'state without the property has no Nexus contract')
    assert.equal(moduleExports.hasNexusCatalogContract(emptyContractState), true, 'state with the property has the Nexus contract')
    assert.deepEqual(moduleExports.userFacingProfiles(legacyCatalogState), legacyCatalogState.profiles, 'CASE A: legacy host falls back to the Dual list')
    assert.deepEqual(moduleExports.userFacingProfiles(emptyContractState), [], 'CASE B: contract-present empty catalog is authoritative — NO fallback')
    assert.equal(moduleExports.isCatalogUnavailable(emptyContractState), true, 'CASE B: contract + empty catalog = configuration unavailable')
    assert.equal(moduleExports.isCatalogUnavailable(legacyCatalogState), false, 'CASE A: legacy state is never marked catalog-unavailable')
    pass('legacy vs current-host catalog fallback distinguished')

    // 9. initialization uses the authoritative user-facing catalog
    const museSelectableEntry = Object.assign({}, nexusEntries[1], { selectable: true })
    const selectableMuseCatalog = [museSelectableEntry, nexusEntries[0]]
    assert.equal(moduleExports.initialProfileChoice({ profiles: [{ id: 'glm-codex' }], nexusProfiles: selectableMuseCatalog }), 'muse-spark-1.3-contributor', 'initial fallback comes from the Nexus catalog, not the legacy Dual list')
    assert.equal(moduleExports.initialProfileChoice({ profiles: [{ id: 'glm-codex' }], nexusProfiles: selectableMuseCatalog, preferredProfile: { id: 'muse-spark-1.3-contributor' } }), 'muse-spark-1.3-contributor', 'a preferred future Muse profile initializes from the Nexus catalog')
    assert.equal(moduleExports.initialProfileChoice({ profiles: [{ id: 'glm-codex' }], preferredProfile: { id: 'glm-codex' } }), 'glm-codex', 'legacy host keeps the legacy initialization behavior')
    assert.equal(moduleExports.initialProfileChoice({ profiles: [{ id: 'glm-codex' }], nexusProfiles: [] }), null, 'empty catalog initializes nothing (fail closed)')
    pass('initialization uses the authoritative user-facing catalog')

    // 10. selectable-Muse hypothetical at the adapter level (fixture override
    //     ONLY — production config is never modified)
    const selectableMuseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-selmuse-'))
    for (const name of ['engineering-profiles.json', 'model-registry.json', 'muse-profiles.json']) copyFile(path.join(repoRoot, 'config', name), path.join(selectableMuseRoot, 'config', name))
    const selectableCatalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'nexus-profiles.json'), 'utf8'))
    const museCatalogEntry = selectableCatalog.profiles.find((p) => p.id === 'muse-spark-1.3-contributor')
    museCatalogEntry.selectable = true
    museCatalogEntry.runnable = false
    fs.writeFileSync(path.join(selectableMuseRoot, 'config', 'nexus-profiles.json'), JSON.stringify(selectableCatalog, null, 2), 'utf8')
    fs.mkdirSync(path.join(selectableMuseRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(selectableMuseRoot, 'data', 'settings.yaml'), 'engineering-profile: glm-codex\n', 'utf8')
    const selectableMuseState = engineering.buildEngineeringProfileState({
      installRoot: selectableMuseRoot,
      dataRoot: selectableMuseRoot,
      settingsPath: path.join(selectableMuseRoot, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const selectableMuseAdapter = selectableMuseState.nexusProfiles.find((p) => p.id === 'muse-spark-1.3-contributor')
    assert.ok(selectableMuseAdapter, 'hypothetical selectable Muse resolves')
    assert.equal(selectableMuseAdapter.engine, 'muse')
    assert.equal(selectableMuseAdapter.selectable, true, 'engine=muse does NOT force selectable=false')
    assert.equal(selectableMuseAdapter.runnable, false, 'runnable stays independent of selectable')
    pass('hypothetical selectable Muse passes the adapter layer (fixture override only)')

    // 11. production Muse flags unchanged
    const productionMuse = adapterState.nexusProfiles.find((p) => p.id === 'muse-spark-1.3-contributor')
    assert.equal(productionMuse.selectable, false, 'production Muse stays selectable=false')
    assert.equal(productionMuse.runnable, false, 'production Muse stays runnable=false')
    assert.equal(productionMuse.availability, 'contributor-gated', 'production Muse stays contributor-gated')
    pass('production Muse availability flags are untouched')

    // 12. resolver parity: missing muse-profiles.json → the Muse entry is
    //     omitted entirely (never partially resolved with muse: null)
    const noMuseRegistryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-nomuse-'))
    for (const name of ['engineering-profiles.json', 'model-registry.json', 'nexus-profiles.json']) copyFile(path.join(repoRoot, 'config', name), path.join(noMuseRegistryRoot, 'config', name))
    fs.mkdirSync(path.join(noMuseRegistryRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(noMuseRegistryRoot, 'data', 'settings.yaml'), 'engineering-profile: glm-codex\n', 'utf8')
    const noMuseState = engineering.buildEngineeringProfileState({
      installRoot: noMuseRegistryRoot,
      dataRoot: noMuseRegistryRoot,
      settingsPath: path.join(noMuseRegistryRoot, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(noMuseState.nexusProfiles.some((p) => p.id === 'muse-spark-1.3-contributor'), false, 'unresolved Muse source is omitted')
    assert.equal(noMuseState.nexusProfiles.some((p) => p.engine === 'muse' && p.muse === null), false, 'no partially-resolved Muse entry is exposed')
    assert.ok(noMuseState.nexusProfiles.some((p) => p.id === 'glm-codex'), 'Dual entries survive a missing Muse registry')
    pass('missing Muse registry skips only the Muse entry in the JS adapter')

    // 13. fail-closed render: a contract-present EMPTY catalog shows the
    //     unavailable state and never falls back to the legacy Dual list
    const unavailableEditor = {
      state: { schemaVersion: 1, profiles: [{ id: 'glm-codex', displayName: 'GLM + Codex', builtin: true, roles: glmRoles }], nexusProfiles: [] },
      failed: false, profileId: null, roles: null, ready: false,
      selectedProfile: null, selectedEngine: 'dual', selectedSelectable: false,
      dirty: false, notice: null, noticeTone: 'ok', saving: false, fetchedAt: 0,
      refresh() {}, selectProfile() {}, changeRole() {}, save() {}, bindingsFor() { return null }, modelEntry() { return null },
    }
    const unavailableHtml = renderEditorWithInjection(unavailableEditor, 'EngineeringEditor', { sessionId: 'session-0001' })
    assert.ok(unavailableHtml.includes('Engineering configuration is unavailable right now.'), 'empty Nexus catalog renders the unavailable state')
    assert.ok(!unavailableHtml.includes('GLM + Codex'), 'empty Nexus catalog never falls back to the legacy Dual list')
    assert.ok(!unavailableHtml.includes('Primary Engineer'), 'empty Nexus catalog renders no Dual role editor')
    pass('current-host empty Nexus catalog fails closed in the UI')

    // 14. selectable Muse renders the metadata surface with an ENABLED Select
    //     action — the UI layer no longer rejects engine=muse either
    const selectableMuseEditor = editorFixture(museSelectableEntry, 'muse', true, null)
    const selectableMuseHtml = renderToStaticMarkup(jsxRuntime.jsx(moduleExports.EngineeringEditorFields, { editor: selectableMuseEditor, variant: 'room' }))
    assert.ok(!selectableMuseHtml.includes('disabled'), 'selectable Muse Select button is enabled')
    assert.ok(!selectableMuseHtml.includes('Primary Engineer'), 'selectable Muse still renders no Dual role rows')
    assert.ok(selectableMuseHtml.includes('>Engine<'), 'selectable Muse keeps the engine metadata surface')
    pass('hypothetical selectable Muse is not rejected by the UI layer')

    // ── Phase M3 (TASK-0040): the catalog's internal engine→agent-preset
    //    binding, mirrored across the JS validator, the adapter state, and
    //    the shared publisher contract. ──

    // 15. validateCatalogDocument enforces the agentPreset id grammar
    assert.deepEqual(nexusProfiles.validateCatalogDocument(catalog), [], 'production catalog (with engines.muse.agentPreset) validates')
    const badPresetErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [{ id: 'p', engine: 'dual', source: { kind: 'engineering-profile', profileId: 'a' } }],
      engines: { muse: { agentPreset: 'Muse Plane!' } },
    })
    assert.ok(badPresetErrors.some((error) => error.includes('agentPreset-invalid')), 'a malformed agentPreset fails closed')
    const emptyPresetErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [{ id: 'p', engine: 'dual', source: { kind: 'engineering-profile', profileId: 'a' } }],
      engines: { muse: { agentPreset: '' } },
    })
    assert.ok(emptyPresetErrors.some((error) => error.includes('agentPreset-empty')), 'an empty agentPreset fails closed')
    const noBindingErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [{ id: 'p', engine: 'dual', source: { kind: 'engineering-profile', profileId: 'a' } }],
      engines: { dual: {} },
    })
    assert.deepEqual(noBindingErrors, [], 'an engine WITHOUT an agentPreset binding is valid (optional internal infrastructure)')
    pass('catalog engines.agentPreset bindings validate fail-closed (JS mirror)')

    // 16. engineAgentPresetOf: the engine's internal agent plane, or null
    assert.equal(nexusProfiles.engineAgentPresetOf(catalog, 'muse'), 'aih-muse')
    assert.equal(nexusProfiles.engineAgentPresetOf(catalog, 'dual'), null)
    assert.equal(nexusProfiles.engineAgentPresetOf(catalog, 'unknown-engine'), null)
    assert.equal(nexusProfiles.engineAgentPresetOf(null, 'muse'), null)
    assert.equal(nexusProfiles.engineAgentPresetOf({ engines: { muse: { agentPreset: 'Bad Id!' } } }, 'muse'), null)
    pass('engineAgentPresetOf resolves the muse agent plane and refuses malformed/absent bindings')

    // 17. the adapter state publishes the engine→agent-preset map
    assert.deepEqual(adapterState.engineAgentPresets, { muse: 'aih-muse' })
    pass('adapter state exposes engineAgentPresets from the catalog')
    const bareEngineState = engineering.buildEngineeringProfileState({
      installRoot: bareRoot,
      dataRoot: bareRoot,
      settingsPath: path.join(bareRoot, 'data', 'settings.yaml'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(bareEngineState.engineAgentPresets, {}, 'a missing catalog publishes NO engine mapping')
    pass('a missing catalog publishes an empty engine mapping (no mapping, no guessing)')

    console.log('Nexus profile foundation tests passed: ' + passed)
  } finally {
    setOrDelete('DSH_AIH_PROFILE', savedDsh)
    setOrDelete('AIH_ACTIVE_PROFILE', savedActive)
  }
}

main()
