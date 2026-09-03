import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runTransport, parseReviewText } from '../scripts/Invoke-VisualReview.mjs'

/**
 * V1.1 hardening: provider-level constrained structured output tests.
 * Runs the REAL transport against a loopback HTTP server and asserts:
 *  - the outbound chat-completions request carries response_format json_object
 *  - a json_schema responseFormat object is forwarded verbatim (no vendor branching)
 *  - a valid JSON object response flows through the transport
 *  - parseReviewText: bare/fenced JSON accepted; prose and arrays rejected.
 * Provider-level structure NEVER replaces strict Nexus validation (PS 8b).
 */

const VALID_REVIEW = {
  verdict: 'REVISE',
  score: 6.5,
  dimensions: { hierarchy: 7, spacing: 5, density: 6, typography: 8, alignment: 7, colorDiscipline: 6, interactionClarity: 5, brandFidelity: 7, platformQuality: 6 },
  findings: [{ id: 'F1', severity: 'high', category: 'spacing', area: 'top bar', observation: 'crowded', whyItMatters: 'touch targets', recommendation: 'add margin', confidence: 'high' }],
  strengths: ['clear hierarchy'],
  summary: 'solid layout, spacing needs work',
}

let seenBody = null
const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (chunk) => { data += chunk })
  req.on('end', () => {
    seenBody = JSON.parse(data)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'deepseek-v4-flash-vision-exp', choices: [{ message: { content: JSON.stringify(VALID_REVIEW) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-structured-'))
fs.writeFileSync(path.join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
process.env.AIH_STRUCTURED_TEST_KEY = 'test-key-not-real'
const request = {
  baseUrl: 'http://127.0.0.1:' + port,
  model: 'deepseek-v4-flash-vision-exp',
  userText: 'Review this screen.',
  systemPrompt: 'You are a visual reviewer.',
  apiKeyEnv: 'AIH_STRUCTURED_TEST_KEY',
  images: [{ path: path.join(tmp, 'shot.png') }],
}

// 1. the outbound request carries response_format json_object
const outcome = await runTransport(request)
assert.equal(outcome.exitCode, 0, 'valid JSON object response succeeds at the transport layer')
assert.ok(seenBody.response_format, 'the outbound request carries response_format')
assert.equal(seenBody.response_format.type, 'json_object')
assert.ok(seenBody.messages[1].content[0].text.includes('single JSON object'), 'the user instruction requires a single JSON object')
assert.equal(outcome.outcome.ok, true)
assert.equal(outcome.outcome.review.verdict, 'REVISE')

// 2. explicit passthrough: a json_schema responseFormat object is forwarded verbatim
seenBody = null
const schemaFormat = { type: 'json_schema', json_schema: { name: 'visual_review', strict: true } }
await runTransport({ ...request, responseFormat: schemaFormat })
assert.deepEqual(seenBody.response_format, schemaFormat, 'a json_schema responseFormat is forwarded without vendor branching')

// 3. parseReviewText contract (handoff to Nexus strict validation)
assert.equal(parseReviewText(JSON.stringify(VALID_REVIEW)).verdict, 'REVISE', 'bare JSON object parses')
const fenced = '```json' + String.fromCharCode(10) + JSON.stringify(VALID_REVIEW) + String.fromCharCode(10) + '```'
assert.equal(parseReviewText(fenced).verdict, 'REVISE', 'markdown-fenced JSON remains parseable (tolerated secondary path)')
assert.equal(parseReviewText('Here is the review: the layout looks good.'), null, 'prose is rejected (never regex-extracted as the primary solution)')
assert.equal(parseReviewText('[{"verdict":"PASS"}]'), null, 'a JSON array is rejected - the contract is one object')
assert.equal(parseReviewText('{"verdict":"PASS","patch":"diff"}').patch, 'diff', 'a schema-invalid OBJECT still parses; Nexus validation rejects it (PS 8b)')

fs.rmSync(tmp, { recursive: true, force: true })
server.close()
console.log('PASS: visual structured-output transport contract')
