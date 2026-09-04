'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const controller = require('../config/AihController.cjs')

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

// TASK-0017 transport: sandboxed Windows environments deny anonymous-pipe and
// fd-redirected stdio capture from Node children (spawn EPERM) while
// stdio:'ignore' spawns are allowed, so Windows runs each CLI through cmd.exe
// with cmd-side redirection into temporary files (no pipes anywhere). POSIX
// keeps the direct pipe transport. Both shapes return captured stdout.
let runSeq = 0
function run(file, args, cwd) {
  if (process.platform !== 'win32') {
    const direct = spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true })
    if (direct.status !== 0) throw new Error((direct.stderr || direct.stdout || file + ' failed').trim())
    return direct.stdout
  }
  const seq = ++runSeq
  const token = process.pid + '-' + seq
  const outPath = path.join(os.tmpdir(), 'aih-vcl-out-' + token + '.txt')
  const errPath = path.join(os.tmpdir(), 'aih-vcl-err-' + token + '.txt')
  const batchPath = path.join(os.tmpdir(), 'aih-vcl-' + token + '.cmd')
  const q = (value) => '"' + String(value).replace(/%/g, '%%') + '"'
  const command = [q(file)].concat(args.map(q)).join(' ') + ' > ' + q(outPath) + ' 2> ' + q(errPath)
  fs.writeFileSync(batchPath, '@echo off\r\n' + command + '\r\n', 'utf8')
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', batchPath], { cwd, stdio: 'ignore', windowsHide: true })
  const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (_) { return '' } }
  const stdout = read(outPath)
  const stderr = read(errPath)
  try { fs.rmSync(outPath, { force: true }) } catch (_) { }
  try { fs.rmSync(errPath, { force: true }) } catch (_) { }
  try { fs.rmSync(batchPath, { force: true }) } catch (_) { }
  if (result.status !== 0) throw new Error((stderr || stdout || file + ' failed').trim())
  return stdout
}

async function main() {
  const sourceRoot = path.join(__dirname, '..')
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-visual-controller-install-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-visual-controller-workspace-'))
  const dataHome = path.join(installRoot, 'data')
  let providerCalls = 0
  const dimensions = {
    hierarchy: 8, spacing: 8, density: 8, typography: 8, alignment: 8,
    colorDiscipline: 8, interactionClarity: 8, brandFidelity: 8, platformQuality: 8,
  }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      providerCalls += 1
      const review = providerCalls === 1
        ? {
            verdict: 'REVISE', score: 7, dimensions,
            findings: [{ id: 'F1', severity: 'high', category: 'spacing', area: 'history card', observation: 'Rows are too dense.', whyItMatters: 'The timeline is hard to scan.', recommendation: 'Increase row separation.', confidence: 'high' }],
            previousReview: [], strengths: ['Clear hierarchy'], summary: 'One material spacing repair is required.',
          }
        : {
            verdict: 'PASS', score: 8.5, dimensions, findings: [],
            previousReview: [{ id: 'F1', status: 'resolved', note: 'Row separation is now clear.' }],
            strengths: ['Clear hierarchy', 'Readable rhythm'], summary: 'The repaired timeline is visually coherent.',
          }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'deepseek-v4-flash-vision-exp', choices: [{ message: { content: JSON.stringify(review) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.AIH_VISUAL_CONTROLLER_TEST_KEY
  const previousInstallRoot = process.env.AIH_INSTALL_ROOT
  try {
    fs.cpSync(path.join(sourceRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true })
    fs.cpSync(path.join(sourceRoot, 'config'), path.join(installRoot, 'config'), { recursive: true })
    fs.mkdirSync(dataHome, { recursive: true })
    fs.writeFileSync(path.join(dataHome, 'settings.yaml'), [
      'engineering-profile: deepseek-codex',
      'llm-pi-ai:',
      '  providers:',
      '    deepseek-vision-direct:',
      '      apiKeyEnv: AIH_VISUAL_CONTROLLER_TEST_KEY',
      `      baseURL: http://127.0.0.1:${port}`,
      '      api: openai-completions',
      '      reasoning: high',
      '',
    ].join('\n'))
    process.env.DSH_HOME = dataHome
    // Hermetic fixture: ambient AIH_INSTALL_ROOT (set by a real install) must
    // not leak into spawned CLIs or they resolve the REAL install root and
    // write runtime state outside this fixture.
    process.env.AIH_INSTALL_ROOT = installRoot
    process.env.AIH_VISUAL_CONTROLLER_TEST_KEY = 'test-key-not-real'

    run('git', ['init'], workspace)
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }))
    fs.mkdirSync(path.join(workspace, 'apps', 'mobile', 'src', 'app'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'apps', 'mobile', 'src', 'app', 'index.tsx'), 'export default function Screen(){ return null }\n')
    run('git', ['add', 'package.json', 'apps/mobile/src/app/index.tsx'], workspace)

    // The capture source is a checked-in fixture: generating PNGs through
    // System.Drawing is Windows-only, and this suite must also run on the
    // native Linux runtime where pwsh has no GDI+.
    const shot = path.join(workspace, 'history.png')
    const fixturePng = path.join(sourceRoot, 'tests', 'fixtures', 'visual-lifecycle', 'history.png')
    assert.ok(fs.existsSync(fixturePng), 'visual lifecycle PNG fixture is checked in')
    fs.copyFileSync(fixturePng, shot)
    fs.mkdirSync(path.join(workspace, '.ai-harness'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.ai-harness', 'visual-policy.json'), JSON.stringify({ schemaVersion: 1, requirement: 'auto', requirePatterns: ['apps/mobile/src/app/'] }))
    fs.writeFileSync(path.join(workspace, '.ai-harness', 'visual-scenarios.json'), JSON.stringify({ id: 'history', platform: 'android', captures: [{ name: 'history', mode: 'file', sourceFile: shot }] }))

    const handlers = {}
    controller.apply({ on(event, handler) { handlers[event] = handler }, shellEnv: { register() {} } })
    assert.equal(typeof handlers['agent/pre-step'], 'function')
    assert.equal(typeof handlers['session/event'], 'function')
    const session = {
      id: 'visual-controller-session',
      header: { cwd: workspace, agentPreset: 'aih-engineering' },
      messages: [],
      append(kind, message) { this.messages.push({ kind, message }) },
    }
    const agent = { session }
    const turn = (text, turnId) => handlers['agent/pre-step']({ agent, messages: [userMessage(text)], step: 1, turn: turnId }, () => 'next')
    const endTurn = () => handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })

    await turn('Implement the History timeline UI.', '1')
    fs.writeFileSync(path.join(workspace, 'apps', 'mobile', 'src', 'app', 'index.tsx'), 'export default function Screen(){ return <HistoryTimeline spacing={4} /> }\n')
    await endTurn()

    const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
    const task = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).tasks[0]
    const visualRoot = path.join(workspace, '.ai-harness', 'runs', task.taskId, 'visual')
    if (!fs.existsSync(path.join(visualRoot, 'state.json'))) {
      const logPath = path.join(dataHome, 'logs', 'aih-controller.log')
      throw new Error('automatic visual state missing\nmessages=' + JSON.stringify(session.messages) + '\nlog=' + (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '<missing>'))
    }
    const firstState = JSON.parse(fs.readFileSync(path.join(visualRoot, 'state.json'), 'utf8'))
    assert.equal(firstState.status, 'revise', 'normal engineering completion automatically reaches VisualLoop; messages=' + JSON.stringify(session.messages))
    assert.equal(firstState.iteration, 1)
    assert.equal(providerCalls, 1, 'one logical review makes one successful provider attempt')
    assert.ok(session.messages.some((entry) => entry.message.source.form === 'controller-visual-repair'), 'REVISE returns a controller repair packet to the active engineer session')
    assert.ok(!JSON.stringify(session.messages).match(/invoke .*visual-review.*skill|visual-reviewer skill|nexus-visual-review/i), 'the engineer is never instructed to discover a visual-review skill')

    await turn('Apply the controller visual repair packet.', '2')
    fs.writeFileSync(path.join(workspace, 'apps', 'mobile', 'src', 'app', 'index.tsx'), 'export default function Screen(){ return <HistoryTimeline spacing={12} /> }\n')
    await endTurn()

    const secondState = JSON.parse(fs.readFileSync(path.join(visualRoot, 'state.json'), 'utf8'))
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    assert.equal(secondState.status, 'pass')
    assert.equal(secondState.iteration, 2, 'repair requires a fresh deterministic verification before visual iteration 2')
    assert.equal(secondState.lastVerificationAttempt, 2)
    assert.equal(providerCalls, 2, 'each logical review used one provider attempt')
    assert.equal(ledger.tasks[0].status, 'complete')
    assert.ok(session.messages.some((entry) => JSON.stringify(entry.message).includes('VISUAL_REVIEW_PASS · HUMAN_REVIEW_PENDING')))
    assert.ok(fs.existsSync(path.join(visualRoot, 'iteration-01', 'packet.json')), 'automatic path uses the existing VisualReview service artifacts')
    assert.ok(fs.existsSync(path.join(visualRoot, 'iteration-02', 'result.json')))
    console.log('PASS: automatic visual controller lifecycle (REVISE -> repair -> reverify -> PASS)')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.AIH_VISUAL_CONTROLLER_TEST_KEY
    else process.env.AIH_VISUAL_CONTROLLER_TEST_KEY = previousKey
    if (previousInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT
    else process.env.AIH_INSTALL_ROOT = previousInstallRoot
    if (process.env.AIH_KEEP_VISUAL_CONTROLLER_FIXTURE !== '1') {
      fs.rmSync(installRoot, { recursive: true, force: true })
      fs.rmSync(workspace, { recursive: true, force: true })
    } else {
      console.error('FIXTURE KEPT: ' + installRoot + ' | ' + workspace)
    }
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error))
  process.exit(1)
})
