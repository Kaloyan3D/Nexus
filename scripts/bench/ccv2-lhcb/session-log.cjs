'use strict';
// Benchmark-only adapter. The frozen shared reader stops at the first Zstd
// frame on pinned Node 24. DSH JSONL persistence appends independent frames.
// Decode every complete frame with Node's checksum-validating decoder, then
// retain the installed DSH storage codec and contiguous sequence authority.
const S=require('./state.cjs');
const shared=require('../../lib/Ccv2SessionLog.cjs');
const zlib=require('node:zlib');
// Node's sync decoder can accept a torn final frame. Check complete frame
// boundaries first, matching the installed JSONL persistence frame format;
// native Zstd still owns decompression and checksum validation.
function frameEnd(raw,start){
  let offset=start;
  const take=size=>{if(raw.length-offset<size)S.fail('session-compressed-frame-invalid');const at=offset;offset+=size;return at;};
  if(raw.readUInt32LE(take(4))!==0xfd2fb528)S.fail('session-compressed-frame-invalid');
  const descriptor=raw[take(1)];if(descriptor&24)S.fail('session-compressed-frame-invalid');
  const sizeFlag=descriptor>>>6,single=!!(descriptor&32),dictionaryFlag=descriptor&3;
  take((single?0:1)+(dictionaryFlag===3?4:dictionaryFlag)+(sizeFlag===0?(single?1:0):1<<sizeFlag));
  for(;;){const block=raw.readUIntLE(take(3),3),kind=(block>>>1)&3;if(kind===3)S.fail('session-compressed-frame-invalid');take(kind===1?1:block>>>3);if(block&1)break;}
  if(descriptor&4)take(4);
  return offset;
}
function readSessionLog(file,options){
  if(!file.endsWith('.zstd')){const parsed=shared.readSessionLog(file,options);return {...parsed,sourceHash:S.hash(S.fs.readFileSync(file)),storageFrames:0};}
  const raw=S.fs.readFileSync(file),chunks=[];let offset=0;
  try{
    while(offset<raw.length){
      const end=frameEnd(raw,offset),decoded=zlib.zstdDecompressSync(raw.subarray(offset,end),{info:true});
      const consumed=decoded.engine.bytesWritten;
      if(consumed!==end-offset)S.fail('session-compressed-frame-invalid');
      chunks.push(decoded.buffer);offset+=consumed;
    }
  }catch{S.fail('session-compressed-frame-invalid');}
  const text=Buffer.concat(chunks).toString('utf8'),lines=text.split('\n').filter(line=>line!=='');
  if(!lines.length)S.fail('session-envelope-invalid');
  let header,events=[];
  try{
    header=JSON.parse(lines[0]);
    if(!header||header.type!=='session'||typeof header.id!=='string')S.fail('session-envelope-invalid');
    const codec=shared.loadDshSessionModule(options.installRoot);
    for(const line of lines.slice(1))events.push(...codec.decodeStorageRecord(JSON.parse(line)));
  }catch{S.fail('session-envelope-invalid');}
  if(events.some((e,index)=>e?.seq!==index))S.fail('session-sequence-invalid');
  return {header,events,sourceBytes:raw.length,decodedBytes:Buffer.byteLength(text),sourceHash:S.hash(raw),storageFrames:chunks.length};
}
module.exports={readSessionLog};
