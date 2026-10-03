'use strict';
// Opt-in probe preload: accepting DSH HTTP connections is allowed, but the
// child cannot initiate a provider, discovery, credential or other connection.
// The audit contains only the PID and attempt count, never targets or payloads.
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),https=require('node:https'),dns=require('node:dns');
const file=process.env.LHCB_READ_ONLY_AUDIT_FILE;let attempts=0;
function audit(){fs.writeFileSync(file,JSON.stringify({pid:process.pid,networkAttempts:attempts})+'\n',{mode:0o600});}
function deny(){attempts++;audit();throw new Error('lhcb-read-only-network-forbidden');}
audit();
net.Socket.prototype.connect=deny;
for(const mod of [http,https]){mod.request=deny;mod.get=deny;}
globalThis.fetch=deny;
// Node's server.listen calls lookup even for a literal loopback address.
// Allow that local bind; no hostname resolution or client connection is allowed.
for(const namespace of [dns,dns.promises].filter(Boolean)){const lookup=namespace.lookup;namespace.lookup=function(host,...args){if(host==='127.0.0.1'||host==='::1')return lookup.call(this,host,...args);return deny();};for(const name of ['resolve','resolve4','resolve6'])namespace[name]=deny;}
