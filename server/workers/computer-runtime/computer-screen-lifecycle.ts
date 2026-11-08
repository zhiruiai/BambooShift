import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { ComputerScreenConfiguration } from '../../../shared/computer-screens.js';
import type {
  ScreenLifecycleOptions,
  ScreenLifecycleReceipt,
  ScreenLifecycleRequest,
} from '../../../shared/computer-screen-lifecycle.js';
import { isComputerOperationId } from '../../../shared/computer-operations.js';
import { parseDesktopSession, sameDesktopSession } from '../../../shared/linux-desktop.js';

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPTS = 10_000;
function trustedAncestors(path: string) {
  let current = dirname(path);
  while (current !== '/') {
    const info = lstatSync(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, process.getuid?.()].includes(info.uid) ||
      (info.mode & 0o022 && !(info.uid === 0 && info.mode & 0o1000))
    )
      throw lifecycleFault('画面维护路径不在可信目录中。');
    current = dirname(current);
  }
}
export const lifecycleFault = (message: string, code = 'SCREEN_LIFECYCLE_CONFLICT', status = 409) =>
  Object.assign(new Error(message), { code, status });

export function parseScreenLifecycleRequest(raw: unknown): ScreenLifecycleRequest {
  const value = raw as ScreenLifecycleRequest;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'expectedRevision,expectedSession,kind,operationId' ||
    !isComputerOperationId(value.operationId) ||
    !isComputerOperationId(value.expectedRevision) ||
    !['release', 'reset'].includes(value.kind) ||
    !parseDesktopSession(value.expectedSession) ||
    Object.keys(value.expectedSession).sort().join(',') !== 'generation,id'
  )
    throw lifecycleFault('画面维护请求无效。', 'SCREEN_LIFECYCLE_INVALID', 400);
  return {
    operationId: value.operationId,
    kind: value.kind,
    expectedRevision: value.expectedRevision,
    expectedSession: { ...value.expectedSession },
  };
}

interface StoredSlot {
  version: 1;
  workspaceScopeId: string;
  screenId: string;
  revision: string;
  session: ComputerScreenConfiguration['session'];
  currentOperationId?: string;
  receipts: Record<string, ScreenLifecycleReceipt>;
}

/** One atomic file is the transaction and all its replay receipts. No phase can
 * become visible without the intent needed to recover it after a crash. */
export class ScreenLifecycleStore {
  private slots = new Map<string, StoredSlot>();
  private failed = false;
  get available() {
    return !this.failed;
  }
  constructor(
    private readonly directory: string,
    private readonly scope: string,
    screens: ComputerScreenConfiguration[],
  ) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw lifecycleFault('画面维护目录无效。');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw lifecycleFault('画面维护目录必须为服务端私有目录。');
    this.directory = realpathSync(directory);
    trustedAncestors(this.directory);
    for (const screen of screens) {
      const path = this.path(screen.id);
      let state: StoredSlot;
      if (existsSync(path)) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(fd);
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            info.nlink !== 1 ||
            (info.mode & 0o777) !== 0o600 ||
            info.size > MAX_STATE_BYTES
          )
            throw new Error();
          state = JSON.parse(readFileSync(fd, 'utf8'));
          this.validate(state, screen.id);
        } catch {
          throw lifecycleFault('画面维护记录损坏，已停止使用此画面。');
        } finally {
          closeSync(fd);
        }
      } else {
        state = {
          version: 1,
          workspaceScopeId: scope,
          screenId: screen.id,
          revision: randomUUID(),
          session: { ...screen.session },
          receipts: {},
        };
        this.write(state);
      }
      this.slots.set(screen.id, state);
    }
    const currentSessions = [...this.slots.values()].map((slot) => slot.session.id);
    if (new Set(currentSessions).size !== currentSessions.length)
      throw lifecycleFault('画面维护记录重复绑定了同一会话。');
    for (const slot of this.slots.values()) {
      const pending = slot.currentOperationId && slot.receipts[slot.currentOperationId];
      if (
        pending &&
        [...this.slots.values()].some(
          (other) =>
            other.screenId !== slot.screenId && other.session.id === pending.next.session.id,
        )
      )
        throw lifecycleFault('画面维护记录与其他会话冲突。');
    }
  }
  private path(id: string) {
    return join(this.directory, id + '.json');
  }
  private validate(state: StoredSlot, id: string) {
    if (
      state?.version !== 1 ||
      state.workspaceScopeId !== this.scope ||
      state.screenId !== id ||
      !isComputerOperationId(state.revision) ||
      !parseDesktopSession(state.session) ||
      !state.receipts ||
      typeof state.receipts !== 'object' ||
      Array.isArray(state.receipts) ||
      Object.keys(state.receipts).length > MAX_RECEIPTS
    )
      throw new Error();
    for (const [key, receipt] of Object.entries(state.receipts)) {
      if (
        !isComputerOperationId(key) ||
        receipt.version !== 1 ||
        receipt.operationId !== key ||
        receipt.screenId !== id ||
        !['release', 'reset'].includes(receipt.kind) ||
        !['pending', 'complete', 'blocked'].includes(receipt.status) ||
        !['reserved', 'browser_closed', 'desktop_ready', 'complete'].includes(receipt.phase) ||
        (receipt.status === 'complete') !== (receipt.phase === 'complete') ||
        (receipt.status !== 'complete' && state.currentOperationId !== key) ||
        !isComputerOperationId(receipt.previous?.revision) ||
        !isComputerOperationId(receipt.next?.revision) ||
        !parseDesktopSession(receipt.previous?.session) ||
        !parseDesktopSession(receipt.next?.session) ||
        receipt.next.revision === receipt.previous.revision ||
        receipt.next.session.generation === receipt.previous.session.generation ||
        (receipt.kind === 'reset' && receipt.next.session.id !== receipt.previous.session.id) ||
        (receipt.kind === 'release' && receipt.next.session.id === receipt.previous.session.id)
      )
        throw new Error();
    }
    if (state.currentOperationId && !state.receipts[state.currentOperationId]) throw new Error();
    if (
      !state.currentOperationId &&
      Object.keys(state.receipts).length &&
      !Object.values(state.receipts).some(
        (receipt) =>
          receipt.status === 'complete' &&
          receipt.next.revision === state.revision &&
          sameDesktopSession(receipt.next.session, state.session),
      )
    )
      throw new Error();
    const active = state.currentOperationId && state.receipts[state.currentOperationId];
    if (
      active &&
      (active.status === 'complete' ||
        active.previous.revision !== state.revision ||
        !sameDesktopSession(active.previous.session, state.session))
    )
      throw new Error();
  }
  private write(state: StoredSlot) {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES)
      throw lifecycleFault('画面维护记录已满，请维护服务。');
    const temporary = this.path(state.screenId) + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path(state.screenId));
      const directory = openSync(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      this.failed = true;
      throw lifecycleFault('维护记录写入未确认，已停止使用画面池。');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
  snapshot(id: string) {
    if (this.failed) throw lifecycleFault('维护记录写入未确认，已停止使用画面池。');
    const state = this.slots.get(id);
    if (!state) throw lifecycleFault('画面不存在。', 'SCREEN_NOT_FOUND', 404);
    return structuredClone(state);
  }
  receipt(id: string, operationId: string) {
    const receipts = this.snapshot(id).receipts;
    return Object.hasOwn(receipts, operationId) ? receipts[operationId] : undefined;
  }
  prior(id: string, request: ScreenLifecycleRequest): ScreenLifecycleReceipt | undefined {
    const state = this.snapshot(id),
      prior = state.receipts[request.operationId];
    if (
      prior &&
      (prior.kind !== request.kind ||
        prior.previous.revision !== request.expectedRevision ||
        !sameDesktopSession(prior.previous.session, request.expectedSession))
    )
      throw lifecycleFault('此维护标识已用于其他请求。');
    return prior;
  }
  reserve(id: string, request: ScreenLifecycleRequest) {
    const prior = this.prior(id, request);
    if (prior) return prior;
    const state = this.snapshot(id);
    if (
      state.currentOperationId ||
      state.revision !== request.expectedRevision ||
      !sameDesktopSession(state.session, request.expectedSession)
    )
      throw lifecycleFault('画面已变化或正在维护，请刷新后重试。');
    if (Object.keys(state.receipts).length >= MAX_RECEIPTS)
      throw lifecycleFault('画面维护记录已满，请维护服务。');
    const receipt: ScreenLifecycleReceipt = {
      version: 1,
      operationId: request.operationId,
      screenId: id,
      kind: request.kind,
      status: 'pending',
      phase: 'reserved',
      previous: { revision: state.revision, session: { ...state.session } },
      next: {
        revision: randomUUID(),
        session: {
          id: request.kind === 'reset' ? state.session.id : randomUUID(),
          generation: randomUUID(),
        },
      },
    };
    state.currentOperationId = request.operationId;
    state.receipts[receipt.operationId] = receipt;
    this.write(state);
    this.slots.set(id, state);
    return structuredClone(receipt);
  }
  update(receipt: ScreenLifecycleReceipt) {
    const state = this.snapshot(receipt.screenId);
    if (state.currentOperationId !== receipt.operationId)
      throw lifecycleFault('画面维护事务已改变。');
    state.receipts[receipt.operationId] = structuredClone(receipt);
    if (receipt.status === 'complete') {
      state.revision = receipt.next.revision;
      state.session = { ...receipt.next.session };
      delete state.currentOperationId;
    }
    this.validate(state, receipt.screenId);
    this.write(state);
    this.slots.set(receipt.screenId, state);
  }
}

export type DesktopLifecycleDriver = (receipt: ScreenLifecycleReceipt) => Promise<void>;
export function createDesktopLifecycleDriver(
  options: ScreenLifecycleOptions,
): DesktopLifecycleDriver {
  for (const path of [options.interpreterPath, options.helperPath])
    if (!isAbsolute(path) || path.includes('\0')) throw lifecycleFault('桌面维护程序配置无效。');
  return async (receipt) => {
    trustedAncestors(realpathSync(options.helperPath));
    const info = lstatSync(options.helperPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw lifecycleFault('桌面维护程序不可用。');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.interpreterPath, [options.helperPath, '--lifecycle'], {
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let bytes = Buffer.alloc(0),
        failed = false;
      const timeout = setTimeout(() => {
        failed = true;
        child.kill('SIGTERM');
      }, 90_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (bytes.length + chunk.length > 65536) {
          failed = true;
          child.kill('SIGTERM');
        } else bytes = Buffer.concat([bytes, chunk]);
      });
      child.stderr.resume(); // Private diagnostics never enter an HTTP error.
      child.stdin.on('error', () => {
        failed = true;
      });
      child.once('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(bytes.toString());
          if (
            failed ||
            code !== 0 ||
            result.version !== 1 ||
            result.oldStopped !== true ||
            !sameDesktopSession(result.session, receipt.next.session)
          )
            throw new Error();
          resolve();
        } catch {
          reject(
            lifecycleFault('桌面维护尚未确认完成，请继续原维护请求。', 'SCREEN_LIFECYCLE_BLOCKED'),
          );
        }
      });
      child.stdin.end(
        JSON.stringify({
          version: 1,
          operationId: receipt.operationId,
          kind: receipt.kind,
          expectedSession: receipt.previous.session,
          nextSession: receipt.next.session,
        }),
      );
    });
  };
}
