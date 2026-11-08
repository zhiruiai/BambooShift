import type express from 'express';
import type { LocalComputer } from '../../computer-worker/index.js';
import type { IsolatedShellRunner } from '../isolated-shell.js';
import type { RemoteShellResult } from '../../../../shared/isolated-shell.js';
import type { ComputerOperationRegistry } from '../computer-operations.js';
export interface ShellJob {
  abort: AbortController;
  done: Promise<void>;
  finish: () => void;
  settled: boolean;
  provenStopped: boolean;
  result?: RemoteShellResult;
}
export interface WorkerState {
  closed: boolean;
  lifecycleLocked: boolean;
  queuedOperations: number;
  surfaceChanging: number;
  generation: number;
  takeoverPending: boolean;
  shellCleanupUnknown: boolean;
}
export interface WorkerRoutes {
  app: express.Express;
  options: { workspaceDir: string };
  computer: LocalComputer;
  shell: IsolatedShellRunner;
  runtime: WorkerState;
  operations: ComputerOperationRegistry;
  shellJobs: Map<string, ShellJob>;
  seenShellIds: Map<string, boolean>;
  reserveShell: (id: unknown) => ShellJob;
  cancelShells: () => Promise<void>;
  workerCapabilities: (values: string[]) => Promise<string[]>;
  assertConnection: (req: express.Request) => void;
  assertDesktopSession: (req: express.Request) => Promise<void>;
  enqueue: <T>(operation: () => Promise<T>, req: express.Request) => Promise<T>;
  transfer: <T>(
    req: express.Request,
    res: express.Response,
    operation: (signal: AbortSignal) => Promise<T>,
    tracked?: boolean,
  ) => Promise<T>;
}
