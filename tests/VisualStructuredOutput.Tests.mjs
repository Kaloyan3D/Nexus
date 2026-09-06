import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runTransport, parseReviewText } from '../scripts/Invoke-VisualReview.mjs'

/**
 * Visual transport contract tests (loopback provider, no real network):
 *  - the outbound chat-completions request carries response_format json_object
 *  - the request carries NO explicit output-token cap (no max_tokens,
 *    max_completion_tokens, or max_output_tokens): the provider/model enforces
 *    its native generation limits (V1.2)
 *  - finish_reason=length is detected: empty or truncated content fails closed
 *    as output-truncated (single attempt, never retried, never repaired) and
 *    reasoning_content is NEVER used as result content
 *  - valid structured content still passes normally
 *  - the bounded transient retry (max 2 attempts) is unchanged for empty
 *    content WITHOUT finish_reason=length (retry ownership: this module only)
 */

const VALID_REVIEW = {
  verdict: 'REVISE',
  score: 6.5,
  dimensions: { hierarchy: 7, spacing: 5, density: 6, typography: 8, alignment: 7, colorDiscipline: 6, interactionClarity: 5, brandFidelity: 7, platformQuality: 6 },
  findings: [{ id: 'F1', severity: 'high', category: 'spacing', area: 'top bar', observation: 'crowded', whyItMatters: 'touch targets', recommendation: 'add margin', confidence: 'high' }],
  strengths: ['clear hierarchy'],
  summary: 'solid layout, spacing needs work',
}

let seenBodies = []
let scripted = []
const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (chunk) => { data += chunk })
  req.on('end', () => {
    seenBodies.push(JSON.parse(data))
    const next = scripted.shift()
    if (!next) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no scripted response' } }))
      return
    }
    res.writeHead(next.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(next.body ?? {}))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-structured-'))
fs.writeFileSync(path.join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
process.env.AIH_STRUCTURED_TEST_KEY = 'test-key-not-real'
const baseRequest = {
  baseUrl: 'http://127.0.0.1:' + port,
  model: 'deepseek-v4-flash-vision-exp',
  userText: 'Review this screen.',
  systemPrompt: 'You are a visual reviewer.',
  apiKeyEnv: 'AIH_STRUCTURED_TEST_KEY',
  images: [{ path: path.join(tmp, 'shot.png') }],
}

function chatBody(overrides = {}) {
  const message = { content: JSON.stringify(VALID_REVIEW), ...(overrides.message || {}) }
  return {
    model: 'deepseek-v4-flash-vision-exp',
    choices: [{ message, finish_reason: overrides.finish_reason === undefined ? 'stop' : overrides.finish_reason }],
    usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
  }
}

// 1. the generated provider request carries NO explicit output-token cap
//    (even when a caller still passes a legacy maxOutputTokens hint)
scripted = [{ body: chatBody() }]
seenBodies = []
const uncapped = await runTransport({ ...baseRequest, maxOutputTokens: 4096 })
assert.equal(uncapped.exitCode, 0)
assert.equal(seenBodies[0].max_tokens, undefined, 'max_tokens must be absent from the visual review request')
assert.equal(seenBodies[0].max_completion_tokens, undefined, 'max_completion_tokens must be absent')
assert.equal(seenBodies[0].max_output_tokens, undefined, 'max_output_tokens must be absent')
assert.equal(seenBodies[0].response_format.type, 'json_object', 'the outbound request still carries response_format json_object')
assert.ok(seenBodies[0].messages[1].content[0].text.includes('single JSON object'), 'the user instruction still requires a single JSON object')

// 2. json_schema responseFormat passthrough is unchanged
scripted = [{ body: chatBody() }]
seenBodies = []
const schemaFormat = { type: 'json_schema', json_schema: { name: 'visual_review', strict: true } }
await runTransport({ ...baseRequest, responseFormat: schemaFormat })
assert.deepEqual(seenBodies[0].response_format, schemaFormat, 'a json_schema responseFormat is forwarded without vendor branching')

// 3. valid structured content passes normally; finish_reason metadata recorded
scripted = [{ body: chatBody({ finish_reason: 'stop' }) }]
const okRun = await runTransport(baseRequest)
assert.equal(okRun.outcome.ok, true)
assert.equal(okRun.outcome.review.verdict, 'REVISE')
assert.equal(okRun.outcome.finishReason, 'stop', 'finish_reason is recorded as safe transport metadata')
assert.equal(okRun.outcome.usage.completion_tokens_details.reasoning_tokens, 5, 'usage (token counts only) is passed through')

// 4. finish_reason=length with a COMPLETE JSON object still succeeds
//    (the native limit was reached exactly after the complete object)
scripted = [{ body: chatBody({ finish_reason: 'length' }) }]
const completeAtLimit = await runTransport(baseRequest)
assert.equal(completeAtLimit.outcome.ok, true, 'a complete JSON object at the native limit is not a truncation failure')
assert.equal(completeAtLimit.outcome.finishReason, 'length')

// 5. finish_reason=length + truncated JSON fails closed as output-truncated
//    (single attempt: deterministic truncation is never retried)
scripted = [{
  body: chatBody({
    finish_reason: 'length',
    message: { content: '{"verdict":"REVISE","score":7,"findings":[{"id"' },
  }),
}]
const truncated = await runTransport(baseRequest)
assert.equal(truncated.exitCode, 3)
assert.equal(truncated.outcome.ok, false)
assert.equal(truncated.outcome.errorKind, 'output-truncated', 'truncated JSON is classified output-truncated, not schema-invalid')
assert.equal(truncated.outcome.attemptCount, 1, 'output truncation is deterministic: exactly one provider attempt')
assert.equal(truncated.outcome.finishReason, 'length')

// 6. finish_reason=length + empty content + reasoning_content populated:
//    reasoning_content is NEVER used as result content
scripted = [{
  body: chatBody({
    finish_reason: 'length',
    message: { content: '', reasoning_content: JSON.stringify(VALID_REVIEW) },
  }),
}]
const reasoningOnly = await runTransport(baseRequest)
assert.equal(reasoningOnly.exitCode, 3)
assert.equal(reasoningOnly.outcome.errorKind, 'output-truncated', 'an empty content at the native limit fails closed as output-truncated')
assert.equal(reasoningOnly.outcome.content, undefined, 'reasoning_content is never promoted to result content')
assert.equal(reasoningOnly.outcome.review, undefined, 'no review is parsed from reasoning_content')
assert.equal(reasoningOnly.outcome.attemptCount, 1)

// 7. empty content WITHOUT finish_reason=length keeps the legacy transient
//    classification: the transport owns exactly ONE bounded retry (2 attempts)
scripted = [{ body: chatBody({ finish_reason: null, message: { content: '' } }) }, { body: chatBody({ finish_reason: null, message: { content: '' } }) }]
const emptyRetried = await runTransport(baseRequest)
assert.equal(emptyRetried.exitCode, 3)
assert.equal(emptyRetried.outcome.errorKind, 'empty-content')
assert.equal(emptyRetried.outcome.attemptCount, 2, 'the bounded transient retry for legacy empty content is unchanged (max 2 attempts)')
assert.equal(emptyRetried.outcome.attempts.filter((a) => a.kind === 'empty-content').length, 2)

// 8. missing assistant content without finish_reason keeps provider-response-shape
const shapeBody = { model: 'deepseek-v4-flash-vision-exp', choices: [{ finish_reason: 'stop' }] }
scripted = [{ body: shapeBody }, { body: shapeBody }]
const shapeRun = await runTransport(baseRequest)
assert.equal(shapeRun.outcome.errorKind, 'provider-response-shape')
assert.equal(shapeRun.outcome.attemptCount, 2)

// 9. parseReviewText contract (handoff to Nexus strict validation)
assert.equal(parseReviewText(JSON.stringify(VALID_REVIEW)).verdict, 'REVISE', 'bare JSON object parses')
const fence = String.fromCharCode(96, 96, 96)
const fenced = fence + 'json' + String.fromCharCode(10) + JSON.stringify(VALID_REVIEW) + String.fromCharCode(10) + fence
assert.equal(parseReviewText(fenced).verdict, 'REVISE', 'markdown-fenced JSON remains parseable (tolerated secondary path)')
assert.equal(parseReviewText('Here is the review: the layout looks good.'), null, 'prose is rejected (never regex-extracted as the primary solution)')
assert.equal(parseReviewText('[{"verdict":"PASS"}]'), null, 'a JSON array is rejected - the contract is one object')
assert.equal(parseReviewText('{"verdict":"PASS","patch":"diff"}').patch, 'diff', 'a schema-invalid OBJECT still parses; Nexus validation rejects it (PS 8b)')

fs.rmSync(tmp, { recursive: true, force: true })
server.close()
console.log('PASS: visual structured-output transport contract')