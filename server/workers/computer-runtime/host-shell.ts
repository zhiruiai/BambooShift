import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import {
  REMOTE_SHELL_MAX_OUTPUT_BYTES,
  REMOTE_SHELL_TIMEOUT_MS,
  type RemoteShellResult,
} from '../../../shared/isolated-shell.js';
import { validateShellInput, validateShellResult } from './isolated-shell.js';

/** A shell can exit before its background children. Only ESRCH proves its group is gone. */
async function stopProcessGroup(pid: number | undefined) {
  if (!pid) return true; // spawn failed before creating a process
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, name);
      return 'present';
    } catch (error: any) {
      return error.code === 'ESRCH' ? 'gone' : 'unknown';
    }
  };
  const started = performance.now();
  let forced = false;
  const initial = signal('SIGTERM');
  if (initial !== 'present') return initial === 'gone';
  while (performance.now() - started < 1500) {
    const state = signal(0);
    if (state !== 'present') return state === 'gone';
    if (!forced && performance.now() - started >= 500) {
      forced = true;
      const state = signal('SIGKILL');
      if (state !== 'present') return state === 'gone';
    }
    await pause(25);
  }
  return signal(0) === 'gone';
}

/** Personal desktop only. This is a same-user shell, not an isolation boundary. */
export class HostShellRunner {
  private closed = false;
  private active?: { abort: AbortController; done: Promise<RemoteShellResult> };
  constructor(
    private workspace: string,
    private enabled = false,
  ) {}

  async available() {
    return this.enabled && !this.closed && ['darwin', 'linux'].includes(process.platform);
  }

  async run(command: unknown, path: unknown = '.', signal?: AbortSignal) {
    // A preflight rejection cannot leave a process running. Preserve that fact
    // so a missing directory does not disable every subsequent computer action.
    const preflight = (message: string) =>
      Object.assign(Error(message), { cleanupConfirmed: true });
    let input: ReturnType<typeof validateShellInput>;
    try {
      input = validateShellInput(command, path);
    } catch {
      throw preflight('本机命令参数无效。');
    }
    if (signal?.aborted) throw preflight('本机命令已取消。');
    if (!(await this.available())) throw preflight('本机命令执行尚未启用。');
    if (this.active) throw preflight('本机命令正在执行，请稍后再试。');
    let cwd: string;
    try {
      await mkdir(this.workspace, { recursive: true, mode: 0o700 });
      cwd = await realpath(resolve(this.workspace, input.cwd));
      if (!(await stat(cwd)).isDirectory()) throw Error('Not a directory.');
    } catch {
      throw preflight('命令目录不可用。');
    }
    if (signal?.aborted || this.closed) throw preflight('本机命令已取消。');
    if (this.active) throw preflight('本机命令正在执行，请稍后再试。');
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const done = this.execute(input.command, cwd, combined);
    this.active = { abort, done };
    try {
      return await done;
    } finally {
      this.active = undefined;
    }
  }

  private execute(command: string, cwd: string, signal: AbortSignal): Promise<RemoteShellResult> {
    const started = performance.now();
    return new Promise((yes, no) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The managed service passes only ordinary local environment values.
        env: Object.fromEntries(
          ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].flatMap((key) =>
            process.env[key] === undefined ? [] : [[key, process.env[key]!]],
          ),
        ),
      });
      let size = 0,
        truncated = false,
        timedOut = false,
        cancelled = false;
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let settled = false,
        failed = false,
        outputClosed = false,
        groupStopped = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let cleanup: Promise<void> | undefined;
      let cutoff: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        clearTimeout(deadline);
        if (cutoff) clearTimeout(cutoff);
        signal.removeEventListener('abort', cancel);
      };
      const unknownCleanup = () => {
        if (settled) return;
        settled = true;
        this.closed = true;
        clear();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        no(
          Object.assign(Error('无法确认本机命令已停止，请检查电脑后重新连接。'), {
            cleanupConfirmed: false,
          }),
        );
      };
      const finish = () => {
        if (settled || !outputClosed || !groupStopped) return;
        settled = true;
        clear();
        if (failed)
          return no(Object.assign(Error('本机命令未能启动。'), { cleanupConfirmed: true }));
        // Decode only complete UTF-8 output within the shared byte budget.
        const decode = (parts: Buffer[]) =>
          new TextDecoder('utf-8', { fatal: false })
            .decode(Buffer.concat(parts))
            .replace(/\uFFFD/g, '');
        try {
          yes(
            validateShellResult({
              stdout: decode(stdout),
              stderr: decode(stderr),
              exitCode,
              ...(exitSignal ? { signal: exitSignal } : {}),
              truncated,
              timedOut,
              cancelled,
              durationMs: performance.now() - started,
            }),
          );
        } catch {
          no(Object.assign(Error('本机命令结果无效。'), { cleanupConfirmed: true }));
        }
      };
      const stop = () => {
        if (settled || cleanup) return;
        clearTimeout(deadline);
        // Bound both group termination and pipe closure. A detached process can
        // keep inherited pipes open; that is not evidence that it has stopped.
        cutoff = setTimeout(unknownCleanup, 2000);
        cleanup = stopProcessGroup(child.pid).then((confirmed) => {
          if (!confirmed) return unknownCleanup();
          groupStopped = true;
          finish();
        }, unknownCleanup);
      };
      const cancel = () => {
        cancelled = true;
        stop();
      };
      const deadline = setTimeout(() => {
        timedOut = true;
        stop();
      }, REMOTE_SHELL_TIMEOUT_MS);
      signal.addEventListener('abort', cancel, { once: true });
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        const available = REMOTE_SHELL_MAX_OUTPUT_BYTES - size;
        if (available > 0) {
          const part = chunk.subarray(0, available);
          target.push(part);
          size += part.length;
        }
        if (chunk.length > available) {
          truncated = true;
          stop();
        }
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => {
        failed = true;
      });
      // Do not wait for inherited stdout/stderr to close before stopping children.
      child.once('exit', stop);
      child.once('close', (code, name) => {
        exitCode = code;
        exitSignal = name;
        outputClosed = true;
        stop();
        finish();
      });
      if (signal.aborted || this.closed) cancel();
    });
  }

  async close() {
    this.closed = true;
    this.active?.abort.abort();
    await this.active?.done.catch(() => {});
  }
}
