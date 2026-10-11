// Portable "run detached" and "stop" for the host-side processes (no setsid, works on Linux and macOS).
//   node proc.mjs start <pidfile> <logfile> -- <cmd> [args...]
//   node proc.mjs stop  <pidfile> <expected-substring>
// start: spawns the command in its own process group (detached), writes the pid, and returns.
// stop:  signals the whole group, but only when the pid still belongs to the expected command
//        (so a recycled pid is never killed).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const [mode, pidFile, third, ...rest] = process.argv.slice(2);

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

if (mode === 'start') {
  const logFile = third;
  const sep = rest.indexOf('--');
  const cmd = rest.slice(sep + 1);
  if (sep !== 0 || cmd.length === 0) {
    console.error('usage: proc.mjs start <pidfile> <logfile> -- <cmd> [args...]');
    process.exit(2);
  }
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.on('error', (error) => {
    console.error(`could not start ${cmd[0]}: ${error.message}`);
    process.exit(1);
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  // give a bad command a moment to fail loudly instead of leaving a stale pid file
  setTimeout(() => process.exit(0), 300);
} else if (mode === 'stop') {
  const expected = third || '';
  if (!fs.existsSync(pidFile)) process.exit(0);
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  if (!Number.isInteger(pid) || pid <= 1) process.exit(0);
  const command = commandOf(pid);
  if (!command) process.exit(0); // already gone
  if (expected && !command.includes(expected)) {
    console.error(`pid ${pid} is not ${expected} any more; leaving it alone`);
    process.exit(0);
  }
  const signal = (name) => {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, name);
        return;
      } catch {
        /* try the single pid next */
      }
    }
  };
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  signal('SIGTERM');
  // Wait up to 5 seconds for the whole group to exit so the port is free when this returns; then force it.
  for (let i = 0; i < 50 && alive(); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (alive()) signal('SIGKILL');
} else {
  console.error('usage: proc.mjs start|stop ...');
  process.exit(2);
}
