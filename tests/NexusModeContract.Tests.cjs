'use strict'
// NexusModeContract.Tests.cjs — the @nexus/mode-selector client contract on DSH 0.2.x.
// The selector now speaks to the supported Remote namespaces (`remote.agentPresets`,
// `remote.settings`, each an injectable service) instead of the 0.1.x
// `connection.api` bridge. A host-confirmed preset reaches the session summary
// through the host's session projection (`projectionValues.agentPreset`), which
// the fake host below pushes exactly as the real one does.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
async function main() {
  let plugin
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/nexus-mode-selector/lib/client.js'),'utf8'),{window:{__ModuleLoader__:{load(def){plugin=def.factory(()=>({}))}}}})
  let current = {current:'s',byId:{s:{id:'s',blank:true,projectionValues:{agentPreset:'aih-engineering'}}}}
  const subscribers = new Set(), calls = [], registered = [], settingsWrites = []
  let failLoad = false, rejectSelection = false
  const project = (id, preset) => {
    current = {...current, byId: {...current.byId, [id]: {...current.byId[id], projectionValues: {agentPreset: preset}}}}
    for (const fn of [...subscribers]) fn()
  }
  const agentPresets = {
    async list(...args){ assert.equal(args.length, 0); if (failLoad) throw new Error('offline'); return {ok:true,value:{presets:[{id:'aih-engineering',name:'Normal Engineering',isDefault:true},{id:'aih-deepseek',name:'DeepSeek Only'}]}} },
    async select(sessionId, preset){ assert.equal(typeof sessionId,'string'); assert.equal(typeof preset,'string'); calls.push({sessionId, agentPreset: preset}); if (rejectSelection) return {ok:false,error:{message:'refused',details:{}}}; project(sessionId, preset); return {ok:true,value:preset} },
  }
  const settings = {
    async update(ns, patch){ settingsWrites.push({ns, patch}); assert.equal(ns,'agent-preset-registry'); assert.ok(typeof patch.selectedDefault === 'string'); return {ok:true,value:{}} },
  }
  const scope = {
    slots:{inject(_name,fn){return fn()},register(spec,component){registered.push({spec,component});return ()=>{}}},
    remote:{$on(){return ()=>{}}, agentPresets, settings},
    'remote.agentPresets': agentPresets, 'remote.settings': settings,
    sessions:{list:{getSnapshot:()=>current,subscribe(fn){subscribers.add(fn);return ()=>subscribers.delete(fn)}}},
    modelDirectories:{directoryFor(){return {load:async()=>{},select:async()=>{},store:{getSnapshot:()=>({current:null})}}}},
    inject(names,fn){if(names.every(name=>Object.hasOwn(this,name)))fn(this)},
    get(name){return this[name]}, provide(name,value){this[name]=value},effect(){}
  }
  plugin.apply(scope)
  assert.ok(scope.nexusModeState,'mode bridge must mount using the Remote namespace services DSH 0.2.x provides')
  const seat = registered.find(e=>e.spec.name==='conversation.hero.agentPreset')
  assert.ok(seat)
  const controls=seat.spec.inject()
  await controls.load()
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-engineering')
  const switching=controls.select('aih-deepseek')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek','visible picker and bridge change before any RPC completes')
  await switching
  assert.equal(current.byId.s.projectionValues.agentPreset,'aih-deepseek','host-confirmed preset reaches the session summary through the projection')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek')
  assert.ok(settingsWrites.length >= 1 && settingsWrites[settingsWrites.length-1].patch.selectedDefault === 'aih-deepseek', 'the chosen mode is persisted as the registry selectedDefault')
  await controls.select('aih-engineering')
  assert.equal(current.byId.s.projectionValues.agentPreset,'aih-engineering')
  current={current:undefined,byId:{}}
  const before=calls.length
  await controls.select('aih-deepseek')
  assert.equal(calls.length,before,'no RPC selection before a session exists')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek')
  failLoad=true
  await controls.load()
  assert.match(scope.nexusModeState.getSnapshot().error,/offline/,'transport rejection is shown rather than an unhandled promise')
  console.log('PASS: mode selector Remote-namespace contract, synchronous bridge and session projection')
}
module.exports=main
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
