'use strict'

const assert = require('node:assert/strict')
const controller = require('../config/AihController.cjs')

let passed = 0
function check(name, fn) { fn(); passed += 1; console.log('PASS: ' + name) }

const smoke = [
  'Inspect the current Engineering Mode architecture and identify where',
  'EpistemicPolicy integrates with WorkingSet and StepRouting.',
  '',
  'Do not modify files.',
  'Do not run an independent review.',
  'Return only the relevant integration points.',
].join('\n')

const repositoryCases = [
  smoke,
  'Inspect the current implementation.',
  'Identify where StepRouting integrates with the controller.',
  'Trace where this symbol is used.',
  'Show how the current controller resolves profiles.',
  'Explain how the current implementation routes requests.',
  'How does the current implementation work?',
  'What currently handles verification?',
  'Which code path writes epistemic-state.json?',
]
for (const text of repositoryCases) {
  check('repository: ' + text.split('\n')[0], () => assert.equal(controller.classifyEpistemicPrompt(text).kind, 'repository'))
}

const judgmentCases = [
  'How should we redesign Engineering Mode?',
  'Recommend the best architecture for persistent memory.',
  'Which persistence architecture should we choose?',
  'Design a better controller abstraction.',
  'Which architecture preserves both invariants?',
]
for (const text of judgmentCases) {
  check('judgment: ' + text, () => assert.equal(controller.classifyEpistemicPrompt(text).kind, 'judgment'))
}

check('implementation request remains implementation-ready', () => {
  const value = controller.classifyEpistemicPrompt('Fix this implementation bug.')
  assert.equal(value.kind, 'judgment')
  assert.equal(value.implementationReady, true)
})
check('runtime serialization question remains empirical', () => {
  const value = controller.classifyEpistemicPrompt('What type does this PowerShell runtime value serialize to?')
  assert.equal(value.kind, 'empirical')
  assert.equal(value.probeAvailable, true)
})
check('ambiguous engineering request remains conservative judgment', () => {
  assert.equal(controller.classifyEpistemicPrompt('Think about the controller boundary.').kind, 'judgment')
})
check('usage event maps authoritative DSH token fields', () => {
  assert.deepEqual(controller.engineeringUsageOfEvent({
    type: 'assistant/chunk',
    data: { turn: 4, step: 2, chunk: { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 9000, outputTokens: 250 } } },
  }), { turn: '4', step: '2', stepId: '4:2', inputTokens: 1200, uncachedInputTokens: 1200, cacheReadTokens: 9000, outputTokens: 250, usageAvailable: true })
})
check('missing cache field is an authoritative zero cache hit', () => {
  const value = controller.engineeringUsageOfEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } } } })
  assert.equal(value.cacheReadTokens, 0)
})
check('non-usage events are ignored', () => {
  assert.equal(controller.engineeringUsageOfEvent({ type: 'turn/end', data: {} }), null)
})

console.log('RESULT: ' + passed + ' epistemic production hardening assertions passed.')
