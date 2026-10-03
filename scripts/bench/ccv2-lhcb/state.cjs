'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const REPO = path.resolve(__dirname, '../../..');
const BENCH = path.join(REPO, 'benchmarks/ccv2-lhcb-01');
const manifest = require(path.join(BENCH, 'manifest.json'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
const json = v => JSON.stringify(canonical(v), null, 2) + '\n';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function fail(code) { throw new Error('lhcb-' + code); }
function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('symlink');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function rootOf(raw = process.env.CCV2_LHCB_ROOT || path.join(os.homedir(), 'nexus-bench/ccv2-lhcb-01')) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || /[\x00-\x1f]/.test(raw) || raw.split(path.sep).includes('..')) fail('unsafe-root');
  const root = path.resolve(raw); noLinks(root);
  const forbidden = [path.parse(root).root, os.homedir(), REPO, path.join(os.homedir(), '.local/share/nexus')];
  if (forbidden.some(p => root === p || p.startsWith(root + path.sep)) || root.startsWith(REPO + path.sep) || root.startsWith(path.join(os.homedir(), '.local/share/nexus') + path.sep)) fail('unsafe-root');
  if (/^\/(?:etc|usr|var|bin|sbin|lib|proc|sys|dev|run)(?:\/|$)/.test(root) || root.startsWith(os.homedir() + '/.')) fail('unsafe-root');
  let ancestor=root;while(ancestor!==path.dirname(ancestor)){if(fs.existsSync(path.join(ancestor,'.git')))fail('repository-root');ancestor=path.dirname(ancestor);}
  if (root.split(path.sep).filter(Boolean).length < 3) fail('ambiguous-root');
  return root;
}
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '') || relative.includes('\0')) fail('unsafe-relative-path');
  const out = path.resolve(root, relative); if (!out.startsWith(root + path.sep)) fail('escape'); noLinks(out); return out;
}
function write(p, v) { noLinks(p); fs.mkdirSync(path.dirname(p), {recursive:true}); const tmp=p+'.tmp-'+crypto.randomUUID(); safeBytes(Buffer.from(json(v))); fs.writeFileSync(tmp, json(v), {mode:0o600}); fs.renameSync(tmp,p); }
function contractHash(){return hash(json(manifest)+fs.readFileSync(path.join(__dirname,'score.cjs'),'utf8')+['CONTRACT.md','obligations.json','fixture/create-fixture.cjs','grader/cases.cjs','grader/grade.cjs'].map(p=>fs.readFileSync(path.join(BENCH,p),'utf8')).join('')+manifest.stages.map(stage=>{const file=fs.readdirSync(path.join(BENCH,'prompts')).find(f=>f.startsWith(stage+'-'));return fs.readFileSync(path.join(BENCH,'prompts',file),'utf8');}).join(''));}
function owned(root) {
  root = rootOf(root); const marker = read(inside(root, 'state/identity.json'));
  if (marker.benchmarkId !== manifest.benchmarkId || marker.root !== root || marker.baseSha !== manifest.baseSha || marker.contractHash!==contractHash()) fail('unowned-root');
  return root;
}
function ready(root) { owned(root); if (fs.existsSync(inside(root,'state/restore-lock.json'))) fail('restore-incomplete'); }
function secretName(p) { return /(^|\/)(\.env(?:\..*)?|.*credentials.*|.*secrets.*|id_rsa|id_ed25519|auth\.json|.*\.pem|.*\.key)$/i.test(p); }
function safeBytes(bytes) {
  const t = bytes.toString('utf8');
  if (/-----BEGIN (?:\w+ )*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})|(?:authorization["']?\s*[:=]\s*["']?Bearer\s+\S+)|(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'](?!\$\{|process\.env|<|\*|REDACTED)[^"'\s]{8,}/i.test(t)) fail('secret-content');
}
function inventory(dir, prefix = '') {
  noLinks(dir); const out = {};
  if (!fs.existsSync(dir)) fail('missing-tree');
  for (const entry of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    const rel = prefix + entry.name, full = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('unsupported-file');
    if (secretName(rel)) continue;
    if (entry.isDirectory()) Object.assign(out, inventory(full, rel+'/'));
    else { const bytes=fs.readFileSync(full); safeBytes(bytes); if(full.endsWith('.zstd')){try{safeBytes(require('node:zlib').zstdDecompressSync(bytes));}catch(e){if(e.message==='lhcb-secret-content')throw e;fail('corrupt-compressed-state');}} out[rel]={hash:hash(bytes),mode:fs.statSync(full).mode & 0o777}; }
  }
  return out;
}
function copyInventory(src,dst,files) { for (const [rel,info] of Object.entries(files)) { const from=inside(src,rel), to=inside(dst,rel); const bytes=fs.readFileSync(from); safeBytes(bytes); if(hash(bytes)!==info.hash) fail('source-changed'); fs.mkdirSync(path.dirname(to),{recursive:true}); fs.writeFileSync(to,bytes,{mode:info.mode}); } }
const treeHash = files => hash(json(files));
function git(cwd,args) { return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'},maxBuffer:64*1024*1024}).trim(); }
function validateManifest(m) {
  if (m.benchmarkId !== 'CCV2-LHCB-01' || m.benchmarkVersion !== 1 || m.baseSha !== '081c54070ee0ae62a8ae303bbcde9f930174cbed' || m.fixtureRevision !== 'ledger-v1' || json(m.arms) !== json({native:{mode:'off',activation:'pressure'},production:{mode:'active',activation:'pressure'},forced:{mode:'active',activation:'always'}}) || json(m.checkpoints) !== json(manifest.checkpoints) || !Array.isArray(m.protectedPaths) || !m.protectedPaths.includes('config/AihController.cjs') || m.protectedPaths.some(p=>path.isAbsolute(p)||p.includes('..')) || json(m.acceptance)!==json({obligationRatio:0.95,meaningfulReduction:0.30,headlineReduction:0.50,maxStepIncrease:0.25})) fail('manifest-invalid');
  return true;
}
function validateSchema(value, name) {
  const schema = read(path.join(BENCH,'schema',name+'.schema.json'));
  function check(v,s) {
    if(s.enum && !s.enum.some(x=>json(x)===json(v))) fail('schema-enum');
    if(s.type) { const types=Array.isArray(s.type)?s.type:[s.type]; const ok=types.some(t=>t==='null'?v===null:t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):t==='integer'?Number.isSafeInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===t); if(!ok)fail('schema-type'); }
    if(s.minimum!==undefined&&v<s.minimum)fail('schema-minimum');
    if(s.pattern&&typeof v==='string'&&!new RegExp(s.pattern).test(v))fail('schema-pattern');
    if(s.required)for(const k of s.required)if(!Object.hasOwn(v,k))fail('schema-required');
    if(s.properties)for(const [k,x] of Object.entries(v)){if(s.properties[k])check(x,s.properties[k]);else if(s.additionalProperties===false)fail('schema-extra');}
    if(s.items)for(const x of v)check(x,s.items);
  }
  check(value,schema); return true;
}
module.exports={fs,path,os,crypto,REPO,BENCH,manifest,hash,json,read,fail,noLinks,rootOf,inside,write,contractHash,owned,ready,secretName,safeBytes,inventory,copyInventory,treeHash,git,validateManifest,validateSchema};
