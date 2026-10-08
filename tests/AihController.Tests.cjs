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
  {
    const singleFlight = controller.createSingleFlight((value) => value.toLowerCase())
    let executions = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const first = singleFlight('C:\\Repo', async () => { executions += 1; await gate; return { id: 1 } })
    const second = singleFlight('c:\\repo', async () => { executions += 1; return { id: 2 } })
    assert.equal(executions, 0, 'single-flight schedules its operation asynchronously')
    release()
    const values = await Promise.all([first, second])
    assert.equal(executions, 1, 'equivalent workspace resolutions execute once in the controller')
    assert.deepEqual(values, [{ id: 1 }, { id: 1 }], 'all controller consumers receive the shared result')
  }

  // 1. Explicit review command detection is deterministic (exact prefix, not
  //    keyword sniffing). /codex-review remains a compatibility alias of /review.
  assert.equal(controller.isReviewCommand('/codex-review audit the boundary'), true)
  assert.equal(controller.isReviewCommand('/codex-review'), true)
  assert.equal(controller.isReviewCommand('  /codex-review  run it'), true)
  assert.equal(controller.isReviewCommand('/review audit the boundary'), true)
  assert.equal(controller.isReviewCommand('/review'), true)
  assert.equal(controller.isReviewCommand('  /review  run it'), true)
  assert.equal(controller.isReviewCommand('audit the security boundary'), false)
  assert.equal(controller.isReviewCommand('please review this code'), false)
  assert.equal(controller.isReviewCommand('/codex'), false)
  assert.equal(controller.reviewQuestionOf('/codex-review   audit the boundary  '), 'audit the boundary')
  assert.equal(controller.reviewQuestionOf('/review   audit the boundary  '), 'audit the boundary')
  assert.equal(controller.reviewQuestionOf('/codex-review'), '')
  assert.equal(controller.reviewQuestionOf('/review'), '')
  assert.equal(controller.reviewQuestionOf('audit the boundary'), 'audit the boundary')

  // TASK-0016: ordinary GUI prompts are converted to conservative structured
  // policy inputs without a classifier model or reasoning-text inspection.
  assert.equal(controller.classifyEpistemicPrompt('Implement the requested change').implementationReady, true)
  assert.equal(controller.classifyEpistemicPrompt('Which file defines this symbol?').kind, 'repository')
  const empiricalPolicyInput = controller.classifyEpistemicPrompt('What type does this PowerShell runtime value serialize to?')
  assert.equal(empiricalPolicyInput.kind, 'empirical')
  assert.equal(empiricalPolicyInput.probeAvailable, true)
  assert.equal(empiricalPolicyInput.probeRisk, 'safe')
  assert.equal(controller.classifyEpistemicPrompt('Which architecture preserves both invariants?').kind, 'judgment')

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

  // 4. Execution labels make the path visible to the user (Phase 2:
  //    canonical classes; legacy names resolve through the same labels)
  assert.equal(controller.executionClassLabel('reviewer'), 'Independent Review (read-only)')
  assert.equal(controller.executionClassLabel('codex_review'), 'Independent Review (read-only)')
  assert.equal(controller.executionClassLabel('engineer_normal'), 'Engineer \u00b7 Normal')
  assert.equal(controller.executionClassLabel('deepseek_normal'), 'Engineer \u00b7 Normal')
  assert.equal(controller.executionClassLabel('engineer_deep'), 'Engineer \u00b7 Deep')
  assert.equal(controller.executionClassLabel('solver'), 'Solve (writable, approval-gated)')
  assert.equal(controller.canonicalExecutionClass('deepseek_deep'), 'engineer_deep')
  assert.equal(controller.isReviewClass('codex_review'), true)
  assert.equal(controller.isReviewClass('reviewer'), true)
  assert.equal(controller.isReviewClass('engineer_normal'), false)

  // Engine is selected once from the new session preset and cannot change on
  // an existing binding when the preferred/session preset changes later.
  assert.equal(controller.engineForPreset('aih-muse'), 'muse')
  assert.equal(controller.engineForPreset('aih-engineering'), 'dual')
  assert.equal(controller.engineForPreset('aih-deepseek'), 'dual')
  assert.equal(controller.assertEngineBinding({ engine: 'muse' }, 'aih-muse'), 'muse')
  assert.equal(controller.assertEngineBinding({ engine: 'dual' }, 'aih-engineering'), 'dual')
  assert.throws(() => controller.assertEngineBinding({ engine: 'muse' }, 'aih-engineering'), (error) => error.code === 'engine-binding-violation')
  assert.throws(() => controller.assertEngineBinding({ engine: 'dual' }, 'aih-muse'), (error) => error.code === 'engine-binding-violation')

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
  // TASK-0025 RC4: ONE shared test CLI transport + platform PowerShell host
  // resolution (tests/lib/AihTestTransport.cjs). The transport preserves the
  // TASK-0017 no-pipes contract (Windows cmd.exe redirection, POSIX direct
  // capture) and the host resolution mirrors production
  // Get-AihPowerShellHost so the suites exercise the SAME host strategy as
  // production on every OS instead of hard-coding powershell.exe.
  const { createAihCliRunner, resolveAihPowerShellHost } = require(path.join(__dirname, 'lib', 'AihTestTransport.cjs'))
  const runCli = createAihCliRunner()
  // Exercise the real default install-root resolution without touching the
  // live Nexus install: all controller CLIs run from a disposable copy of the
  // production scripts/config/data layout. The exit hook also runs after an
  // assertion failure, so fixture state is cleaned on both pass and failure.
  const sourceRoot = path.join(__dirname, '..')
  // Resolve the platform PowerShell host against the REAL repo root (the
  // pinned POSIX runtime lives under the installed/checkout root, not the
  // disposable bridge copy).
  const powershellHost = resolveAihPowerShellHost(sourceRoot)
  const bridgeInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-controller-install-'))
  const bridgeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-controller-workspace-'))
  fs.cpSync(path.join(sourceRoot, 'scripts'), path.join(bridgeInstallRoot, 'scripts'), { recursive: true })
  fs.cpSync(path.join(sourceRoot, 'config'), path.join(bridgeInstallRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(bridgeInstallRoot, 'data', 'routing'), { recursive: true })
  if (fs.existsSync(path.join(sourceRoot, 'data', 'settings.yaml'))) {
    fs.copyFileSync(path.join(sourceRoot, 'data', 'settings.yaml'), path.join(bridgeInstallRoot, 'data', 'settings.yaml'))
  } else {
    fs.copyFileSync(path.join(sourceRoot, 'config', 'settings.yaml'), path.join(bridgeInstallRoot, 'data', 'settings.yaml'))
  }
  const bridgeSettingsPath = path.join(bridgeInstallRoot, 'data', 'settings.yaml')
  const bridgeSettings = fs.readFileSync(bridgeSettingsPath, 'utf8')
  fs.writeFileSync(bridgeSettingsPath, bridgeSettings.replace(/^engineering-profile:\s*[^\r\n]+/m, 'engineering-profile: deepseek-codex'))
  process.once('exit', () => {
    fs.rmSync(bridgeInstallRoot, { recursive: true, force: true })
    fs.rmSync(bridgeWorkspace, { recursive: true, force: true })
  })
  const scriptsRoot = path.join(bridgeInstallRoot, 'scripts')
  const payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-payload-'))
  const hostileDescription =
    'Verify only the ARTHUR Phase 2 remediation for findings F1, F2 and F3.\r\n' +
    'Repository: D:\\A.R.T.H.U.R \u2192 arrows \u2014 emdash \u00e0 accented 中文\r\n' +
    'Quotes: "double" and \'single\' and backslash: C:\\path\\to\\x\r\n' +
    'Control: ' + String.fromCharCode(0x1a, 0x01) + '\r\n' +
    'F2 - replay after forget\r\n- remember ' + String.fromCharCode(0x1a) + ' forget again'
  const payloadPath = path.join(payloadDir, 'task.json')
  fs.writeFileSync(payloadPath, JSON.stringify({ workspace: bridgeWorkspace, description: hostileDescription, reviewRequested: false }))
  const taskResult = await runCli(
    powershellHost,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', payloadPath],
    { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const task = controller.parseCliJson((taskResult.stdout || '').trim())
  assert.ok(task && task.taskId, 'Task.ps1 payload create-task returned a task')
  assert.equal(task.description, hostileDescription, 'Task.ps1 description round-trips byte-exact')
  fs.writeFileSync(payloadPath, JSON.stringify({ workspace: bridgeWorkspace, description: hostileDescription, reviewRequested: true }))
  const routeResult = await runCli(
    powershellHost,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Route.ps1'), '-TaskId', task.taskId, '-Preset', 'aih-engineering', '-PayloadFile', payloadPath],
    { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const decision = controller.parseCliJson((routeResult.stdout || '').trim())
  assert.ok(decision && decision.executionClass, 'Route.ps1 payload returned a decision')
  assert.equal(decision.executionClass, 'reviewer', 'explicit review metadata routes to reviewer')
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

  const diagnostic = controller.controllerCliFailure('Route.ps1', ['-TaskId', 'TASK-0001', '-Preset', 'aih-muse'], {
    code: 1,
    signal: null,
    stdout: '{"ok":false,"kind":"routing-rejected"}',
    stderr: 'MODEL_API_KEY=must-not-log\nroute failed',
  })
  assert.equal(diagnostic.script, 'Route.ps1')
  assert.equal(diagnostic.exitCode, 1)
  assert.deepEqual(diagnostic.args, ['-TaskId', 'TASK-0001', '-Preset', 'aih-muse'])
  assert.equal(diagnostic.structuredKind, 'routing-rejected')
  assert.equal(diagnostic.stderr.includes('must-not-log'), false)
  assert.equal(diagnostic.stderr.includes('route failed'), true)

  // 9. REAL Review.ps1 budget rejection (no Codex call): with the LEGACY
  //    hard budgets enabled in an explicit -PolicyPath (enforceLimits=true;
  //    the shipped default disables enforcement), an oversized bundle must
  //    produce exit 3 with parseable stdout carrying the violations.
  const oversizedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oversized-'))
  const oversizedEnforcedPolicyPath = path.join(oversizedDir, 'routing-policy.enforced.json')
  const oversizedPolicyDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'routing-policy.json'), 'utf8'))
  oversizedPolicyDoc.codex.automaticReview.enforceLimits = true
  fs.writeFileSync(oversizedEnforcedPolicyPath, JSON.stringify(oversizedPolicyDoc))
  const oversizedBundle = path.join(oversizedDir, 'bundle.json')
  const bigContent = 'x'.repeat(140000)
  fs.writeFileSync(oversizedBundle, JSON.stringify([{ path: 'huge.txt', score: 1, content: bigContent }]))
  const reviewPayload = path.join(oversizedDir, 'review.json')
  fs.writeFileSync(reviewPayload, JSON.stringify({ workspace: bridgeWorkspace, question: 'Review this function for correctness only.' }))
  let reviewError = null
  let reviewStdout = ''
  try {
    const reviewResult = await runCli(
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', task.taskId, '-FilesPath', oversizedBundle, '-Execute', '-PolicyPath', oversizedEnforcedPolicyPath, '-PayloadFile', reviewPayload],
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
      powershellHost,
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
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', inlineTask.taskId, '-FilesPath', inlineSlicesPath, '-PayloadFile', inlinePayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const inlinePacket = controller.parseCliJson((inlinePacketResult.stdout || '').trim())
    assert.equal(inlinePacket.contextMode, 'inline')
    assert.equal(inlinePacket.relevantFiles.length, 0, 'no repository files in an inline review')
    assert.equal(inlinePacket.diff, '')
    assert.equal(inlinePacket.enforcement.allowed, true, 'tiny inline review is Codex-eligible')
    assert.ok(inlinePacket.enforcement.estimatedContextTokens < 2000, 'inline packet is far below any provider concern')
    assert.equal(inlinePacket.budget.enforceLimits, false, 'review budget enforcement is disabled by default')
    assert.equal(inlinePacket.budget.maxContextTokens, null, 'no Nexus context-token ceiling is recorded (null = unlimited)')
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
      powershellHost,
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
      powershellHost,
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

  // 14. BROAD/OVERSIZED guard (enforceLimits=true): a files-mode review whose
  //     named file genuinely cannot fit the LEGACY budgets keeps the structured
  //     packet-too-large rejection and never calls Codex (codexCalls stays 0).
  //     TASK-0007: the shipped default (enforceLimits=false) allows this packet
  //     (scenario 14b); the old rejection behavior stays behind the policy flag.
  const hugeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-huge-review-'))
  const enforcedPolicyPath = path.join(hugeDir, 'routing-policy.enforced.json')
  const shippedPolicy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'routing-policy.json'), 'utf8'))
  shippedPolicy.codex.automaticReview.enforceLimits = true
  fs.writeFileSync(enforcedPolicyPath, JSON.stringify(shippedPolicy))
  try {
    fs.mkdirSync(path.join(hugeDir, 'src'))
    const hugePath = path.join(hugeDir, 'src', 'huge.js')
    fs.writeFileSync(hugePath, 'x'.repeat(140000))
    const hugeQuestion = 'Review src/huge.js for correctness'
    const hugeTaskPayload = path.join(hugeDir, 'task.json')
    fs.writeFileSync(hugeTaskPayload, JSON.stringify({ workspace: hugeDir, description: hugeQuestion, reviewRequested: true }))
    const hugeTaskResult = await runCli(
      powershellHost,
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
        powershellHost,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', hugeTask.taskId, '-FilesPath', hugeSlicesPath, '-Execute', '-PolicyPath', enforcedPolicyPath, '-PayloadFile', hugePayloadPath],
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

  // 14b. TASK-0007: with the SHIPPED default policy (enforceLimits=false) the
  //      same oversized packet is ALLOWED - Nexus no longer token-caps the
  //      review, and the packet records unlimited budgets (null), plus the
  //      measured size above the legacy ceiling.
  const unlimitedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unlimited-review-'))
  try {
    fs.mkdirSync(path.join(unlimitedDir, 'src'))
    fs.writeFileSync(path.join(unlimitedDir, 'src', 'huge.js'), 'x'.repeat(140000))
    const unlimitedQuestion = 'Review src/huge.js for correctness'
    const unlimitedTaskPayload = path.join(unlimitedDir, 'task.json')
    fs.writeFileSync(unlimitedTaskPayload, JSON.stringify({ workspace: unlimitedDir, description: unlimitedQuestion, reviewRequested: true }))
    const unlimitedTaskResult = await runCli(
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', unlimitedTaskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const unlimitedTask = controller.parseCliJson((unlimitedTaskResult.stdout || '').trim())
    const unlimitedSlices = controller.resolveReviewFiles(unlimitedDir, unlimitedQuestion, null)
    assert.equal(unlimitedSlices.length, 1)
    const unlimitedSlicesPath = path.join(unlimitedDir, 'slices.json')
    fs.writeFileSync(unlimitedSlicesPath, JSON.stringify(unlimitedSlices))
    const unlimitedPayloadPath = path.join(unlimitedDir, 'review.json')
    fs.writeFileSync(unlimitedPayloadPath, JSON.stringify({ workspace: unlimitedDir, question: unlimitedQuestion, contextMode: 'files' }))
    const unlimitedPacketResult = await runCli(
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', unlimitedTask.taskId, '-FilesPath', unlimitedSlicesPath, '-PayloadFile', unlimitedPayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const unlimitedPacket = controller.parseCliJson((unlimitedPacketResult.stdout || '').trim())
    assert.equal(unlimitedPacket.enforcement.allowed, true, 'oversized packet is allowed while budget enforcement is disabled')
    assert.equal(unlimitedPacket.enforcement.violations.length, 0, 'no budget violations under unlimited mode')
    assert.equal(unlimitedPacket.budget.enforceLimits, false, 'packet records enforceLimits=false')
    assert.equal(unlimitedPacket.budget.maxContextTokens, null, 'packet carries null context budget (0/null = unlimited)')
    assert.ok(unlimitedPacket.enforcement.estimatedContextTokens > 30000, 'measured context is reported above the legacy ceiling')
    assert.equal(unlimitedPacket.enforcement.readOnly, true, 'unlimited review stays read-only')
  } finally {
    fs.rmSync(unlimitedDir, { recursive: true, force: true })
  }

  // 15. QUOTA/CONSENT protection unchanged: a zero-file packet WITHOUT the
  //     inline context mode still trips the full-repository consent guard.
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-guard-review-'))
  try {
    const guardTaskPayload = path.join(guardDir, 'task.json')
    fs.writeFileSync(guardTaskPayload, JSON.stringify({ workspace: guardDir, description: 'Review the whole repository', reviewRequested: true }))
    const guardTaskResult = await runCli(
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Task.ps1'), '-Action', 'create-task', '-PayloadFile', guardTaskPayload],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const guardTask = controller.parseCliJson((guardTaskResult.stdout || '').trim())
    const guardSlicesPath = path.join(guardDir, 'slices.json')
    fs.writeFileSync(guardSlicesPath, '[]')
    const guardPayloadPath = path.join(guardDir, 'review.json')
    fs.writeFileSync(guardPayloadPath, JSON.stringify({ workspace: guardDir, question: 'Review the whole repository' })) // no contextMode: defaults to 'bundle'
    const guardPacketResult = await runCli(
      powershellHost,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, 'Review.ps1'), '-TaskId', guardTask.taskId, '-FilesPath', guardSlicesPath, '-PayloadFile', guardPayloadPath],
      { timeout: 320000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const guardPacket = controller.parseCliJson((guardPacketResult.stdout || '').trim())
    assert.equal(guardPacket.enforcement.allowed, false)
    assert.match(guardPacket.enforcement.violations.join(' '), /full repository context requires explicit user approval/, 'full-repo consent guard unchanged while budget enforcement is disabled')
    assert.equal(guardPacket.budget.enforceLimits, false, 'budget enforcement disabled by default')
    assert.equal(guardPacket.budget.maxContextTokens, null, 'no Nexus token ceiling recorded (null = unlimited)')
  } finally {
    fs.rmSync(guardDir, { recursive: true, force: true })
  }

  // 16. TASK-0007: the review budget policy reader is policy-driven and
  //     fails SAFE to the legacy enforced behavior when policy is missing.
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-budget-policy-off-'))
  const enabledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-budget-policy-on-'))
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-budget-policy-missing-'))
  try {
    for (const [dir, enforceLimits] of [[disabledDir, false], [enabledDir, true]]) {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'config', 'routing-policy.json'), JSON.stringify({
        version: 3,
        codex: { automaticReview: { enforceLimits, maxCallsPerTask: 1, maxFiles: 8, maxDiffLines: 2500, maxContextTokens: 30000, maxOutputTokens: 2500 } },
      }))
    }
    const disabled = controller.reviewBudgetPolicy(disabledDir)
    assert.equal(disabled.enforceLimits, false, 'enforceLimits=false is read from policy')
    assert.equal(disabled.maxFiles, 8, 'legacy file value stays readable')
    assert.equal(disabled.maxContextTokens, 30000, 'legacy token value stays readable')
    const enabled = controller.reviewBudgetPolicy(enabledDir)
    assert.equal(enabled.enforceLimits, true, 'enforceLimits=true is read from policy')
    const missing = controller.reviewBudgetPolicy(missingDir)
    assert.equal(missing.enforceLimits, true, 'missing routing-policy.json fails safe to the legacy behavior')
    assert.equal(missing.maxFiles, 8)
    assert.equal(missing.maxContextTokens, 30000)
    const defaultRoot = controller.reviewBudgetPolicy(undefined)
    assert.equal(defaultRoot.enforceLimits, false, 'an undefined install root resolves the shipped default install policy (enforcement disabled)')
    assert.equal(defaultRoot.source, 'policy')
  } finally {
    fs.rmSync(disabledDir, { recursive: true, force: true })
    fs.rmSync(enabledDir, { recursive: true, force: true })
    fs.rmSync(missingDir, { recursive: true, force: true })
  }

  // 17. TASK-0007: the review-result notice reports the enforcement STATE and
  //     never the obsolete budget numbers while enforcement is disabled.
  const unlimitedBudget = { enforceLimits: false, maxCallsPerTask: null, maxFiles: null, maxDiffLines: null, maxContextTokens: null, maxOutputTokens: null }
  const disabledText = controller.reviewResultText({ taskId: 'TASK-0007' }, { verdict: 'pass', findings: 0, severities: [], provider: 'sol-local', model: 'gpt-5.6-sol', callCount: 1, budget: unlimitedBudget }, null)
  assert.ok(disabledText.includes('Budget enforcement: disabled'), 'disabled enforcement is reported')
  assert.ok(disabledText.includes('Read-only: true'), 'read-only fact is reported')
  assert.ok(disabledText.includes('fresh context: true'), 'fresh context fact is reported')
  assert.ok(disabledText.includes('Independent Review (read-only)'), 'independent review terminology')
  assert.ok(!disabledText.includes('30000'), 'no obsolete 30000-token number')
  assert.ok(!disabledText.includes('8 files'), 'no obsolete 8-file number')
  const enforcedBudget = { enforceLimits: true, maxCallsPerTask: 1, maxFiles: 8, maxDiffLines: 2500, maxContextTokens: 30000, maxOutputTokens: 2500 }
  const enabledText = controller.reviewResultText({ taskId: 'TASK-0007' }, { verdict: 'pass', findings: 0, severities: [], provider: 'sol-local', model: 'gpt-5.6-sol', callCount: 1, budget: enforcedBudget }, null)
  assert.ok(enabledText.includes('Budget enforcement: enabled (8 files / 30000 context tokens / 1 call)'), 'enabled enforcement keeps the legacy numbers')

  // 18. TASK-0007: referenced-file resolution is unlimited (null) when the
  //     policy disables enforcement; an explicit cap still applies under it.
  const refsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-review-refs-'))
  try {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(refsDir, 'f' + i + '.ts'), 'export const a' + i + ' = 1\n')
    const question = 'Review ' + Array.from({ length: 10 }, (_, i) => 'f' + i + '.ts').join(', ') + ' for correctness'
    assert.equal(controller.referencedFilesOf(question, null).length, 10, 'unlimited referenced-file scan while enforcement is disabled')
    assert.equal(controller.referencedFilesOf(question).length, 8, 'legacy default caps at 8 when no policy is supplied')
    assert.equal(controller.resolveReviewFiles(refsDir, question, null).length, 10, 'unlimited file resolution')
    assert.equal(controller.resolveReviewFiles(refsDir, question, 8).length, 8, 'explicit cap still applies when provided')
    assert.equal(controller.classifyReviewContext(refsDir, question, null), 'files', 'classification threads the unlimited cap')
  } finally {
    fs.rmSync(refsDir, { recursive: true, force: true })
  }

  console.log('PASS: aih-controller bridge behavior')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
