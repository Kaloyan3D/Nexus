// Platform capability declaration for the Nexus real-host suites.
//
// The local Task API transport (authenticated IPC) is implemented on POSIX
// only: on Windows `startIpcServer` refuses (named-pipe ACL not implemented;
// native qualification pending, roadmap R02), so no CLI-over-IPC path exists.
// The suites therefore:
//   - run every Task API operation through the CLI on POSIX, and through the
//     authenticated GUI task route (the SAME Controller operation) on Windows;
//   - on Windows, positively assert that the CLI refuses with HOST_UNAVAILABLE
//     (nothing is served without an ACL);
//   - print one explicit INFO line naming what is not covered on Windows.
// Nothing is skipped silently and Windows IPC support is never claimed.

export const IPC_SUPPORTED = process.platform !== 'win32'

export function declareWindowsIpcGap(suite, uncovered) {
  if (!IPC_SUPPORTED) console.log('INFO: win32 ' + suite + ': the local IPC transport is unsupported (named-pipe ACL not implemented); Task API operations ran through the GUI route; not covered on this platform: ' + uncovered)
}

/** One Task API operation via the CLI (POSIX) or the GUI task route (win32). */
export async function taskOp({ nexus, owner, cliArgs, operation, input }) {
  if (IPC_SUPPORTED) return { via: 'cli', ...(await nexus(cliArgs)) }
  const response = await owner.task(operation, input)
  const json = response && Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : response
  return { via: 'gui', code: null, json, stdout: JSON.stringify(json), stderr: '' }
}

/**
 * Success of one taskOp result on its own path: CLI exit 0 on POSIX, an ok
 * Task API envelope through the GUI route on Windows (which has no exit code).
 */
export function assertTaskOk(assert, result, label = 'task operation') {
  if (result.via === 'cli') assert.equal(result.code, 0, label + ' (cli): ' + result.stdout + result.stderr)
  else assert.equal(result.json && result.json.ok, true, label + ' (gui): ' + JSON.stringify(result.json))
  return result
}

/** Windows: the CLI has no transport and must say so with HOST_UNAVAILABLE (exit 3). */
export async function assertWindowsCliRefused(nexus, assert) {
  if (IPC_SUPPORTED) return
  const status = await nexus(['host', 'status', '--json'])
  assert.equal(status.code, 3, 'win32 CLI without IPC exits 3: ' + status.stdout + status.stderr)
  assert.equal(status.json && status.json.error && status.json.error.code, 'HOST_UNAVAILABLE')
}

/**
 * Standard unpatched DSH: managed submit and continue are refused fail-closed
 * through the available transport (CLI on POSIX, GUI route on Windows).
 */
export async function assertManagedRefused({ nexus, owner, assert, workspace, mode = 'engineering-v2', withContinue = true }) {
  const promptText = 'x'
  const digest = 'sha256:' + (await import('node:crypto')).createHash('sha256').update(promptText).digest('hex')
  const submit = await taskOp({ nexus, owner, cliArgs: ['submit', '--workspace', workspace, '--mode', mode, '--prompt', promptText, '--idempotency-key', 'prod', '--json'], operation: 'submit', input: { idempotencyKey: 'prod', workspace, mode, prompt: { kind: 'text', text: promptText, digest } } })
  if (submit.via === 'cli') assert.equal(submit.code, 4)
  assert.equal(submit.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE', JSON.stringify(submit.json))
  if (withContinue) {
    const taskId = 'nt_' + '0'.repeat(32)
    const cont = await taskOp({ nexus, owner, cliArgs: ['continue', taskId, '--prompt', promptText, '--revision', '1', '--json'], operation: 'continueTask', input: { taskId, idempotencyKey: 'prod-c', expectedRevision: '1', prompt: { kind: 'text', text: promptText, digest } } })
    if (cont.via === 'cli') assert.equal(cont.code, 4)
    assert.equal(cont.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE', JSON.stringify(cont.json))
  }
  await assertWindowsCliRefused(nexus, assert)
  return submit.via
}
