'use strict';
const S=require('../../../scripts/bench/ccv2-lhcb/state.cjs');
const files={
'package.json': JSON.stringify({name:'ledger-lab',version:'1.0.0',private:true,scripts:{test:'node --test test/*.test.cjs'}} ,null,2)+'\n',
'README.md': '# Ledger Lab\nSmall local ledger. Node 24+ runs the TypeScript sources directly. Run npm test. CLI: node cli.cjs list DATABASE. Persistence schema 2 stores records in a JSON file.\n',
'.gitignore': '.ai-harness/\nnode_modules/\n*.tmp\n',
'src/domain.ts': `type RecordInput = {id: string, amount: number};
function validate(row: RecordInput) {
  if (!row || typeof row.id !== 'string' || row.id.length === 0 || !Number.isSafeInteger(row.amount)) {
    throw Object.assign(new Error('Invalid record'), {code:'E_INPUT'});
  }
  return {id:row.id, amount:row.amount};
}
module.exports={validate};
`,
'src/migration.ts': `function migrate(input: any) {
  if (input.version === 2) return JSON.parse(JSON.stringify(input));
  if (input.version !== 1) throw Object.assign(new Error('Unknown schema'),{code:'E_VERSION'});
  return {version:2, records:input.entries.map((x: any)=>({id:x.id, amount:x.cents, createdAt:x.createdAt}))};
}
module.exports={migrate};
`,
'src/store.ts': `const fs=require('node:fs');
const path=require('node:path');
const {migrate}=require('./migration.ts');
class Repository {
  file: string; io: any;
  constructor(file: string, io=fs) {this.file=file; this.io=io;}
  load() {return migrate(JSON.parse(this.io.readFileSync(this.file,'utf8')));}
  backup() {this.io.copyFileSync(this.file,this.file+'.bak');}
  commit(next: any) {
    const tmp=this.file+'.tmp';
    try {this.io.writeFileSync(tmp,JSON.stringify(next)+'\\n',{mode:0o600}); this.io.renameSync(tmp,this.file);}
    finally {if(this.io.existsSync(tmp))this.io.unlinkSync(tmp);}
  }
}
module.exports={Repository};
`,
'src/audit.ts': `function audit(entry: any) { process.stderr.write(JSON.stringify(entry)+'\\n'); }
module.exports={audit};
`,
'src/service.ts': `const {validate}=require('./domain.ts');
class Service {
  repo: any; clock: any; audit: any;
  constructor(repo: any, {clock=()=>new Date().toISOString(),audit=()=>{}}={}) {this.repo=repo;this.clock=clock;this.audit=audit;}
  list() {return this.repo.load().records;}
  add(row: any) {
    const value=validate(row), db=this.repo.load();
    if(db.records.some((x: any)=>x.id===value.id))throw Object.assign(new Error('Duplicate'),{code:'E_CONFLICT'});
    this.repo.backup();const at=this.clock();db.records.push({...value,createdAt:at});this.repo.commit(db);
    this.audit({action:'add',ids:[value.id],at});return value.id;
  }
  importBatch(rows: any[], options: any={}) {
    throw Object.assign(new Error('Batch import is not implemented'),{code:'E_NOT_IMPLEMENTED'});
  }
}
module.exports={Service};
`,
'cli.cjs': `#!/usr/bin/env node
'use strict';
const {Repository}=require('./src/store.ts');
const {Service}=require('./src/service.ts');
const {audit}=require('./src/audit.ts');
function main(argv) {
  const [command,file]=argv;
  const service=new Service(new Repository(file),{audit});
  if(command==='list')return service.list();
  throw Object.assign(new Error('Unknown command'),{code:'E_INPUT'});
}
module.exports={main};
if(require.main===module)try {console.log(JSON.stringify(main(process.argv.slice(2))));}
catch(e){console.log(JSON.stringify({code:e.code||'E_IO'}));process.exitCode=2;}
`,
'data/example.json': JSON.stringify({version:2,records:[{id:'0001',amount:1200,createdAt:'2026-01-01T00:00:00.000Z'}]},null,2)+'\n',
'data/legacy.json': JSON.stringify({version:1,entries:[{id:'001',cents:-25,createdAt:'2025-01-01T00:00:00.000Z'}]},null,2)+'\n',
'test/regression.test.cjs': `const {test}=require('node:test');const assert=require('node:assert/strict');
const {Service}=require('../src/service.ts');const {migrate}=require('../src/migration.ts');
test('add and list compatibility',()=>{let db={version:2,records:[]};const service=new Service({load:()=>structuredClone(db),backup:()=>{},commit:v=>db=v},{clock:()=> 'fixed'});assert.equal(service.add({id:'a',amount:0}),'a');assert.deepEqual(service.list(),[{id:'a',amount:0,createdAt:'fixed'}]);assert.throws(()=>service.add({id:'a',amount:1}),{code:'E_CONFLICT'});});
test('migration is pure',()=>{const old={version:1,entries:[{id:'001',cents:-25,createdAt:'old'}]};const before=JSON.stringify(old);assert.deepEqual(migrate(old),{version:2,records:[{id:'001',amount:-25,createdAt:'old'}]});assert.equal(JSON.stringify(old),before);});
`
};
function createFixture(workspace) {
  S.noLinks(workspace);
  if(S.fs.existsSync(workspace)&&S.fs.readdirSync(workspace).length)S.fail('fixture-target-not-empty');
  S.fs.mkdirSync(workspace,{recursive:true});
  for(const [p,t] of Object.entries(files)){const full=S.inside(workspace,p);S.fs.mkdirSync(S.path.dirname(full),{recursive:true});S.fs.writeFileSync(full,t);}
  S.git(workspace,['init','--initial-branch=fixture']);S.git(workspace,['add','.']);
  const tree=S.git(workspace,['write-tree']);
  // User identity is read, never supplied or changed by the benchmark.
  const name=S.git(workspace,['config','user.name']),email=S.git(workspace,['config','user.email']);if(!name||!email)S.fail('git-identity-required');
  const commit=require('node:child_process').execFileSync('git',['commit-tree',tree,'-m','Ledger Lab v1'],{cwd:workspace,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
  const identity=S.git(workspace,['show','-s','--format=%an <%ae> | %cn <%ce>',commit]);if(identity!==name+' <'+email+'> | '+name+' <'+email+'>')S.fail('git-identity-mismatch');
  S.git(workspace,['update-ref','refs/heads/fixture',commit]);
  return {fixtureRevision:S.manifest.fixtureRevision,commit,tree,fileHashes:Object.fromEntries(Object.entries(files).map(([p,t])=>[p,S.hash(t)]))};
}
module.exports={files,createFixture};
