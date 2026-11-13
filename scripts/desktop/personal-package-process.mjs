import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const kill = (group, signal) => {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

async function descendants(parent) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 2000 });
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, group] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid, group };
    });
  const selected = new Set([parent]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
  }
  return rows.filter((row) => selected.has(row.pid));
}

/** Bound the probe itself as well as its separately grouped managed backend. */
export async function runPersonalProbe(
  command,
  args,
  options,
  { timeoutMs = 180_000, graceMs = 10_000 } = {},
) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const groups = new Set(child.pid ? [child.pid] : []),
    registrations = [];
  let output = '',
    error = '',
    failure,
    forceTimer,
    terminating = false;
  const remember = async () => {
    if (!child.pid) return;
    for (const row of await descendants(child.pid))
      if (row.pid === row.group && row.pid !== child.pid) groups.add(row.group);
  };
  const force = async () => {
    await remember().catch(() => {});
    for (const group of groups) kill(group, 'SIGKILL');
    if (child.pid) kill(child.pid, 'SIGKILL');
  };
  const terminate = (reason) => {
    failure ??= reason;
    if (terminating) return;
    terminating = true;
    void remember()
      .finally(() => child.kill('SIGTERM'))
      .catch(() => {});
    forceTimer = setTimeout(() => {
      void force().catch(() => {});
    }, graceMs);
  };
  const interrupt = () => terminate('Personal package acceptance interrupted.');
  const deadline = setTimeout(
    () => terminate('Personal package acceptance exceeded its deadline.'),
    timeoutMs,
  );
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  child.stdout.on('data', (part) => {
    if (output.length + part.length > 64 * 1024)
      terminate('The acceptance report exceeded its limit.');
    else output += part;
  });
  child.stderr.on('data', (part) => {
    error = (error + part).slice(-1024);
  });
  child.on('message', (message) => {
    if (
      message?.type !== 'managed-group' ||
      !Number.isSafeInteger(message.pid) ||
      message.pid <= 1
    ) {
      terminate('Invalid acceptance process registration.');
      return;
    }
    registrations.push(
      (async () => {
        const rows = await descendants(child.pid);
        if (
          !rows.some(
            (row) => row.pid === message.pid && row.ppid === child.pid && row.group === row.pid,
          )
        )
          throw Error('Invalid acceptance process registration.');
        groups.add(message.pid);
        child.send({ type: 'managed-group-confirmed', pid: message.pid }, () => {});
      })().catch(() => terminate('Invalid acceptance process registration.')),
    );
  });
  try {
    const code = await new Promise((resolve) => {
      child.once('error', () => {
        failure = 'The packaged Node runtime could not start.';
      });
      child.once('close', resolve);
    });
    await Promise.all(registrations);
    if (failure) throw Error(failure);
    if (code !== 0)
      throw Error(
        /^Personal package acceptance failed at [a-z-]+\.$/.test(error.trim())
          ? error.trim()
          : 'The packaged acceptance process failed.',
      );
    try {
      return JSON.parse(output);
    } catch {
      throw Error('Invalid acceptance report.');
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(forceTimer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    try {
      for (const group of groups) if (alive(-group)) kill(group, 'SIGKILL');
      const end = Date.now() + 3000;
      while ([...groups].some((group) => alive(-group)) && Date.now() < end) await pause(25);
      if ([...groups].some((group) => alive(-group))) throw Error('Still running.');
    } catch {
      const failure = Error('Synthetic runtime cleanup could not be confirmed.');
      failure.code = 'ACCEPTANCE_CLEANUP_UNKNOWN';
      throw failure;
    }
  }
}
