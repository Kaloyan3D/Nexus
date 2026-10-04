'use strict';
// The preparation worker never needs a socket, provider or remote counter.
let attempts=0;
const deny=()=>{attempts++;throw Error('lhcb-bootstrap-network-forbidden');};
for(const [name,keys] of [['net',['connect','createConnection']],['tls',['connect']],['http',['request','get']],['https',['request','get']],['http2',['connect']],['dgram',['createSocket']],['dns',['lookup','resolve','resolve4','resolve6','reverse']]])for(const key of keys)require('node:'+name)[key]=deny;
require('node:net').Socket.prototype.connect=deny;
require('node:net').Server.prototype.listen=deny;
for(const key of ['lookup','resolve','resolve4','resolve6','reverse'])require('node:dns').promises[key]=deny;
global.fetch=deny;global.WebSocket=class{constructor(){deny();}};
Object.defineProperty(global,'lhcbBootstrapNetwork',{value:{attempts:()=>attempts}});
process.on('exit',()=>{if(attempts)process.exitCode=98;});
