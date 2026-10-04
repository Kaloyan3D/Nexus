'use strict';
// Distinct caller contracts at the migration/service boundary, not repeated rows.
function cases(){
 const posting={id:'public/import',currency:'EUR',kind:'transfer',amount:31};
 const doc=(version,p=posting)=>({version,writerRevision:17,[version===1?'entries':'records']:[version===1?{id:p.id,cents:p.amount,currency:p.currency,kind:p.kind}:{...p}]});
 const command={tenant:'example-a',key:'opaque/import-key',expectedRevision:0,requestId:'import-request'};
 const rows=[];const add=(name,document,status,extras={})=>rows.push({name,document,command:{...command},expectedStatus:status,...extras});
 add('legacy-leading-zero',doc(1,{...posting,id:'001'}),201);
 add('v2-decomposed-unicode',doc(2,{...posting,id:'e\u0301',currency:'KWD'}),201);
 add('canonical-prototype-text',doc(3,{...posting,id:'__proto__',currency:'JPY'}),201);
 add('whitespace-id-and-key',doc(3,{...posting,id:' leading '}),201,{command:{...command,key:' trailing '}});
 add('future-schema-retained',doc(97),422);
 add('fractional-amount-no-write',doc(1,{...posting,amount:0.5}),422);
 add('unsafe-amount-no-write',doc(3,{...posting,amount:9007199254740992}),422);
 add('unknown-currency-no-write',doc(2,{...posting,currency:'XXX'}),422);
 add('empty-account-no-write',doc(1,{...posting,id:''}),422);
 add('empty-import-no-write',{version:3,writerRevision:17,records:[]},422);
 add('ambiguous-multiple-postings-no-write',{version:3,writerRevision:17,records:[posting,{...posting,id:'second'}]},422);
 add('stale-new-key-conflicts',doc(3),409,{initialDocument:doc(3),initialCommand:{...command,key:'initial-key'}});
 add('matching-replay-after-revision',doc(1),200,{initialDocument:doc(3),initialCommand:{...command}});
 add('changed-body-same-key-conflicts',doc(3,{...posting,amount:47}),409,{initialDocument:doc(1),initialCommand:{...command}});
 return rows;
}
const verifier=`'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/E03/import-boundary.json'),'utf8'));
const createStore=require('../src/persistence.ts').createStore,postImported=require('../src/import-service.ts').postImported;
let failures=0,diagnostics=0;
for(const row of rows){const store=createStore(),actor={tenant:row.command.tenant,role:'writer',revoked:false};let result;
 try{
  if(row.initialDocument)assert.equal(postImported(store,structuredClone(row.initialDocument),row.initialCommand,actor,()=>1).status,201);
  const document=structuredClone(row.document),command=structuredClone(row.command),before=JSON.stringify([document,command]),history=store.history().length;
  result=postImported(store,document,command,actor,()=>2);
  assert.equal(result.status,row.expectedStatus);
  assert.equal(JSON.stringify([document,command]),before,'caller inputs remain immutable');
  assert.equal(store.history().length,history+(row.expectedStatus===201?1:0),'only a new accepted operation writes');
  if(row.expectedStatus===201){const p=document.version===1?document.entries[0]:document.records[0];assert.equal(store.read(command.tenant,p.id).balance,p.amount??p.cents);assert.equal(store.replay(command.tenant,command.key).result.status,201);}
 }catch(e){failures++;if(process.argv.includes('--diagnose')&&diagnostics++<8)console.log(JSON.stringify({scenario:row.name,input:row,actual:result??null,reason:e.message}));}
}
console.log(JSON.stringify({phase:'E03-import-boundary',cases:rows.length,failures}));if(failures)process.exitCode=1;
`;
function files(){return {'evidence/E03/import-boundary.json':JSON.stringify(cases(),null,2)+'\n','tools/verify-import.cjs':verifier};}
module.exports={cases,files};
