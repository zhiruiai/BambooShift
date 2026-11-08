import { Router, json, type Express, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  MAX_COMPUTER_SCREENS,
  SCREEN_ID_HEADER,
  SCREEN_POOL_PROTOCOL,
  WORKSPACE_SCOPE_HEADER,
  type ComputerScreenConfiguration,
  type ComputerScreenInventory,
  type ComputerScreenPoolConfiguration,
} from '../../../shared/computer-screens.js';
import { isComputerOperationId } from '../../../shared/computer-operations.js';
import { parseDesktopSession, sameDesktopSession } from '../../../shared/linux-desktop.js';
import type { ComputerState } from '../../../shared/types.js';
import {
  SCREEN_REVISION_HEADER,
  type ScreenLifecycleKind,
  type ScreenLifecycleOptions,
  type ScreenLifecycleReceipt,
} from '../../../shared/computer-screen-lifecycle.js';
import {
  ScreenLifecycleStore,
  createDesktopLifecycleDriver,
  lifecycleFault,
  parseScreenLifecycleRequest,
  type DesktopLifecycleDriver,
} from './computer-screen-lifecycle.js';

export function validateComputerScreenPoolConfiguration(
  raw: unknown,
): ComputerScreenPoolConfiguration {
  const value = raw as ComputerScreenPoolConfiguration;
  const invalid = () => {
    throw new Error('私有画面池配置无效。');
  };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'screens,version,workspaceScopeId' ||
    value.version !== 1 ||
    !isComputerOperationId(value.workspaceScopeId) ||
    !Array.isArray(value.screens) ||
    value.screens.length < 1 ||
    value.screens.length > MAX_COMPUTER_SCREENS
  )
    invalid();
  const ids = new Set<string>(),
    sessions = new Set<string>();
  const screens = value.screens.map((screen) => {
    if (
      !screen ||
      typeof screen !== 'object' ||
      Array.isArray(screen) ||
      Object.keys(screen).sort().join(',') !== 'id,manifestPath,session' ||
      !isComputerOperationId(screen.id)
    )
      invalid();
    const session = parseDesktopSession(screen.session);
    if (
      !session ||
      screen.manifestPath !== `/opt/openbot/desktop/sessions/${session.id}/manifest.json` ||
      ids.has(screen.id) ||
      sessions.has(session.id)
    )
      invalid();
    ids.add(screen.id);
    sessions.add(session!.id);
    return { id: screen.id, manifestPath: screen.manifestPath, session: session! };
  });
  return { version: 1, workspaceScopeId: value.workspaceScopeId, screens };
}

/** Deployment input only; root ownership and an opened no-follow descriptor are mandatory. */
export async function readComputerScreenPoolConfiguration(
  path: string,
): Promise<ComputerScreenPoolConfiguration> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('画面池配置路径无效。');
  // Root-private parents cannot be replaced by a GUI process while the file opens.
  let current = path.substring(0, path.lastIndexOf('/'));
  while (current && current !== '/') {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw new Error('画面池配置目录必须由 root 管理且不可被其他用户修改。');
    current = current.substring(0, current.lastIndexOf('/'));
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.gid !== 0 ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 64 * 1024
    )
      throw new Error('画面池配置必须为 root 所有的私有 0600 普通文件。');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error('画面池配置过大。');
    return validateComputerScreenPoolConfiguration(
      JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
    );
  } finally {
    await file.close();
  }
}

export interface ComputerScreenWorker {
  app: Express;
  health(): Promise<
    ComputerState & { instanceId: string; screenId?: string; workspaceScopeId?: string }
  >;
  close(): Promise<void>;
  freezeForLifecycle?(kind: ScreenLifecycleKind): {
    rollback(): void;
    closeBrowser(): Promise<void>;
  };
}
/** Routes only the fixed inventory. No HTTP request creates, starts or reassigns a desktop. */
export function createComputerScreenPool(options: {
  configuration: ComputerScreenPoolConfiguration;
  token: string;
  instanceId: string;
  controlOrigin: () => string | null;
  createScreen(screen: ComputerScreenConfiguration, revision?: string): ComputerScreenWorker;
  lifecycle?: ScreenLifecycleOptions;
  lifecycleDriver?: DesktopLifecycleDriver;
  recoverBrowser?(screenId: string, previousRevision: string): Promise<void>;
}) {
  const configuration = validateComputerScreenPoolConfiguration(options.configuration);
  const lifecycle =
    options.lifecycle &&
    new ScreenLifecycleStore(
      options.lifecycle.stateDir,
      configuration.workspaceScopeId,
      configuration.screens,
    );
  const driver =
    options.lifecycle &&
    (options.lifecycleDriver ?? createDesktopLifecycleDriver(options.lifecycle));
  const jobs = new Map<string, { id: string; work: Promise<ScreenLifecycleReceipt> }>();
  const failedSlots = new Set<string>();
  const children = new Map<
    string,
    {
      configuration: ComputerScreenConfiguration;
      worker?: ComputerScreenWorker;
      fence?: ReturnType<NonNullable<ComputerScreenWorker['freezeForLifecycle']>>;
      retiring?: Promise<void>;
    }
  >(
    configuration.screens.map((initial) => {
      const stored = lifecycle?.snapshot(initial.id);
      const screen = stored
        ? {
            id: initial.id,
            session: stored.session,
            manifestPath: `/opt/openbot/desktop/sessions/${stored.session.id}/manifest.json`,
          }
        : initial;
      return [
        screen.id,
        {
          configuration: screen,
          worker: stored?.currentOperationId
            ? undefined
            : options.createScreen(screen, stored?.revision),
        },
      ] as const;
    }),
  );
  const router = Router();
  let closed = false;
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin)
      return res.status(403).json({ error: 'Worker accepts server-to-server requests only.' });
    const actual = Buffer.from(req.get('Authorization')?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(options.token);
    if (
      !req.get('Authorization')?.startsWith('Bearer ') ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return res.status(401).json({ error: 'Invalid worker token.' });
    if (closed)
      return res.status(503).json({ error: '画面池已关闭。', code: 'SCREEN_POOL_CLOSED' });
    const scope = req.get(WORKSPACE_SCOPE_HEADER);
    if (scope !== undefined && scope !== configuration.workspaceScopeId)
      return res
        .status(409)
        .json({ error: '工作空间身份不匹配。', code: 'SCREEN_IDENTITY_INVALID' });
    // Inventory discovery may omit instance binding. Mutations are checked again by each child.
    if (
      req.get('X-OpenBot-Worker-Instance') !== undefined ||
      req.get('X-OpenBot-Control-Origin') !== undefined
    ) {
      if (
        req.get('X-OpenBot-Worker-Instance') !== options.instanceId ||
        req.get('X-OpenBot-Control-Origin') !== (options.controlOrigin() ?? 'none')
      )
        return res
          .status(409)
          .json({ error: 'Worker 身份已变化。', code: 'WORKER_CONNECTION_INVALID' });
    }
    next();
  });
  async function inventory(): Promise<ComputerScreenInventory> {
    const screens = await Promise.all(
      [...children.values()].map(async ({ configuration: screen, worker }) => {
        const stored = lifecycle?.snapshot(screen.id);
        const identity = stored
          ? {
              revision: stored.revision,
              lifecycle: {
                state: stored.currentOperationId
                  ? jobs.has(screen.id)
                    ? ('changing' as const)
                    : ('blocked' as const)
                  : failedSlots.has(screen.id)
                    ? ('blocked' as const)
                    : ('ready' as const),
                ...(stored.currentOperationId ? { operationId: stored.currentOperationId } : {}),
              },
            }
          : {};
        try {
          if (!worker || stored?.currentOperationId || failedSlots.has(screen.id))
            throw new Error();
          const state = await worker.health();
          if (
            state.instanceId !== options.instanceId ||
            state.screenId !== screen.id ||
            state.workspaceScopeId !== configuration.workspaceScopeId ||
            state.desktop?.kind !== 'virtual' ||
            state.desktop.available !== true ||
            state.desktop.authorized !== true ||
            !sameDesktopSession(state.desktop.session, screen.session)
          )
            throw new Error('已配置的虚拟桌面不可用或身份已变化。');
          return {
            id: screen.id,
            session: { ...screen.session },
            ...identity,
            available: true,
            state,
          };
        } catch {
          return {
            id: screen.id,
            session: { ...screen.session },
            ...identity,
            available: false,
            reason: '已配置的画面不可用，请维护此画面。',
          };
        }
      }),
    );
    return {
      protocol: SCREEN_POOL_PROTOCOL,
      instanceId: options.instanceId,
      workspaceScopeId: configuration.workspaceScopeId,
      capacity: {
        max: 2,
        configured: screens.length,
        ready: screens.filter((screen) => screen.available).length,
      },
      screens,
    };
  }
  router.get('/', async (req, res) => {
    if (req.get(SCREEN_ID_HEADER) !== undefined)
      return res
        .status(409)
        .json({ error: '画面目录不接受单画面身份。', code: 'SCREEN_IDENTITY_INVALID' });
    res.json(await inventory());
  });
  const lifecycleIdentity = (req: Request, revision?: string) => {
    if (!lifecycle || !driver)
      throw lifecycleFault('此电脑尚未启用画面维护。', 'SCREEN_LIFECYCLE_UNSUPPORTED');
    if (
      req.get('X-OpenBot-Worker-Instance') !== options.instanceId ||
      req.get('X-OpenBot-Control-Origin') !== (options.controlOrigin() ?? 'none') ||
      req.get(WORKSPACE_SCOPE_HEADER) !== configuration.workspaceScopeId ||
      req.get(SCREEN_ID_HEADER) !== req.params.screenId ||
      (revision !== undefined && req.get(SCREEN_REVISION_HEADER) !== revision)
    )
      throw lifecycleFault('画面维护身份不匹配。', 'SCREEN_IDENTITY_INVALID');
  };
  router.get('/:screenId/lifecycle/:operationId', (req, res) => {
    try {
      lifecycleIdentity(req);
      if (!isComputerOperationId(req.params.operationId))
        throw lifecycleFault('画面维护标识无效。', 'SCREEN_LIFECYCLE_INVALID', 400);
      const receipt = lifecycle!.receipt(
        String(req.params.screenId),
        String(req.params.operationId),
      );
      if (!receipt) throw lifecycleFault('未找到此维护记录。', 'SCREEN_LIFECYCLE_NOT_FOUND', 404);
      lifecycleIdentity(req, receipt.previous.revision);
      res.json(receipt);
    } catch (error: any) {
      res.status(error.status ?? 503).json({ error: error.message, code: error.code });
    }
  });
  router.post('/:screenId/lifecycle', json({ limit: '16kb' }), async (req, res) => {
    try {
      const request = parseScreenLifecycleRequest(req.body);
      lifecycleIdentity(req, request.expectedRevision);
      const id = String(req.params.screenId),
        child = children.get(id);
      if (!child) throw lifecycleFault('画面不存在。', 'SCREEN_NOT_FOUND', 404);
      if (failedSlots.has(id)) throw lifecycleFault('维护记录写入失败，请维护服务后继续。');
      const prior = lifecycle!.prior(id, request);
      if (prior?.status === 'complete') return res.json(prior);
      const running = jobs.get(id);
      if (running) {
        if (running.id !== request.operationId) throw lifecycleFault('此画面已有维护请求。');
        const result = await running.work;
        return res.status(result.status === 'complete' ? 200 : 409).json(result);
      }
      let freeze: ReturnType<NonNullable<ComputerScreenWorker['freezeForLifecycle']>> | undefined;
      if (!prior) {
        const state = lifecycle!.snapshot(id);
        if (
          state.currentOperationId ||
          state.revision !== request.expectedRevision ||
          !sameDesktopSession(state.session, request.expectedSession)
        )
          throw lifecycleFault('画面已变化，请刷新后重试。');
        if (!child.worker?.freezeForLifecycle) throw lifecycleFault('此画面不支持安全维护。');
        freeze = child.worker.freezeForLifecycle(request.kind);
      }
      let receipt: ScreenLifecycleReceipt;
      try {
        receipt = lifecycle!.reserve(id, request);
      } catch (error) {
        if (lifecycle!.available) freeze?.rollback();
        else failedSlots.add(id);
        throw error;
      }
      if (freeze) child.fence = freeze;
      const work = Promise.resolve().then(async () => {
        try {
          // No UI disconnect cancels this durable transaction. A retry uses the same intent.
          if (child.fence) await child.fence.closeBrowser();
          else {
            if (!options.recoverBrowser) throw new Error('Browser cleanup cannot be verified.');
            await options.recoverBrowser(id, receipt.previous.revision);
          }
          receipt = { ...receipt, status: 'pending', phase: 'browser_closed', error: undefined };
          lifecycle!.update(receipt);
          await driver!(receipt);
          child.retiring ??= child.worker?.close();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              child.retiring,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('Old helpers have not exited.')),
                  20_000,
                );
              }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
          child.worker = undefined;
          receipt = { ...receipt, phase: 'desktop_ready' };
          lifecycle!.update(receipt);
          const next = {
            id,
            session: { ...receipt.next.session },
            manifestPath: `/opt/openbot/desktop/sessions/${receipt.next.session.id}/manifest.json`,
          };
          const replacement = options.createScreen(next, receipt.next.revision);
          try {
            const health = await replacement.health();
            if (
              health.instanceId !== options.instanceId ||
              health.screenId !== id ||
              health.workspaceScopeId !== configuration.workspaceScopeId ||
              health.desktop?.kind !== 'virtual' ||
              !health.desktop.available ||
              !health.desktop.authorized ||
              !sameDesktopSession(health.desktop.session, next.session)
            )
              throw new Error();
          } catch (error) {
            await replacement.close();
            throw error;
          }
          const complete: ScreenLifecycleReceipt = {
            ...receipt,
            status: 'complete',
            phase: 'complete',
          };
          try {
            lifecycle!.update(complete);
          } catch (error) {
            await replacement.close();
            throw error;
          }
          child.configuration = next;
          child.worker = replacement;
          child.fence = undefined;
          child.retiring = undefined;
          return complete;
        } catch {
          receipt = {
            ...receipt,
            status: 'blocked',
            error: '画面维护尚未确认完成，请继续原维护请求。',
          };
          try {
            lifecycle!.update(receipt);
          } catch {
            failedSlots.add(id);
          }
          return receipt;
        } finally {
          jobs.delete(id);
        }
      });
      jobs.set(id, { id: request.operationId, work });
      const result = await work;
      res.status(result.status === 'complete' ? 200 : 409).json(result);
    } catch (error: any) {
      res.status(error.status ?? 503).json({ error: error.message, code: error.code });
    }
  });
  router.use('/:screenId', (req, res, next) => {
    const id = String(req.params.screenId);
    const child = children.get(id);
    if (!child)
      return res.status(404).json({ error: '画面不存在或尚未分配。', code: 'SCREEN_NOT_FOUND' });
    if (req.get(SCREEN_ID_HEADER) !== id)
      return res.status(409).json({ error: '画面身份不匹配。', code: 'SCREEN_IDENTITY_INVALID' });
    if (lifecycle) {
      const state = lifecycle.snapshot(id);
      if (
        req.get(SCREEN_REVISION_HEADER) !== state.revision ||
        state.currentOperationId ||
        failedSlots.has(id)
      )
        return res
          .status(409)
          .json({ error: '画面已变化或正在维护。', code: 'SCREEN_REVISION_INVALID' });
    }
    if (!child.worker)
      return res.status(409).json({ error: '此画面需要维护。', code: 'SCREEN_LIFECYCLE_BLOCKED' });
    return child.worker.app(req, res, next);
  });
  router.use((_req, res) =>
    res.status(404).json({ error: '画面路径不存在。', code: 'SCREEN_NOT_FOUND' }),
  );
  return {
    router,
    inventory,
    close: async () => {
      closed = true;
      await Promise.allSettled([...jobs.values()].map(({ work }) => work));
      await Promise.all([...children.values()].map(({ worker }) => worker?.close()));
    },
  };
}
