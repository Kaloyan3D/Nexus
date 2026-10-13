'use strict'
// Explicit disposable installed tree only. No provider credentials or inference.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const repo = path.resolve(__dirname, '..')
const root = fs.realpathSync(process.argv[2] || '')
assert(root.startsWith(fs.realpathSync(path.join(repo, 'tmp')) + path.sep))
const req = createRequire(path.join(root, 'app/package.json'))
const esm = name => import(pathToFileURL(req.resolve(name)).href)
let passed = 0
async function check(name, fn) { await fn(); console.log('PASS: ' + name); passed++ }
async function main() {
  await check('native node-pty import', () => { assert(req('node-pty').spawn) })
  await check('native koffi import', () => { assert(req('koffi').load) })
  await check('patched sharp decodes raster and SVG with prebuilt fixed libraries', async () => {
    const sharp = req('sharp')
    assert.equal(sharp.versions.sharp, '0.35.5')
    assert.equal(sharp.versions.rsvg, '2.63.2')
    const png = await sharp(Buffer.from('<svg width="2" height="3"><rect width="2" height="3" fill="red"/></svg>')).png().toBuffer()
    const meta = await sharp(png).metadata(); assert.equal(meta.width, 2); assert.equal(meta.height, 3)
  })
  await check('patched YAML retains DSH merge semantics and enforces empty-merge budget', () => {
    const yaml = req('js-yaml')
    assert.equal(yaml.load('base: &b {x: 1}\nvalue: {<<: *b}').value.x, 1)
    assert.throws(() => yaml.load('a: &a [{}, {}, {}]\nb: {<<: *a}', { maxTotalMergeKeys: 1 }))
  })
  await check('patched proxy subnet rejects unrelated clients', () => {
    assert.equal(req('proxy-addr').compile('::ffff:10/8')('203.0.113.1', 0), false)
  })
  await check('patched qs blocks comma array overflow and safely serializes constructor data', () => {
    const qs = req('qs')
    assert.throws(() => qs.parse('a[]=1,2,3,4', { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }), RangeError)
    assert.doesNotThrow(() => qs.stringify(qs.parse('constructor[isBuffer]=x', { plainObjects: true })))
  })
  await check('patched ip-address separates address families and recognizes link-local', () => {
    const { Address4, Address6 } = req('ip-address')
    assert.equal(new Address6('a00::1').isInSubnet(new Address4('10.0.0.0/8')), false)
    assert.equal(new Address6('fe81::1').isLinkLocal(), true)
  })
  await check('pinned OAuth adapter loads with patched provider-utils', async () => {
    const adapter = await esm('@openai-oauth/ai-sdk'); assert(Object.keys(adapter).length)
    const provider = await esm('@ai-sdk/openai'); assert.equal(typeof provider.createOpenAI, 'function')
    let calls = 0
    const openai = provider.createOpenAI({ apiKey: 'offline-fake-only', fetch: async () => {
      calls++
      return new Response(JSON.stringify({ id: 'chatcmpl-offline', created: 1, model: 'gpt-4.1-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'offline' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
    } })
    const completion = await openai.chat('gpt-4.1-mini').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'offline transport check' }] }] })
    assert.equal(calls, 1); assert(completion.content.some(part => part.type === 'text' && part.text === 'offline'))
    const { default: Ajv } = await esm('ajv'); assert(new Ajv().compile({ type: 'string' })('ok'))
  })
  await check('patched OAuth response handlers reject oversized declared bodies', async () => {
    const utils = await esm('@ai-sdk/provider-utils')
    const handler = utils.createJsonResponseHandler(req('zod').z.object({ ok: req('zod').z.boolean() }))
    const good = await handler({ response: new Response('{"ok":true}'), url: 'https://offline.invalid', requestBodyValues: {} })
    assert.equal(good.value.ok, true)
    await assert.rejects(handler({ response: new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024 * 1024) } }), url: 'https://offline.invalid', requestBodyValues: {} }), /maximum size/)
  })
  await check('actual pinned DSH MCP HTTP initialization and tool discovery use patched SDK', async () => {
    const { Server } = await esm('@modelcontextprotocol/sdk/server/index.js')
    const { StreamableHTTPServerTransport } = await esm('@modelcontextprotocol/sdk/server/streamableHttp.js')
    const { ListToolsRequestSchema } = await esm('@modelcontextprotocol/sdk/types.js')
    const mcp = await esm('@deepseek-ai/dsh-mcp-client')
    const server = new Server({ name: 'offline-audit', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => require('node:crypto').randomUUID(), enableJsonResponse: true })
    await server.connect(transport)
    let requests = 0; const effects = []
    const wire = http.createServer((incoming, outgoing) => { requests++; transport.handleRequest(incoming, outgoing).catch(e => { outgoing.statusCode = 500; outgoing.end(String(e)) }) })
    await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve))
    const ctx = { root: {}, effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose) }, tools: { register() { throw new Error('empty tool set expected') } }, logger: { info() {}, warn() {}, error() {} } }
    try {
      await mcp.apply(ctx, { transport: 'streamable-http', serverName: 'offline', url: `http://127.0.0.1:${wire.address().port}/mcp`, headers: {}, toolCallTimeoutMs: 5000, failOnStartupError: true, reconnect: { enabled: false } })
      assert(requests >= 3, 'initialize, initialized notification and tools/list traversed HTTP')
    } finally {
      for (const dispose of effects.reverse()) await dispose()
      await server.close(); wire.closeAllConnections(); await new Promise(resolve => wire.close(resolve))
    }
  })
  await check('actual pinned DSH MCP stdio initialization uses patched SDK', async () => {
    const mcp = await esm('@deepseek-ai/dsh-mcp-client')
    const script = fs.mkdtempSync(path.join(repo, 'tmp', 'mcp-stdio-'))
    const file = path.join(script, 'server.mjs')
    fs.writeFileSync(file, `import {Server} from ${JSON.stringify(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/index.js')).href)};
import {StdioServerTransport} from ${JSON.stringify(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href)};
import {ListToolsRequestSchema} from ${JSON.stringify(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/types.js')).href)};
const server=new Server({name:'offline-stdio',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
await server.connect(new StdioServerTransport());`)
    const effects = []
    const ctx = { root: {}, effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose) }, tools: { register() { throw new Error('empty tool set expected') } }, logger: { info() {}, warn() {}, error() {} } }
    try {
      await mcp.apply(ctx, { transport: 'stdio', serverName: 'offline_stdio', command: process.execPath, args: [file], env: {}, cwd: script, toolCallTimeoutMs: 5000, failOnStartupError: true, reconnect: { enabled: false } })
    } finally {
      for (const dispose of effects.reverse()) await dispose()
      fs.rmSync(script, { recursive: true, force: true })
    }
  })
  console.log(`SUITE RESULT: PASS ${passed} | FAIL 0 | total ${passed}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
