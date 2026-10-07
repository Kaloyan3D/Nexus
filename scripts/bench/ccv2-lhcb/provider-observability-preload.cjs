'use strict';
// Pinned-module, in-memory capture hooks. No dependency files are edited.
const {registerHooks}=require('node:module'),{pathToFileURL}=require('node:url'),path=require('node:path'),crypto=require('node:crypto');
const observer=require('./provider-observability.cjs');
const importLine='import __lhcbCapture from '+JSON.stringify(pathToFileURL(path.join(__dirname,'provider-observability.cjs')).href)+';\n';
function transform(url,source){
 let replacements;
 if(/\/@earendil-works\/pi-ai\/dist\/api\/openai-responses\.js$/.test(url))replacements=[
  ['        const output = {','        const __lhcbObservation = __lhcbCapture.begin(model, context, options);\n        const output = {'],
  ['() => client.responses.create(params, requestOptions).withResponse()','() => __lhcbCapture.sdkAttempt(__lhcbObservation, client, params, requestOptions, () => client.responses.create(params, requestOptions).withResponse())'],
  ['            stream.push({ type: "done", reason: output.stopReason, message: output });','            __lhcbCapture.finish(__lhcbObservation, output);\n            stream.push({ type: "done", reason: output.stopReason, message: output });'],
  ['        catch (error) {\n            for (const block of output.content) {','        catch (error) {\n            __lhcbCapture.finish(__lhcbObservation, output, error);\n            for (const block of output.content) {']
 ];
 else if(/\/@deepseek-ai\/dsh-session\/lib\/index\.js$/.test(url))replacements=[['\t\t\tthis.log.push(event);','\t\t\tthis.log.push(event);\n\t\t\t__lhcbCapture.sessionEvent(this, event);']];
 else if(/\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/.test(url))replacements=[['\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {','\t\t\t\t__lhcbCapture.registerSignals(options, watchdog.signal, profile);\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {']];
 else return source;
 // Refuse partial transforms, preserving original behavior on version drift.
 if(replacements.some(([from])=>source.split(from).length!==2)){observer.emit({kind:'observer_hook_unavailable',module:path.basename(path.dirname(url))+'/'+path.basename(url),reason:'pinned-anchor-mismatch'});return source;}
 const hash=crypto.createHash('sha256').update(source).digest('hex');for(const [from,to] of replacements)source=source.replace(from,to);
 observer.emit({kind:'observer_hook_installed',module:url.replace(/^.*\/node_modules\//,''),originalSourceSha256:hash});return importLine+source;
}
if(process.env.LHCB_PROVIDER_OBSERVABILITY_FILE){
 registerHooks({load(url,context,nextLoad){const loaded=nextLoad(url,context);if(loaded.source==null||!url.startsWith('file:')||!/(?:\/@earendil-works\/pi-ai\/dist\/api\/openai-responses|\/@deepseek-ai\/dsh-(?:session|llm-pi-ai)\/lib\/index)\.js$/.test(url))return loaded;const source=Buffer.isBuffer(loaded.source)?loaded.source.toString('utf8'):String(loaded.source);return {...loaded,source:transform(url,source)};}});
}
module.exports={transform};
