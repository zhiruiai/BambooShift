import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import {
  ISOLATED_SHELL_CAPABILITY,
  REMOTE_SHELL_MAX_COMMAND,
  REMOTE_SHELL_MAX_OUTPUT_BYTES,
  REMOTE_SHELL_TIMEOUT_MS,
  type RemoteShellResult,
} from '../../../shared/isolated-shell.js';

export interface IsolatedShellConfiguration {
  interpreterPath: string;
  supervisorPath: string;
}
const unavailable = () => new Error('远程命令隔离环境不可用，请检查远程电脑配置。');

export function validateShellInput(command: unknown, path: unknown = '.') {
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > REMOTE_SHELL_MAX_COMMAND ||
    command.includes('\0')
  )
    throw new Error('请输入不超过 16000 字符的命令，不能包含空字符。');
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').includes('..')
  )
    throw new Error('命令目录必须是工作区内的相对路径。');
  return { command, cwd: path };
}

export function validateShellResult(value: unknown): RemoteShellResult {
  const r = value as Partial<RemoteShellResult> | null;
  if (
    !r ||
    typeof r.stdout !== 'string' ||
    typeof r.stderr !== 'string' ||
    Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) > REMOTE_SHELL_MAX_OUTPUT_BYTES ||
    !(
      r.exitCode === null ||
      (Number.isInteger(r.exitCode) && r.exitCode! >= 0 && r.exitCode! <= 255)
    ) ||
    (r.signal !== undefined &&
      (typeof r.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(r.signal))) ||
    typeof r.truncated !== 'boolean' ||
    typeof r.timedOut !== 'boolean' ||
    typeof r.cancelled !== 'boolean' ||
    (r.resourceLimit !== undefined &&
      !['memory', 'disk-reserve', 'pids'].includes(r.resourceLimit)) ||
    typeof r.durationMs !== 'number' ||
    !Number.isFinite(r.durationMs) ||
    r.durationMs < 0
  )
    throw unavailable();
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode!,
    ...(r.signal ? { signal: r.signal } : {}),
    truncated: r.truncated,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
    durationMs: r.durationMs,
    ...(r.resourceLimit ? { resourceLimit: r.resourceLimit } : {}),
  };
}

/** Runs only a configured isolation supervisor, never a host shell. */
export class IsolatedShellRunner {
  private checked?: Promise<boolean>;
  private blocked = false;
  private closed = false;
  private busy = false;
  private processes = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  constructor(
    private readonly workspace: string,
    private readonly configuration?: IsolatedShellConfiguration,
  ) {}

  async available(): Promise<boolean> {
    if (this.closed || this.blocked || !this.configuration) return false;
    this.checked ??= this.probe();
    return (await this.checked) && !this.closed && !this.blocked;
  }

  private async probe() {
    try {
      const value = await this.invoke('--probe', undefined, undefined, 15_000);
      if (
        value.version !== 1 ||
        value.available !== true ||
        value.capability !== ISOLATED_SHELL_CAPABILITY ||
        value.workspace !== resolve(this.workspace)
      )
        throw unavailable();
      return true;
    } catch {
      this.blocked = true;
      return false;
    }
  }

  async run(
    command: unknown,
    path: unknown = '.',
    signal?: AbortSignal,
  ): Promise<RemoteShellResult> {
    const input = validateShellInput(command, path);
    signal?.throwIfAborted();
    if (this.busy) throw new Error('远程命令仍在执行或清理，请稍后再试。');
    this.busy = true;
    let dispatched = false;
    try {
      if (!(await this.available())) throw unavailable();
      signal?.throwIfAborted();
      dispatched = true;
      const value = await this.invoke(
        '--run',
        { version: 1, ...input, timeoutMs: REMOTE_SHELL_TIMEOUT_MS },
        signal,
        REMOTE_SHELL_TIMEOUT_MS + 5_000,
      );
      if (value.version !== 1) throw unavailable();
      return validateShellResult(value);
    } catch (error) {
      // An external cancellation with a valid supervisor result returns above.
      // An unacknowledged exit cannot establish that every descendant was stopped.
      if (dispatched || !signal?.aborted) this.blocked = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private invoke(
    mode: '--probe' | '--run',
    request?: unknown,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<any> {
    const config = this.configuration;
    if (!config || !isAbsolute(config.interpreterPath) || !isAbsolute(config.supervisorPath))
      return Promise.reject(unavailable());
    const abort = new AbortController();
    const operation = new Promise<any>((resolveResult, reject) => {
      const child = spawn(config.interpreterPath, [config.supervisorPath, mode], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      let bytes = 0;
      let malformed = false;
      const chunks: Buffer[] = [];
      const terminate = () => {
        // The supervisor owns descendant cleanup. Killing it first can orphan work.
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', terminate, { once: true });
      abort.signal.addEventListener('abort', terminate, { once: true });
      const timer = setTimeout(terminate, timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          malformed = true;
          terminate();
        } else chunks.push(chunk);
      });
      // Supervisor diagnostics never enter the model, action JSON, or public error.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => {
        malformed = true;
      });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', terminate);
        abort.signal.removeEventListener('abort', terminate);
        try {
          if (malformed || code !== 0 || exitSignal) throw unavailable();
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value?.error) throw unavailable();
          resolveResult(value);
        } catch {
          this.blocked = true;
          reject(unavailable());
        }
      });
      child.stdin.end(request === undefined ? undefined : JSON.stringify(request));
      if (signal?.aborted || abort.signal.aborted || this.closed) terminate();
    });
    const entry = { abort, done: operation };
    this.processes.add(entry);
    void operation.finally(() => this.processes.delete(entry)).catch(() => {});
    return operation;
  }

  async close() {
    this.closed = true;
    for (const process of this.processes) process.abort.abort();
    await Promise.allSettled([...this.processes].map((process) => process.done));
  }
}
