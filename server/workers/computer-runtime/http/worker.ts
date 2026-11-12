import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { type BrowserScreenSession } from '../browser-engine.js';
import { ComputerOperationRegistry, operationCleanupUnknown } from '../computer-operations.js';
import {
  COMPUTER_WORKER_PROTOCOL,
  LocalComputer,
  workerControlOrigin,
} from '../../computer-worker/index.js';
import type { DesktopAdapter } from '../desktop.js';
import { IsolatedShellRunner, type IsolatedShellConfiguration } from '../isolated-shell.js';
import { HostShellRunner } from '../host-shell.js';
import {
  createLinuxDesktopAdapter,
  linuxDesktopMaintenanceState,
  type LinuxDesktopAdapterOptions,
} from '../linux-desktop.js';
import {
  COMPUTER_OPERATION_ID_HEADER,
  OPERATION_CLEANUP_CAPABILITY,
  isComputerOperationId,
} from '../../../../shared/computer-operations.js';
import {
  SCREEN_LIFECYCLE_CAPABILITY,
  type ScreenLifecycleKind,
} from '../../../../shared/computer-screen-lifecycle.js';
import {
  HOST_DESKTOP_CAPABILITY,
  SCREEN_ID_HEADER,
  SCREEN_POOL_CAPABILITY,
  SHARED_SCREEN_CAPABILITY,
  WORKSPACE_SCOPE_HEADER,
} from '../../../../shared/computer-screens.js';
import { ISOLATED_SHELL_CAPABILITY, LOCAL_SHELL_CAPABILITY } from '../../../../shared/isolated-shell.js';
import {
  VIRTUAL_DESKTOP_CAPABILITY,
  parseDesktopSession,
  sameDesktopSession,
} from '../../../../shared/linux-desktop.js';

import { PRIVATE_TAKEOVER_FRAMES_CAPABILITY, registerControlsRoutes } from './controls.js';
import { registerExecutionRoutes } from './execution.js';
import { registerFilesRoutes } from './files.js';
import type { ShellJob, WorkerRoutes, WorkerState } from './types.js';
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createComputerWorker(options: {
  token: string;
  workspaceDir: string;
  desktopAdapter?: DesktopAdapter;
  browserSession?: BrowserScreenSession;
  /** Trusted pool construction only; never populated from an HTTP payload. */
  instanceId?: string;
  screenId?: string;
  screenRevision?: string;
  workspaceScopeId?: string;
  screenOnly?: boolean;
  screenPool?: boolean;
  hostDesktop?: boolean;
  hostShell?: boolean;
  screenLifecycle?: boolean;
  isolatedShell?: IsolatedShellConfiguration;
  linuxDesktop?: Pick<
    LinuxDesktopAdapterOptions,
    'interpreterPath' | 'helperPath' | 'manifestPath' | 'expectedSessionId' | 'expectedGeneration'
  >;
}) {
  if (options.token.length < 24)
    throw new Error('OPENBOT_WORKER_TOKEN must be at least 24 characters.');
  const sharedScreen = !!options.workspaceScopeId && !options.screenPool && !options.screenId;
  if (options.hostDesktop && (!sharedScreen || !options.desktopAdapter))
    throw new Error('A host desktop requires a workspace-scoped standalone worker.');
  if (options.hostShell && !sharedScreen)
    throw new Error('A host shell requires a workspace-scoped standalone worker.');
  const desktopAdapter =
    options.desktopAdapter ??
    (options.linuxDesktop ? createLinuxDesktopAdapter(options.linuxDesktop) : undefined);
  const computer = new LocalComputer(resolve(options.workspaceDir), undefined, {
    desktopAdapter,
    browserSession: options.browserSession,
  });
  const shell = new IsolatedShellRunner(resolve(options.workspaceDir), options.isolatedShell);
  const hostShell = new HostShellRunner(resolve(options.workspaceDir), options.hostShell);
  const app = express();
  const instanceId = options.instanceId ?? randomUUID();
  const operations = new ComputerOperationRegistry();
  let declaredOrigin = workerControlOrigin(process.env.OPENBOT_PUBLIC_ORIGIN);
  let queue = Promise.resolve();
  const runtime: WorkerState = {
    closed: false,
    lifecycleLocked: false,
    queuedOperations: 0,
    surfaceChanging: 0,
    generation: 0,
    takeoverPending: false,
    shellCleanupUnknown: false,
  };
  const transfers = new Set<AbortController>();
  const shellJobs = new Map<string, ShellJob>();
  // Keep replay protection for the entire Worker incarnation, even after large
  // result objects are evicted. Exhaustion fails closed until an explicit restart.
  const seenShellIds = new Map<string, boolean>();
  const reserveShell = (id: unknown): ShellJob => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))
      throw new Error('缺少远程命令操作标识。');
    if (seenShellIds.has(id)) throw new Error('此远程命令已经处理或取消，请重新提出操作。');
    if (seenShellIds.size >= 10_000) throw new Error('远程命令记录已满，请维护并重启远程电脑。');
    if (shellJobs.size >= 500) {
      const previous = [...shellJobs].find(([, job]) => job.settled);
      if (previous) shellJobs.delete(previous[0]);
    }
    if (shellJobs.size >= 500) throw new Error('等待处理的远程命令过多。');
    let finish!: () => void;
    const job = {
      abort: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
      settled: false,
      provenStopped: true,
    };
    shellJobs.set(id, job);
    seenShellIds.set(id, false);
    return job;
  };
  const cancelShells = async () => {
    for (const job of shellJobs.values()) if (!job.settled) job.abort.abort();
    await Promise.all([...shellJobs.values()].map((job) => job.done));
  };
  const workerCapabilities = async (values: string[]) => [
    ...values,
    'action-frames',
    PRIVATE_TAKEOVER_FRAMES_CAPABILITY,
    ...(operations.available ? [OPERATION_CLEANUP_CAPABILITY] : []),
    ...(options.screenPool ? [SCREEN_POOL_CAPABILITY] : []),
    ...(sharedScreen ? [SHARED_SCREEN_CAPABILITY] : []),
    ...(options.hostDesktop ? [HOST_DESKTOP_CAPABILITY] : []),
    ...(!runtime.shellCleanupUnknown && (await hostShell.available()) ? [LOCAL_SHELL_CAPABILITY] : []),
    ...(options.screenLifecycle ? [SCREEN_LIFECYCLE_CAPABILITY] : []),
    ...(!runtime.shellCleanupUnknown && (await shell.available())
      ? [ISOLATED_SHELL_CAPABILITY]
      : []),
    ...(computer.status().desktop?.kind === 'virtual' &&
    computer.status().desktop?.available &&
    computer.status().desktop?.authorized &&
    parseDesktopSession(computer.status().desktop?.session)
      ? [VIRTUAL_DESKTOP_CAPABILITY]
      : []),
  ];
  const currentControlOrigin = () => {
    const current = workerControlOrigin(process.env.OPENBOT_PUBLIC_ORIGIN);
    if (current !== declaredOrigin) {
      declaredOrigin = current;
      runtime.generation++;
      computer.cancelTakeover();
      void computer.cancelBrowserDownload('控制台隔离声明已变化，网页导出已取消。');
      for (const transfer of transfers) transfer.abort();
      void cancelShells();
    }
    return current;
  };
  const assertConnection = (req: express.Request) => {
    const expectedOrigin = req.get('X-OpenBot-Control-Origin');
    const expectedInstance = req.get('X-OpenBot-Worker-Instance');
    if (expectedInstance !== instanceId || expectedOrigin !== (currentControlOrigin() ?? 'none')) {
      throw Object.assign(new Error('Worker 已重启或控制台隔离声明不匹配，请重新连接。'), {
        code: 'WORKER_CONNECTION_INVALID',
      });
    }
  };
  const assertDesktopSession = async (req: express.Request) => {
    const state = computer.status();
    const entering = req.path === '/surface' && req.body?.surface === 'desktop';
    const action =
      ['/execute', '/execute-with-frame'].includes(req.path) &&
      typeof req.body?.type === 'string' &&
      req.body.type.startsWith('desktop_');
    const observing =
      state.surface === 'desktop' &&
      ['/screenshot', '/takeover/start', '/takeover/input'].includes(req.path);
    const scoped =
      options.screenId &&
      req.path !== '/takeover/end' &&
      !(req.path === '/surface' && req.body?.surface === 'browser');
    if (!(entering || action || observing || scoped)) return;
    const current = (await computer.refreshStatus()).desktop;
    if (current?.kind !== 'virtual') return;
    const expected = parseDesktopSession({
      id: req.get('X-OpenBot-Desktop-Session'),
      generation: req.get('X-OpenBot-Desktop-Generation'),
    });
    if (
      !expected ||
      current?.kind !== 'virtual' ||
      !current.available ||
      !current.authorized ||
      !sameDesktopSession(expected, current.session)
    )
      throw Object.assign(new Error('远程桌面会话已变化或未确认，请重新连接。'), {
        code: 'DESKTOP_SESSION_INVALID',
      });
  };
  const enqueue = <T>(operation: () => Promise<T>, req: express.Request): Promise<T> => {
    runtime.queuedOperations++;
    const version = runtime.generation;
    const result = queue.then(async () => {
      // Configuration can change while an operation waits behind another one.
      assertConnection(req);
      await assertDesktopSession(req);
      assertConnection(req);
      if (version !== runtime.generation) throw new Error('电脑界面已切换，排队操作已失效。');
      if (runtime.closed || runtime.lifecycleLocked) throw new Error('Computer worker is closing.');
      operations.assertAvailable();
      if (runtime.shellCleanupUnknown)
        throw new Error('无法确认远程命令已停止，请维护并重新连接电脑。');
      return operation();
    });
    const tracked = result.finally(() => {
      runtime.queuedOperations--;
    });
    queue = tracked.then(
      () => {},
      () => {},
    );
    return tracked;
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Only the trusted OpenBot server calls this worker. Browser origins are rejected.
    if (req.headers.origin)
      return res.status(403).json({ error: 'Worker accepts server-to-server requests only.' });
    if (!isAuthorized(req.headers.authorization, options.token))
      return res.status(401).json({ error: 'Invalid worker token.' });
    try {
      const screen = req.get(SCREEN_ID_HEADER);
      const scope = req.get(WORKSPACE_SCOPE_HEADER);
      if (
        (options.screenId && screen !== options.screenId) ||
        (!options.screenId && screen !== undefined) ||
        (scope !== undefined && scope !== options.workspaceScopeId) ||
        (sharedScreen && req.path !== '/health' && scope !== options.workspaceScopeId)
      )
        throw Object.assign(new Error('电脑画面或工作空间身份不匹配。'), {
          code: 'SCREEN_IDENTITY_INVALID',
        });
      const operationId = req.get(COMPUTER_OPERATION_ID_HEADER);
      if (operationId !== undefined && !isComputerOperationId(operationId))
        return res.status(400).json({ error: '电脑操作标识无效。', code: 'INVALID_OPERATION_ID' });
      // Initial discovery is the only request without an established instance binding.
      if (
        req.path !== '/health' ||
        req.get('X-OpenBot-Worker-Instance') ||
        req.get('X-OpenBot-Control-Origin')
      )
        assertConnection(req);
    } catch (error: any) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) =>
    runtime.lifecycleLocked
      ? res.status(409).json({ error: '此画面正在维护。', code: 'SCREEN_LIFECYCLE_BUSY' })
      : next(),
  );
  app.use((req, res, next) => {
    if (!options.screenOnly) return next();
    if (
      [
        '/health',
        '/screenshot',
        '/surface',
        '/takeover/status',
        '/takeover/start',
        '/takeover/input',
        '/takeover/end',
        '/operations/cancel',
      ].includes(req.path)
    )
      return next();
    if (
      ['/execute', '/execute-with-frame'].includes(req.path) &&
      typeof req.body?.type === 'string' &&
      /^(browser_|desktop_)/.test(req.body.type)
    )
      return next();
    return res.status(404).json({
      error: '此路径属于共享电脑服务，不能通过画面路径访问。',
      code: 'SCREEN_ROUTE_INVALID',
    });
  });
  const health = async () => {
    operations.assertAvailable();
    if (runtime.shellCleanupUnknown)
      throw Object.assign(new Error('无法确认远程命令已停止，请维护远程电脑。'), {
        code: 'WORKER_CONNECTION_INVALID',
      });
    const state = await computer.refreshStatus();
    return {
      ...state,
      ...(options.hostDesktop && state.desktop
        ? { desktop: { ...state.desktop, kind: 'host' as const } }
        : {}),
      capabilities: await workerCapabilities(state.capabilities),
      mode: 'remote' as const,
      protocol: COMPUTER_WORKER_PROTOCOL,
      instanceId,
      controlOrigin: currentControlOrigin(),
      ...(options.screenId ? { screenId: options.screenId } : {}),
      ...(options.screenRevision ? { screenRevision: options.screenRevision } : {}),
      ...(options.workspaceScopeId ? { workspaceScopeId: options.workspaceScopeId } : {}),
    };
  };
  app.get('/health', async (_req, res) => {
    try {
      res.json(await health());
    } catch (error: any) {
      res.status(503).json({ error: error.message, code: error.code });
    }
  });
  const transfer = async <T>(
    req: express.Request,
    res: express.Response,
    operation: (signal: AbortSignal) => Promise<T>,
    tracked = true,
  ): Promise<T> => {
    const id = req.get(COMPUTER_OPERATION_ID_HEADER);
    const record = tracked && id !== undefined ? operations.reserve(id) : undefined;
    const controller = record?.abort ?? new AbortController();
    const abort = () => controller.abort();
    const disconnected = () => {
      if (!res.writableEnded) abort();
    };
    transfers.add(controller);
    req.once('aborted', abort);
    res.once('close', disconnected);
    if (req.aborted || res.destroyed) abort();
    let failure: unknown;
    try {
      return await enqueue(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }, req);
    } catch (error) {
      failure = error;
      if (operationCleanupUnknown(error)) operations.poison();
      throw error;
    } finally {
      if (record) operations.settle(record, failure);
      transfers.delete(controller);
      req.off('aborted', abort);
      res.off('close', disconnected);
    }
  };
  app.post('/operations/cancel', async (req, res) => {
    try {
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Object.keys(req.body).length !== 1 ||
        !('id' in req.body)
      )
        return res.status(400).json({ error: '取消请求无效。', code: 'INVALID_OPERATION_ID' });
      res.json(await operations.cancel(req.body.id));
    } catch (error: any) {
      res.status(error.status ?? 409).json({ error: error.message, code: error.code });
    }
  });
  const routes: WorkerRoutes = {
    app,
    options,
    computer,
    shell,
    hostShell,
    runtime,
    operations,
    shellJobs,
    seenShellIds,
    reserveShell,
    cancelShells,
    workerCapabilities,
    assertConnection,
    assertDesktopSession,
    enqueue,
    transfer,
  };
  registerFilesRoutes(routes);
  registerControlsRoutes(routes);
  registerExecutionRoutes(routes);
  app.use((_req, res) => res.status(404).json({ error: 'Unknown worker route.' }));
  app.use(
    (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 400).json({
        error: error.type === 'entity.too.large' ? '文件不能超过 10 MiB。' : error.message,
      });
    },
  );
  return {
    app,
    health,
    freezeForLifecycle(kind: ScreenLifecycleKind) {
      const unknown = linuxDesktopMaintenanceState(desktopAdapter)?.cleanupUnknown === true;
      const recoveringCancelled =
        kind === 'reset' &&
        unknown &&
        [...transfers].every((transfer) => transfer.signal.aborted) &&
        runtime.queuedOperations <= transfers.size;
      if (
        runtime.closed ||
        runtime.lifecycleLocked ||
        ((runtime.queuedOperations || transfers.size) && !recoveringCancelled) ||
        runtime.surfaceChanging ||
        runtime.takeoverPending ||
        computer.takeoverStatus().active
      )
        throw Object.assign(new Error('请先结束此画面的操作和人工接管。'), {
          status: 409,
          code: 'SCREEN_LIFECYCLE_BUSY',
        });
      if (kind === 'release' && (!operations.available || unknown))
        throw Object.assign(new Error('无法确认旧操作状态，请明确重置此画面。'), {
          status: 409,
          code: 'SCREEN_LIFECYCLE_BLOCKED',
        });
      runtime.lifecycleLocked = true;
      return {
        rollback: () => {
          if (!runtime.closed) runtime.lifecycleLocked = false;
        },
        closeBrowser: async () => {
          await options.browserSession?.close();
        },
      };
    },
    close: async () => {
      runtime.closed = true;
      runtime.generation++;
      for (const transfer of transfers) transfer.abort();
      await cancelShells();
      await shell.close();
      await hostShell.close();
      await computer.close();
      await queue;
      await operations.close();
    },
  };
}
