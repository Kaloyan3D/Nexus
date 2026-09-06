'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
async function main() {
  let plugin
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/nexus-mode-selector/lib/client.js'),'utf8'),{window:{__ModuleLoader__:{load(def){plugin=def.factory(()=>({}))}}}})
  let current = {current:'s',byId:{s:{id:'s',blank:true,agentPreset:'aih-engineering'}}}
  const subscribers = new Set(), calls = [], registered = []
  let failLoad = false, rejectSelection = false
  const scope = {
    slots:{inject(_name,fn){return fn()},register(spec,component){registered.push({spec,component});return ()=>{}}},
    connection:{api:{agentPresets:{
      async list(arg){assert.equal(JSON.stringify(arg),'{}'); if(failLoad)throw new Error('offline'); return {result:{ok:true,value:{presets:[{id:'aih-engineering',name:'Normal Engineering',isDefault:true},{id:'aih-deepseek',name:'DeepSeek Only'}]}}}},
      async select(arg){assert.equal(typeof arg,'object');calls.push(arg);return rejectSelection?{result:{ok:false,error:{message:'refused'}}}:{result:{ok:true,value:{agentPreset:arg.agentPreset}}}}
    },settings:{async update(arg){assert.equal(arg.ns,'agent-presets');assert.ok(arg.patch.default);return {result:{ok:true,value:{}}}}}}},
    remote:{$on(){return ()=>{}}},
    sessions:{list:{getSnapshot:()=>current,subscribe(fn){subscribers.add(fn);return ()=>subscribers.delete(fn)}},noteAgentPreset(id,preset){current={...current,byId:{...current.byId,[id]:{...current.byId[id],agentPreset:preset}}};for(const fn of subscribers)fn()}},
    modelDirectories:{directoryFor(){return {load:async()=>{},select:async()=>{},store:{getSnapshot:()=>({current:null})}}}},
    inject(names,fn){if(names.every(name=>Object.hasOwn(this,name)))fn(this)},
    get(name){return this[name]}, provide(name,value){this[name]=value},effect(){}
  }
  plugin.apply(scope)
  assert.ok(scope.nexusModeState,'mode bridge must mount using services actually provided by pinned DSH')
  const seat = registered.find(e=>e.spec.name==='conversation.hero.agentPreset')
  assert.ok(seat)
  const controls=seat.spec.inject()
  await controls.load()
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-engineering')
  const switching=controls.select('aih-deepseek')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek','visible picker and bridge change before any RPC completes')
  await switching
  assert.equal(current.byId.s.agentPreset,'aih-deepseek','host-confirmed preset updates the real session summary')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek')
  await controls.select('aih-engineering')
  assert.equal(current.byId.s.agentPreset,'aih-engineering')
  current={current:undefined,byId:{}}
  const before=calls.length
  await controls.select('aih-deepseek')
  assert.equal(calls.length,before,'no RPC selection before a session exists')
  assert.equal(scope.nexusModeState.getSnapshot().current,'aih-deepseek')
  failLoad=true
  await controls.load()
  assert.match(scope.nexusModeState.getSnapshot().error,/offline/,'transport rejection is shown rather than an unhandled promise')
  console.log('PASS: mode selector pinned connection API, synchronous bridge and session summary contract')
}
module.exports=main
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
