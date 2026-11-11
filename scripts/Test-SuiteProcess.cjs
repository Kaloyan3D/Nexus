'use strict';

// Own one suite process and its pipes. The result marker is separate from
// child exit codes, so an actual test exit of 124 is still an ordinary failure.
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const [seconds, executable, ...args] = process.argv.slice(2);
const deadline = Number(seconds) * 1000;
const windows = process.platform === 'win32';
const prefix = 'NEXUS HARNESS PROCESS INCOMPLETE: ';
let timer;
let done = false;
const flushers = [];
const child = spawn(executable, args, { detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

for (const stream of [child.stdout, child.stderr]) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  stream.on('data', chunk => {
    const lines = (remainder + decoder.write(chunk)).split(/\r?\n/);
    remainder = lines.pop();
    for (const line of lines) console.log(line);
  });
  flushers.push(() => {
    const final = remainder + decoder.end();
    if (final) console.log(final);
  });
}
function finish(code, problem) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  for (const flush of flushers) flush();
  if (problem) console.log(prefix + problem);
  process.exitCode = code;
}
function stop(reason) {
  if (done) return;
  if (child.pid) {
    if (windows) {
      if (child.exitCode === null && child.signalCode === null) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        child.kill();
      }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') console.error(error.message);
      }
    }
  }
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  finish(124, reason);
}
child.once('error', error => finish(1, error.message));
child.once('close', (code, signal) => finish(code ?? 1, signal ? 'terminated by ' + signal : null));
timer = setTimeout(() => stop('deadline exceeded after ' + seconds + ' seconds'), deadline);
process.on('SIGINT', () => stop('supervisor interrupted'));
process.on('SIGTERM', () => stop('supervisor terminated'));
