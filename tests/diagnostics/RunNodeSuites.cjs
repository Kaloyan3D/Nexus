// Runs every tests/*.Tests.cjs against an installed DSH tree (NEXUS_RUNTIME_ROOT) and records per-suite status.
// usage: node tests/diagnostics/RunNodeSuites.cjs <repo> <runtimeRoot> <outJson> [filterRegex]
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const [repo,rt,out,filter]=process.argv.slice(2)
const files=fs.readdirSync(path.join(repo,'tests')).filter(f=>/\.Tests\.cjs$/.test(f)&&(!filter||new RegExp(filter).test(f))).sort()
const res=[]
for(const f of files){
  const t0=Date.now()
  const r=spawnSync(process.execPath,[path.join(repo,'tests',f)],{cwd:repo,env:{...process.env,NEXUS_RUNTIME_ROOT:rt,AIH_INSTALL_ROOT:'',DSH_HOME:''},encoding:'utf8',timeout:240000,maxBuffer:64e6})
  const tail=((r.stdout||'')+(r.stderr||'')).trim().split('\n').slice(-4).join('\n')
  res.push({file:f,status:r.status,signal:r.signal,ms:Date.now()-t0,tail})
  fs.writeFileSync(out,JSON.stringify(res,null,1))
  console.log(r.status===0?'PASS':'FAIL',f,r.status,Date.now()-t0+'ms')
}
