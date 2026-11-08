import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function backendLaunch(
  explicit?: string[],
  env?: NodeJS.ProcessEnv,
): { executable: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } };
export function launchBackend(
  explicit?: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    stdio?: SpawnOptions['stdio'];
    launch?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  },
): ChildProcess;
