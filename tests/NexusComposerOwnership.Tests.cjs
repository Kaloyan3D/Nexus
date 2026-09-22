'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ROOT = path.resolve(__dirname, '..')
const req = require('node:module').createRequire(path.join(ROOT, 'app/package.json'))
const React = req('react')
const jsx = req('react/jsx-runtime')
const render = req('react-dom/server').renderToStaticMarkup
const contract = require('../ui/nexus-ui/composer-contract.json')
function load(source, react, extras = {}) {
  let exported
  const sandbox = {console, URL, setTimeout, clearTimeout, fetch: () => new Promise(() => {}), window: {
    localStorage: {getItem: () => null}, setInterval: () => 1, clearInterval() {},
    __ModuleLoader__: {load(def) { exported = def.factory(name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : extras[name] || {}) }}
  }}
  vm.runInNewContext(source, sandbox)
  return exported
}
function bundle(pkg) { return fs.readFileSync(path.join(ROOT, 'app/node_modules/@deepseek-ai', pkg, 'lib/client.js'), 'utf8').replace(/\r\n/g, '\n') }
function patched(pkg) {
  const spec = contract.patches.find(p => p.package === pkg)
  const source = bundle(pkg)
  assert.ok(source.includes(spec.before) || source.includes(spec.after), 'installed source matches pinned contract')
  return source.includes(spec.after) ? source : source.replace(spec.before, spec.after)
}
function main() {
  const effects = []
  const react = {...React, useSyncExternalStore: (_sub, get) => get(), useEffect: fn => effects.push(fn)}
  const source = fs.readFileSync(path.join(ROOT, 'ui/nexus-controller/lib/client.js'), 'utf8')
  let editor = {state: null, ready: false, failed: false, dirty: false, refresh() {}}
  let snapshot = null
  const client = load(source.replace('function useEngineeringEditor(sessionId, enabled) {', 'function useEngineeringEditor(sessionId, enabled) { return require("fixture").editor();')
    .replace('function useControllerSnapshot(sessionId) {', 'function useControllerSnapshot(sessionId) { return {snapshot: require("fixture").snapshot()};'), react, {fixture: {editor: () => editor, snapshot: () => snapshot}})
  const registrations = new Map()
  const ctx = {effect() {}, provide(name, value) {this[name] = value}, inject(names, fn) {if (names.every(n => this[n])) fn(this)}, slots: {
    inject(_name, fn) {return fn()}, register(spec, component) {registrations.set(spec.name, {spec, component}); return () => {}}
  }}
  client.apply(ctx)
  const primitives = new Proxy({}, {get: (_, name) => name === 'Tooltip' ? ({children}) => children : () => null})
  const upstream = load(patched('dsh-client-ui-model-selection'), react, {'@deepseek-ai/cordis': {Service: class {}}, '@deepseek-ai/dsh-client-ui-primitives': primitives})
  const directory = {current:{provider:'deepseek',model:'flash',reasoningEffort:'max'}, groups:[{id:'deepseek',name:'DeepSeek',models:[{id:'flash',name:'DeepSeek V4 Flash',reasoning:{defaultEffort:'max',efforts:[{id:'max',name:'Max'}]}}]}],status:'ready',failures:[]}
  ctx.locale = {register() {}, bind: () => key => key}
  ctx.plugin = () => {}
  ctx.sessions = {subagentAddress: () => undefined}
  ctx.modelDirectories = {directoryFor(id) {assert.ok(id, 'no legacy directory is requested before a session exists'); return {store:{getSnapshot:()=>directory,subscribe:()=>()=>{}},load:async()=>{}, select:async()=>{}}}}
  upstream.apply(ctx)
  const conversation = patched('dsh-client-ui-conversation')
  const zoneExpr = conversation.match(/const zone = ([\s\S]*?);\n/)[1]
  const rightExpr = conversation.match(/rightItems: (zone === void 0[^\n]+),/)[1]
  assert.match(conversation, /renderSlot\("conversation.input.model", \{ locked: modelSeatLocked \}\)/)
  assert.match(conversation, /"conversation.input.model": \{\s*kind: "single",\s*scope: "session-maybe"/)
  const renderer = bundle('dsh-client-ui-renderer')
  assert.match(renderer, /spec.scope === "session" && sessionInfo.sessionId === void 0/)
  assert.match(renderer, /const entry = host.entriesOfSlot\(slotKey\)\[0\]/)
  let current = 'aih-engineering'
  client.attachNexusModeState({getSnapshot:()=>({current}),subscribe:()=>()=>{}})
  const renderComposer = (sessionId, inputState, blank = true) => {
    const session = sessionId ? {sessionId, agentPreset:'aih-engineering'} : undefined
    const zone = vm.runInNewContext(zoneExpr, {session,inputState})
    const right = vm.runInNewContext(rightExpr, {zone,renderSlot: name => name})
    const entry = registrations.get('conversation.input.model')
    assert.ok(entry, 'the real upstream registration must install the preference owner')
    const props = {sessionId, useSession:selector=>selector(session), useSessions:selector=>selector({current:sessionId,byId: sessionId ? {[sessionId]:{id:sessionId,blank}} : {}}), t:key=>key, ...entry.spec.inject(sessionId)}
    const html = render(React.createElement(entry.component, props))
    return {html,right}
  }
  for (const [id,input] of [['s',undefined],['s',{}],[undefined,undefined]]) {
    const result = renderComposer(id,input)
    assert.match(result.html,/nx-eng-trigger/, 'Engineering owns the real preference seat even without the right outlet')
    assert.doesNotMatch(result.html,/DeepSeek V4 Flash/, 'raw model absent')
    if (!input) assert.equal(result.right,null)
  }
  snapshot = {composer:{mode:'engineering'}}
  for (const mode of ['aih-engineering','aih-deepseek','aih-engineering']) {
    current = mode
    const {html} = renderComposer('s',undefined)
    if (mode === 'aih-deepseek') {assert.match(html,/DeepSeek V4 Flash/); assert.match(html,/Max/); assert.doesNotMatch(html,/nx-eng-trigger/)}
    else {assert.match(html,/nx-eng-trigger/);assert.doesNotMatch(html,/DeepSeek V4 Flash/)}
  }
  snapshot = null
  editor = {...editor,failed:true}
  const failed = renderComposer('s',undefined).html
  assert.match(failed,/Engineering configuration.*unavailable/)
  assert.doesNotMatch(failed,/DeepSeek V4 Flash/)
  assert.doesNotMatch(source,/nexusComposerMode|body\[data-nexus-composer-mode|\[data-slot='conversation.input.model'\]/)
  assert.doesNotMatch(source,/_7KE1Ra/)
  snapshot = {composer:{mode:'engineering',preferredEngineer:{modelDisplayName:'GLM',reasoning:'high'}},execution:{model:'DeepSeek',reasoning:'max'}}
  const pills = render(React.createElement(registrations.get('conversation.input.right').component,{session:{sessionId:'s'}}))
  assert.match(pills,/RUNNING/); assert.match(pills,/PREFERRED/); assert.doesNotMatch(pills,/nx-eng-trigger/)
  // Execute real initial editor effects, which SSR-only predecessor tests missed.
  effects.length = 0
  const actual = load(source, react)
  function Boot() { actual.useEngineeringEditor(null,true); return null }
  render(React.createElement(Boot))
  for (const effect of effects.splice(0)) assert.doesNotThrow(effect, 'cold-start effects tolerate null catalog')
  console.log('PASS: pinned composer ownership, loading effects, legacy delegation and independent pills (TASK-0039)')
}
module.exports = main
if (require.main === module) main()
