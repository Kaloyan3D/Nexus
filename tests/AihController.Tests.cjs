'use strict'

const assert = require('node:assert/strict')
const controller = require('../config/AihController.cjs')

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
function pluginMessage(text, form) {
  return { role: 'user', source: { kind: 'plugin', plugin: 'aih-controller', form }, content: [{ type: 'text', text }] }
}

async function main() {
  // 1. Explicit review command detection is deterministic (exact prefix, not keyword sniffing)
  assert.equal(controller.isReviewCommand('/codex-review audit the boundary'), true)
  assert.equal(controller.isReviewCommand('/codex-review'), true)
  assert.equal(controller.isReviewCommand('  /codex-review  run it'), true)
  assert.equal(controller.isReviewCommand('audit the security boundary'), false)
  assert.equal(controller.isReviewCommand('please review this code'), false)
  assert.equal(controller.isReviewCommand('/codex'), false)
  assert.equal(controller.reviewQuestionOf('/codex-review   audit the boundary  '), 'audit the boundary')
  assert.equal(controller.reviewQuestionOf('/codex-review'), '')
  assert.equal(controller.reviewQuestionOf('audit the boundary'), 'audit the boundary')

  // 2. Only genuine user prompts drive binding; plugin/system messages are ignored
  assert.equal(controller.isUserPrompt(userMessage('do the thing')), true)
  assert.equal(controller.isUserPrompt(pluginMessage('context snapshot', 'snapshot')), false)
  assert.equal(controller.isUserPrompt({ role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] }), false)
  assert.equal(controller.isUserPrompt({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'x' }] }), false)
  const prompts = controller.userPromptMessages([pluginMessage('snapshot', 'snapshot'), userMessage('the audit task'), userMessage('/codex-review now')])
  assert.equal(prompts.length, 2)
  assert.equal(controller.textOf(prompts[1]), '/codex-review now')

  // 3. Worker (subagent) sessions are excluded from controller binding
  assert.equal(controller.isWorkerAgent({ origin: 'subagent', delegationDepth: 1 }), true)
  assert.equal(controller.isWorkerAgent({ delegationDepth: 2 }), true)
  assert.equal(controller.isWorkerAgent({ agentPreset: 'aih-engineering' }), false)

  // 4. Execution labels make the path visible to the user
  assert.equal(controller.executionClassLabel('codex_review'), 'Codex Review (read-only, bounded)')
  assert.equal(controller.executionClassLabel('deepseek_normal'), 'DeepSeek Normal')

  // 5. Controller messages are plugin-owned user-role messages (visible, no model source)
  const message = controller.createControllerMessage('Controller: task bound', 'controller-binding')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'aih-controller')
  assert.equal(message.source.form, 'controller-binding')
  assert.equal(message.content[0].type, 'text')
  assert.ok(message.id)

  // 6. parseCliJson recovers strings containing raw control characters that
  //    Windows PowerShell 5.1 ConvertTo-Json leaves unescaped
  const raw = '{"description":"a\u0000b\u0001c\u001ad","ok":true}'
  const rawWithByte = '{"description":"before' + String.fromCharCode(0x1a) + 'after","ok":true}'
  const hostileJson = '{\r\n    "description":  "line1' + String.fromCharCode(0x1a) + 'line2",\r\n    "ok":  true\r\n}'
  assert.equal(controller.parseCliJson(raw).description, 'a\u0000b\u0001c\u001ad')
  assert.equal(controller.parseCliJson(rawWithByte).description, 'before' + String.fromCharCode(0x1a) + 'after')
  assert.equal(controller.parseCliJson(hostileJson).ok, true)
  assert.equal(controller.parseCliJson(hostileJson).description, 'line1' + String.fromCharCode(0x1a) + 'line2')
  assert.equal(controller.parseCliJson('  '), null)
  assert.equal(controller.parseCliJson(null), null)
  // structural whitespace (ConvertTo-Json pretty format) must keep parsing
  assert.equal(controller.parseCliJson('{\r\n    "a":  1\r\n}').a, 1)

  // 7. PowerShell bridge round-trip: user-derived text travels in a UTF-8
  //    payload file and the CLI stdout round-trips byte-exact. This is the
  //    deterministic integration boundary for the production failure where
  //    a /codex-review prompt containing quotes, CRLF, Unicode arrows and
  //    control characters made Task.ps1 emit JSON the bridge could not parse
  //    (session-85b96a59-65b2-4747-a6ca-341f947394d9).
  const { execFile } = require('node:child_process')
  const { promisify } = require('node:util')
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const runCli = promisify(execFile)
  const scriptsRoot = path.join(__dirname, '..', 'scripts')
  const payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-payload-'))
  const hostileDescription =
    'Verify only the ARTHUR Phase 2 remediation for findings F1, F2 and F3.\r\n' +
    'Repository: D:\\A.R.T.H.U.R \u2192 arrows \u2014 emdash \u00e0 accented 中文\r\n' +
    'Quotes: "double" and \'single\' and backslash: C:\\path\\to\\x\r\n' +
    'Control: ' + String.fromCharCode(0x1a, 0x01) + '\r\n' +
    'F2 - replay after forget\r\n- remember ' + String.fromCharCode(0x1a) + ' forget again'
  const payloadPath = path.join(payloadDir, 'task.json')
  fs.writeFileSync(payloadPath, JSON.stringify({ workspace: __dirname, description: hostileDescription, reviewRequested: false }))
  const taskResult = await runCli(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', payloadPath],
    { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const task = controller.parseCliJson((taskResult.stdout || '').trim())
  assert.ok(task && task.taskId, 'Task.ps1 payload create-task returned a task')
  assert.equal(task.description, hostileDescription, 'Task.ps1 description round-trips byte-exact')
  fs.writeFileSync(payloadPath, JSON.stringify({ workspace: __dirname, description: hostileDescription, reviewRequested: true }))
  const routeResult = await runCli(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Route.ps1'), '-TaskId', task.taskId, '-Preset', 'aih-engineering', '-PayloadFile', payloadPath],
    { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const decision = controller.parseCliJson((routeResult.stdout || '').trim())
  assert.ok(decision && decision.executionClass, 'Route.ps1 payload returned a decision')
  assert.equal(decision.executionClass, 'codex_review', 'explicit review metadata routes to codex_review')
  fs.rmSync(payloadDir, { recursive: true, force: true })

  // 8. Structured CLI failures (exit 3 = hard budget rejection) must surface
  //    their stdout JSON to the bridge instead of a bare "Command failed".
  //    Regression for GUI task TASK-0003 (D:\DeepSeek Harness workspace):
  //    the context bundle exceeded 30000 tokens, Review.ps1 emitted
  //    {kind:'packet-too-large'} and exited 3; execFile rejected and the
  //    structured reason never reached the UI.
  assert.equal(controller.structuredCliStdout({ code: 3, stdout: '{ "ok": false, "kind": "packet-too-large" }' }), '{ "ok": false, "kind": "packet-too-large" }')
  assert.equal(controller.structuredCliStdout({ code: 3, stdout: '   ' }), null)
  assert.equal(controller.structuredCliStdout({ code: 3, stdout: '' }), null)
  assert.equal(controller.structuredCliStdout({ code: 1, stdout: '{ "ok": true }' }), null)
  assert.equal(controller.structuredCliStdout({ code: 2, stdout: 'x' }), null)
  assert.equal(controller.structuredCliStdout({}), null)
  assert.equal(controller.structuredCliStdout(null), null)

  // 9. REAL Review.ps1 budget rejection (no Codex call): an oversized bundle
  //    must produce exit 3 with parseable stdout carrying the violations.
  const oversizedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oversized-'))
  const oversizedBundle = path.join(oversizedDir, 'bundle.json')
  const bigContent = 'x'.repeat(140000)
  fs.writeFileSync(oversizedBundle, JSON.stringify([{ path: 'huge.txt', score: 1, content: bigContent }]))
  const reviewPayload = path.join(oversizedDir, 'review.json')
  fs.writeFileSync(reviewPayload, JSON.stringify({ workspace: __dirname, question: 'Review this function for correctness only.' }))
  let reviewError = null
  let reviewStdout = ''
  try {
    const reviewResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', task.taskId, '-FilesPath', oversizedBundle, '-Execute', '-PayloadFile', reviewPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    reviewStdout = (reviewResult.stdout || '').trim()
  } catch (error) {
    reviewError = error
    reviewStdout = controller.structuredCliStdout(error) || ''
  }
  assert.ok(reviewError, 'Review.ps1 rejects the oversized packet with a non-zero exit')
  assert.equal(Number(reviewError.code), 3, 'budget rejection exits with the structured-failure code 3')
  const rejection = controller.parseCliJson(reviewStdout)
  assert.ok(rejection, 'exit-3 stdout is parseable structured JSON')
  assert.equal(rejection.ok, false)
  assert.equal(rejection.kind, 'packet-too-large')
  assert.equal(rejection.codexCalled, false)
  assert.ok(Array.isArray(rejection.violations) && rejection.violations.length > 0, 'violations are enumerated for the GUI')
  assert.match(rejection.violations.join(' '), /token limit exceeded/, 'violation names the context-token budget')
  fs.rmSync(oversizedDir, { recursive: true, force: true })

  // 10. Review context classification is deterministic request metadata:
  //     self-contained inline code -> 'inline' (no repository context);
  //     explicitly named EXISTING files -> 'files' (exactly those files);
  //     everything else -> 'bundle' (Context Engine, unchanged).
  //     Regression for GUI TASK-0005: a tiny inline divide() review must
  //     never trigger broad repository retrieval (it previously selected a
  //     340 KB generated api-catalog.ts and filled the whole 30k budget).
  const inlineDivide =
    'Review only this function for correctness edge cases:\r\n\r\nfunction divide(a, b) {\r\n  return a / b;\r\n}\r\n\r\nDo not modify anything.'
  assert.equal(controller.classifyReviewContext(__dirname, inlineDivide), 'inline')
  assert.deepEqual(controller.referencedFilesOf(inlineDivide), [])
  assert.equal(controller.hasInlineCode(inlineDivide), true)
  assert.equal(controller.classifyReviewContext(__dirname, 'Review this:\n```js\nfunction f() { return 1 }\n```'), 'inline')
  assert.equal(controller.classifyReviewContext(__dirname, 'Review this: const add = (a, b) => { return a + b }'), 'inline')
  assert.equal(controller.classifyReviewContext(__dirname, 'Review class Widget { render() {} }'), 'inline')
  assert.equal(controller.classifyReviewContext(__dirname, 'Review the routing policy and the architecture of the harness'), 'bundle')
  assert.equal(controller.hasInlineCode('Review the routing policy and the architecture of the harness'), false)
  assert.equal(controller.classifyReviewContext(__dirname, 'Review src/add.js for bugs'), 'bundle') // file does not exist here
  assert.deepEqual(controller.referencedFilesOf('Review src/add.js for bugs'), ['src/add.js'])
  const repoRoot = path.join(__dirname, '..')
  assert.equal(controller.classifyReviewContext(repoRoot, 'Review scripts/Context.ps1 for bugs'), 'files')
  assert.equal(controller.classifyReviewContext(repoRoot, 'Review config/routing-policy.json and scripts/Context.ps1'), 'files')
  assert.equal(controller.classifyReviewContext(__dirname, 'Review ../secret.txt'), 'bundle') // escaping token resolves to no file
  assert.deepEqual(controller.referencedFilesOf('check v1.2.3 behavior'), []) // version numbers are not file refs
  assert.deepEqual(controller.referencedFilesOf('Review src/add.js and src/add.js again'), ['src/add.js']) // no duplicates

  // 11. resolveReviewFiles returns exactly the named files; unrelated large
  //     generated files are never pulled in; inline code inside a question
  //     that also names a file does not bypass the file mode.
  const fileFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-review-files-'))
  try {
    fs.mkdirSync(path.join(fileFixture, 'src'))
    fs.writeFileSync(path.join(fileFixture, 'src', 'divide.js'), 'function divide(a, b) { return a / b }\n')
    fs.writeFileSync(path.join(fileFixture, 'src', 'huge-catalog.ts'), 'x'.repeat(150000))
    const question = 'Review only src/divide.js for correctness edge cases'
    assert.equal(controller.classifyReviewContext(fileFixture, question), 'files')
    const slices = controller.resolveReviewFiles(fileFixture, question)
    assert.equal(slices.length, 1, 'only the named file is selected')
    assert.equal(slices[0].path, 'src/divide.js')
    assert.equal(slices[0].content, 'function divide(a, b) { return a / b }\n')
    assert.equal(slices[0].truncated, false)
    assert.equal(
      controller.classifyReviewContext(fileFixture, 'Review src/divide.js: function divide(a, b) { return a / b }'),
      'files',
      'a named existing file wins over inline code detection',
    )
  } finally {
    fs.rmSync(fileFixture, { recursive: true, force: true })
  }

  // 12. INLINE review end-to-end: the packet is question-only, tiny, allowed,
  //     and the 30k context quota is unchanged.
  const inlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-inline-review-'))
  try {
    const taskPayload = path.join(inlineDir, 'task.json')
    fs.writeFileSync(taskPayload, JSON.stringify({ workspace: inlineDir, description: inlineDivide, reviewRequested: true }))
    const inlineTaskResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', taskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const inlineTask = controller.parseCliJson((inlineTaskResult.stdout || '').trim())
    assert.ok(inlineTask && inlineTask.taskId, 'inline review task created')
    const inlineSlicesPath = path.join(inlineDir, 'slices.json')
    fs.writeFileSync(inlineSlicesPath, '[]') // 'inline' mode supplies zero slices, exactly like the controller
    const inlinePayloadPath = path.join(inlineDir, 'review.json')
    fs.writeFileSync(inlinePayloadPath, JSON.stringify({ workspace: inlineDir, question: inlineDivide, contextMode: 'inline' }))
    const inlinePacketResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', inlineTask.taskId, '-FilesPath', inlineSlicesPath, '-PayloadFile', inlinePayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const inlinePacket = controller.parseCliJson((inlinePacketResult.stdout || '').trim())
    assert.equal(inlinePacket.contextMode, 'inline')
    assert.equal(inlinePacket.relevantFiles.length, 0, 'no repository files in an inline review')
    assert.equal(inlinePacket.diff, '')
    assert.equal(inlinePacket.enforcement.allowed, true, 'tiny inline review is Codex-eligible')
    assert.ok(inlinePacket.enforcement.estimatedContextTokens < 2000, 'inline packet is far below the quota')
    assert.equal(inlinePacket.budget.maxContextTokens, 30000, '30k Codex context quota unchanged')
    const inlineLedger = controller.parseCliJson(fs.readFileSync(path.join(inlineDir, '.ai-harness', 'state', 'tasks.json'), 'utf8'))
    const inlineTaskRecord = inlineLedger.tasks.find((t) => t.taskId === inlineTask.taskId)
    assert.equal(inlineTaskRecord.codexCalls, 0, 'building the inline packet registers no Codex call')
  } finally {
    fs.rmSync(inlineDir, { recursive: true, force: true })
  }

  // 13. FILES review end-to-end: the named small file is the only repo context.
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-files-review-'))
  try {
    fs.mkdirSync(path.join(filesDir, 'src'))
    fs.writeFileSync(path.join(filesDir, 'src', 'divide.js'), 'function divide(a, b) { return a / b }\n')
    fs.writeFileSync(path.join(filesDir, 'src', 'huge-catalog.ts'), 'y'.repeat(150000))
    const filesQuestion = 'Review src/divide.js for correctness edge cases'
    const filesTaskPayload = path.join(filesDir, 'task.json')
    fs.writeFileSync(filesTaskPayload, JSON.stringify({ workspace: filesDir, description: filesQuestion, reviewRequested: true }))
    const filesTaskResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', filesTaskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const filesTask = controller.parseCliJson((filesTaskResult.stdout || '').trim())
    const fileSlices = controller.resolveReviewFiles(filesDir, filesQuestion)
    assert.equal(fileSlices.length, 1)
    const filesSlicesPath = path.join(filesDir, 'slices.json')
    fs.writeFileSync(filesSlicesPath, JSON.stringify(fileSlices))
    const filesPayloadPath = path.join(filesDir, 'review.json')
    fs.writeFileSync(filesPayloadPath, JSON.stringify({ workspace: filesDir, question: filesQuestion, contextMode: 'files' }))
    const filesPacketResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', filesTask.taskId, '-FilesPath', filesSlicesPath, '-PayloadFile', filesPayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const filesPacket = controller.parseCliJson((filesPacketResult.stdout || '').trim())
    assert.equal(filesPacket.contextMode, 'files')
    assert.equal(filesPacket.relevantFiles.length, 1, 'exactly the named file is included')
    assert.equal(filesPacket.relevantFiles[0].path, 'src/divide.js')
    assert.equal(filesPacket.enforcement.allowed, true)
    assert.ok(filesPacket.enforcement.estimatedContextTokens < 2000, 'named-file packet stays tiny')
    assert.ok(filesPacket.relevantFiles.every((f) => f.path !== 'src/huge-catalog.ts'), 'unrelated large generated file excluded')
  } finally {
    fs.rmSync(filesDir, { recursive: true, force: true })
  }

  // 14. BROAD/OVERSIZED guard: a files-mode review whose named file genuinely
  //     cannot fit keeps the structured packet-too-large rejection and never
  //     calls Codex (codexCalls stays 0).
  const hugeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-huge-review-'))
  try {
    fs.mkdirSync(path.join(hugeDir, 'src'))
    const hugePath = path.join(hugeDir, 'src', 'huge.js')
    fs.writeFileSync(hugePath, 'x'.repeat(140000))
    const hugeQuestion = 'Review src/huge.js for correctness'
    const hugeTaskPayload = path.join(hugeDir, 'task.json')
    fs.writeFileSync(hugeTaskPayload, JSON.stringify({ workspace: hugeDir, description: hugeQuestion, reviewRequested: true }))
    const hugeTaskResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', hugeTaskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const hugeTask = controller.parseCliJson((hugeTaskResult.stdout || '').trim())
    const hugeSlices = controller.resolveReviewFiles(hugeDir, hugeQuestion)
    assert.equal(hugeSlices.length, 1)
    const hugeSlicesPath = path.join(hugeDir, 'slices.json')
    fs.writeFileSync(hugeSlicesPath, JSON.stringify(hugeSlices))
    const hugePayloadPath = path.join(hugeDir, 'review.json')
    fs.writeFileSync(hugePayloadPath, JSON.stringify({ workspace: hugeDir, question: hugeQuestion, contextMode: 'files' }))
    let hugeError = null
    let hugeStdout = ''
    try {
      const hugeReviewResult = await runCli(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', hugeTask.taskId, '-FilesPath', hugeSlicesPath, '-Execute', '-PayloadFile', hugePayloadPath],
        { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      )
      hugeStdout = (hugeReviewResult.stdout || '').trim()
    } catch (error) {
      hugeError = error
      hugeStdout = controller.structuredCliStdout(error) || ''
    }
    assert.ok(hugeError, 'oversized named-file review rejects with a non-zero exit')
    assert.equal(Number(hugeError.code), 3, 'structured-failure exit code 3')
    const hugeRejection = controller.parseCliJson(hugeStdout)
    assert.equal(hugeRejection.ok, false)
    assert.equal(hugeRejection.kind, 'packet-too-large')
    assert.equal(hugeRejection.codexCalled, false)
    assert.match(hugeRejection.violations.join(' '), /token limit exceeded/, 'violation names the context-token budget')
    const hugeAfter = controller.parseCliJson(fs.readFileSync(path.join(hugeDir, '.ai-harness', 'runs', hugeTask.taskId, 'manifest.json'), 'utf8'))
    assert.equal(hugeAfter.codexCalls, 0, 'no Codex call registered for the oversized review')
  } finally {
    fs.rmSync(hugeDir, { recursive: true, force: true })
  }

  // 15. QUOTA/CONSENT protection unchanged: a zero-file packet WITHOUT the
  //     inline context mode still trips the full-repository consent guard.
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-guard-review-'))
  try {
    const guardTaskPayload = path.join(guardDir, 'task.json')
    fs.writeFileSync(guardTaskPayload, JSON.stringify({ workspace: guardDir, description: 'Review the whole repository', reviewRequested: true }))
    const guardTaskResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', guardTaskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const guardTask = controller.parseCliJson((guardTaskResult.stdout || '').trim())
    const guardSlicesPath = path.join(guardDir, 'slices.json')
    fs.writeFileSync(guardSlicesPath, '[]')
    const guardPayloadPath = path.join(guardDir, 'review.json')
    fs.writeFileSync(guardPayloadPath, JSON.stringify({ workspace: guardDir, question: 'Review the whole repository' })) // no contextMode: defaults to 'bundle'
    const guardPacketResult = await runCli(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', guardTask.taskId, '-FilesPath', guardSlicesPath, '-PayloadFile', guardPayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const guardPacket = controller.parseCliJson((guardPacketResult.stdout || '').trim())
    assert.equal(guardPacket.enforcement.allowed, false)
    assert.match(guardPacket.enforcement.violations.join(' '), /full repository context requires explicit user approval/, 'full-repo consent guard unchanged')
    assert.equal(guardPacket.budget.maxContextTokens, 30000, '30k quota unchanged')
  } finally {
    fs.rmSync(guardDir, { recursive: true, force: true })
  }

  console.log('PASS: aih-controller bridge behavior')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
