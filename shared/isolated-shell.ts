export const ISOLATED_SHELL_CAPABILITY = 'isolated-shell-v1';
export const REMOTE_SHELL_TIMEOUT_MS = 30_000;
export const REMOTE_SHELL_MAX_COMMAND = 16_000;
export const REMOTE_SHELL_MAX_OUTPUT_BYTES = 256 * 1024;

export interface RemoteShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  resourceLimit?: 'memory' | 'disk-reserve' | 'pids';
}
