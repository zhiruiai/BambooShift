import { randomBytes } from 'node:crypto';

const snapshotLifetime = 120_000;
// Rust allows ten minutes to approve, followed by dispatch and connection checks.
const approvalLifetime = 11 * 60_000;
const elementListBytes = 96 * 1024;
const approvalAppBundleId = 'com.openbot.client';
const tokenPattern = /^[a-f0-9]{64}$/;
const invalidElementCharacter = /[^A-Za-z0-9_-]/;
const invalidBundleCharacter = /[^A-Za-z0-9.-]/;
const invalidInputCharacter = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uD800-\uDFFF]/u;
const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 500 && !value.includes('\0');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && tokenPattern.test(value);
const validElementId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 64 &&
  !invalidElementCharacter.test(value);
const validLaunchBundleId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 300 &&
  !invalidBundleCharacter.test(value) &&
  !value.startsWith('.') &&
  !value.endsWith('.') &&
  value.includes('.') &&
  !value.includes('..') &&
  !value.toLowerCase().startsWith('com.openbot.');

type ElementAction = 'press' | 'setText';
type ElementRef = { snapshotToken: string; elementId: string };

export type AccessibilityAction =
  | { type: 'desktop_ax_inspect'; app?: string }
  | ({ type: 'desktop_ax_target'; action?: ElementAction } & ElementRef)
  | ({ type: 'desktop_ax_press' } & ElementRef)
  | ({ type: 'desktop_ax_set_text'; text: string } & ElementRef)
  | { type: 'desktop_ax_open_target'; bundleId: string }
  | { type: 'desktop_ax_open'; bundleId: string; identity: string };
export type AccessibilityTarget = {
  app: string;
  role: string;
  label: string;
  windowTitle?: string;
};

export function isAccessibilityAction(type: string): type is AccessibilityAction['type'] {
  return (
    type === 'desktop_ax_inspect' ||
    type === 'desktop_ax_target' ||
    type === 'desktop_ax_press' ||
    type === 'desktop_ax_set_text' ||
    type === 'desktop_ax_open_target' ||
    type === 'desktop_ax_open'
  );
}

const nativeErrors = new Map([
  ['DISABLED', '应用操作尚未由用户启用。'],
  ['INVALID_REQUEST', '辅助功能操作请求无效。'],
  ['PERMISSION_REQUIRED', '请在 macOS 系统设置中授予辅助功能权限。'],
  ['AX_STALE_SNAPSHOT', '应用窗口或控件已变化，请重新查看应用后操作。'],
  ['AX_WINDOW_UNAVAILABLE', '应用窗口已不可用，请重新打开并查看应用。'],
  ['AX_UNAVAILABLE', '暂时无法读取应用控件，请重新查看应用。'],
  ['AX_ACTION_UNAVAILABLE', '所选控件不支持此操作。'],
  ['AX_PRESS_UNCONFIRMED', '应用未确认点按结果，请重新查看应用。'],
  ['AX_TEXT_UNCONFIRMED', '应用未确认文字已填写，请重新查看应用。'],
  ['AX_APP_UNAVAILABLE', '找不到唯一的目标应用，请检查应用标识符。'],
  ['AX_APP_PROTECTED', 'Mac 应用操作不能启动 BambooShift 或其助手。'],
  ['AX_STALE_APP', '目标应用身份已变化，请重新发起启动申请。'],
  ['AX_OPEN_UNCONFIRMED', '应用启动未确认，请检查应用状态。'],
]);

/** Only publish allow-listed codes and our own diagnostic text. */
export function nativeAccessibilityError(op: unknown, failure: unknown): Error | undefined {
  if (typeof op !== 'string' || !op.startsWith('ax_')) return;
  if (record(failure) && typeof failure.code === 'string') {
    const message = nativeErrors.get(failure.code);
    if (message) return Object.assign(new Error(message), { code: failure.code });
  }
  return new Error('Mac 应用操作失败。');
}

export function validateAccessibilityAction(input: unknown): AccessibilityAction {
  if (!record(input) || typeof input.type !== 'string' || !isAccessibilityAction(input.type))
    throw new Error('辅助功能操作无效。');
  if (input.type === 'desktop_ax_inspect') {
    if (
      Object.keys(input).some((key) => key !== 'type' && key !== 'app') ||
      (input.app !== undefined && (!boundedText(input.app) || !input.app.trim()))
    )
      throw new Error('请输入要读取的运行中应用名称。');
    return { type: input.type, ...(input.app ? { app: input.app } : {}) };
  }
  if (input.type === 'desktop_ax_open_target' || input.type === 'desktop_ax_open') {
    const { type, bundleId, identity } = input;
    const allowed =
      type === 'desktop_ax_open_target' ? ['type', 'bundleId'] : ['type', 'bundleId', 'identity'];
    if (!validLaunchBundleId(bundleId) || Object.keys(input).some((key) => !allowed.includes(key)))
      throw new Error('请选择支持的本机应用标识符。');
    if (type === 'desktop_ax_open_target') return { type, bundleId };
    if (!validToken(identity)) throw new Error('本机应用身份无效。');
    return { type, bundleId, identity };
  }
  const { type, snapshotToken, elementId } = input;
  const allowed = ['type', 'snapshotToken', 'elementId'];
  if (type === 'desktop_ax_set_text') allowed.push('text');
  if (type === 'desktop_ax_target') allowed.push('action');
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !validToken(snapshotToken) ||
    !validElementId(elementId)
  )
    throw new Error('请选用本次应用控件列表中的有效控件。');
  const ref = { snapshotToken, elementId };
  if (type === 'desktop_ax_set_text') {
    const { text } = input;
    if (
      typeof text !== 'string' ||
      !text.length ||
      text.length > 4000 ||
      invalidInputCharacter.test(text) ||
      [...text].length > 2000
    )
      throw new Error('请提供 1–2000 个字符的文字，可包含换行和制表符。');
    return { type, ...ref, text };
  }
  if (type === 'desktop_ax_target') {
    const { action } = input;
    if (action !== undefined && action !== 'press' && action !== 'setText')
      throw new Error('辅助功能控件操作无效。');
    return { type, ...ref, ...(action ? { action } : {}) };
  }
  return { type, ...ref };
}

interface Element {
  id: string;
  depth: number;
  role: string;
  label: string;
  enabled: boolean;
  actions: ElementAction[];
}
interface Tree {
  app: { pid: number; bundleId: string; name: string };
  windowTitle: string;
  snapshotToken: string;
  elements: Element[];
  truncated: boolean;
}

function parseTree(value: unknown): { tree: Tree; elementTokens: Map<string, string> } {
  const invalid = () => new Error('辅助功能助手返回的控件列表无效。');
  if (!record(value)) throw invalid();
  const { app, windowTitle, snapshotToken, elements, truncated } = value;
  if (
    !record(app) ||
    typeof app.pid !== 'number' ||
    !Number.isSafeInteger(app.pid) ||
    app.pid <= 0 ||
    !boundedText(app.bundleId) ||
    !boundedText(app.name) ||
    !app.name ||
    !boundedText(windowTitle) ||
    !validToken(snapshotToken) ||
    !Array.isArray(elements) ||
    elements.length > 200 ||
    typeof truncated !== 'boolean'
  )
    throw invalid();
  const ids = new Set<string>();
  const elementTokens = new Map<string, string>();
  const tokenized = elements.some(
    (element) => record(element) && Object.hasOwn(element, 'elementToken'),
  );
  const verified = elements.map((element: unknown): Element => {
    if (!record(element)) throw invalid();
    const { id, depth, role, label, enabled, actions } = element;
    if (
      !validElementId(id) ||
      ids.has(id) ||
      typeof depth !== 'number' ||
      !Number.isSafeInteger(depth) ||
      depth < 0 ||
      depth > 24 ||
      !boundedText(role) ||
      !role ||
      !boundedText(label) ||
      typeof enabled !== 'boolean' ||
      !Array.isArray(actions) ||
      actions.length > 2 ||
      actions.some((action) => action !== 'press' && action !== 'setText') ||
      new Set(actions).size !== actions.length
    )
      throw invalid();
    if (tokenized) {
      const actionable = enabled && actions.length > 0;
      if (actionable !== Object.hasOwn(element, 'elementToken')) throw invalid();
      if (actionable) {
        if (!validToken(element.elementToken)) throw invalid();
        elementTokens.set(id, element.elementToken);
      }
    }
    ids.add(id);
    return { id, depth, role, label, enabled, actions };
  });
  let size = 0;
  const firstExcess = verified.findIndex((element) => {
    size += Buffer.byteLength(JSON.stringify(element)) + 1;
    return size > elementListBytes;
  });
  return {
    tree: {
      app: { pid: app.pid, bundleId: app.bundleId, name: app.name },
      windowTitle,
      snapshotToken,
      elements: firstExcess === -1 ? verified : verified.slice(0, firstExcess),
      truncated: truncated || firstExcess !== -1,
    },
    elementTokens,
  };
}

function parseLaunchTarget(value: unknown, requested: string) {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !record(value.app) ||
    Object.keys(value.app).length !== 2 ||
    !validLaunchBundleId(value.app.bundleId) ||
    value.app.bundleId.toLowerCase() !== requested.toLowerCase() ||
    typeof value.app.name !== 'string' ||
    !value.app.name.trim() ||
    Buffer.byteLength(value.app.name) > 512 ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(value.app.name) ||
    !validToken(value.identity)
  ) {
    throw new Error('辅助功能助手返回的本机应用身份无效。');
  }
  return { app: value.app.name, bundleId: value.app.bundleId, identity: value.identity };
}

/** Match each approval to the exact observed app instance and a single intent. */
export function createDesktopAccessibility(
  request: (payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  requireEnabled: () => void,
  launchAvailable: () => boolean = () => false,
) {
  let generation = 0;
  let snapshot:
    | {
        tree: Tree;
        elementTokens: Map<string, string>;
        publicToken: string;
        expiresAt: number;
        approvals: Map<string, number>;
      }
    | undefined;

  function clear() {
    snapshot = undefined;
    generation++;
  }
  function current(token: string, id: string, action: ElementAction, resolvingTarget: boolean) {
    requireEnabled();
    const intent = `${action}:${id}`;
    const now = Date.now();
    const approvedUntil = resolvingTarget ? 0 : (snapshot?.approvals.get(intent) ?? 0);
    if (
      !snapshot ||
      snapshot.publicToken !== token ||
      now >= Math.max(snapshot.expiresAt, approvedUntil)
    )
      throw Object.assign(new Error('应用控件列表已过期，请重新读取应用。'), {
        code: 'AX_STALE_SNAPSHOT',
      });
    const element = snapshot.tree.elements.find((candidate) => candidate.id === id);
    if (!element?.enabled || !element.actions.includes(action))
      throw new Error(action === 'setText' ? '当前控件无法填写文字。' : '当前控件不可点击。');
    if (resolvingTarget) snapshot.approvals.set(intent, now + approvalLifetime);
    return { tree: snapshot.tree, element, elementToken: snapshot.elementTokens.get(id) };
  }

  return {
    clear,
    async execute(action: AccessibilityAction, signal?: AbortSignal) {
      requireEnabled();
      signal?.throwIfAborted();
      if (action.type === 'desktop_ax_open_target' || action.type === 'desktop_ax_open') {
        if (!launchAvailable()) throw new Error('当前辅助功能助手不支持启动应用，请更新后重试。');
        if (action.type === 'desktop_ax_open_target') {
          const started = generation;
          const result = await request(
            { op: 'ax_open_target', app: action.bundleId, enabled: true },
            signal,
          );
          signal?.throwIfAborted();
          requireEnabled();
          if (started !== generation) throw new Error('原生应用连接已变更，请重试。');
          return parseLaunchTarget(result, action.bundleId);
        }
        clear();
        const result = await request(
          { op: 'ax_open', app: action.bundleId, appIdentity: action.identity, enabled: true },
          signal,
        );
        if (!record(result) || result.ok !== true)
          throw new Error('辅助功能助手未确认应用已打开。');
        return { ok: true };
      }
      if (action.type === 'desktop_ax_inspect') {
        clear();
        const started = generation;
        const raw = await request(
          { op: 'ax_inspect', enabled: true, ...(action.app ? { app: action.app } : {}) },
          signal,
        );
        signal?.throwIfAborted();
        requireEnabled();
        if (started !== generation) throw new Error('原生应用连接已变更，请重试。');
        const { tree, elementTokens } = parseTree(raw);
        if (tree.app.bundleId.toLowerCase() === approvalAppBundleId)
          throw new Error('Mac 应用操作不能访问 BambooShift 自身的审批界面。');
        const publicToken = randomBytes(32).toString('hex');
        snapshot = {
          tree,
          elementTokens,
          publicToken,
          expiresAt: Date.now() + snapshotLifetime,
          approvals: new Map(),
        };
        return { ...tree, snapshotToken: publicToken };
      }
      const capability =
        action.type === 'desktop_ax_target'
          ? (action.action ?? 'press')
          : action.type === 'desktop_ax_set_text'
            ? 'setText'
            : 'press';
      const { tree, element, elementToken } = current(
        action.snapshotToken,
        action.elementId,
        capability,
        action.type === 'desktop_ax_target',
      );
      if (action.type === 'desktop_ax_target') {
        return {
          app: tree.app.name,
          role: element.role,
          label: element.label,
          ...(tree.windowTitle ? { windowTitle: tree.windowTitle } : {}),
        };
      }
      clear();
      const result = await request(
        {
          ...(action.type === 'desktop_ax_set_text'
            ? { op: 'ax_set_text', text: action.text }
            : { op: 'ax_press' }),
          enabled: true,
          appPid: tree.app.pid,
          appBundleId: tree.app.bundleId,
          snapshotToken: tree.snapshotToken,
          elementId: element.id,
          ...(elementToken ? { elementToken } : {}),
        },
        signal,
      );
      if (!record(result) || result.ok !== true) throw new Error('辅助功能助手未确认操作完成。');
      return { ok: true };
    },
  };
}

export type DesktopAccessibility = ReturnType<typeof createDesktopAccessibility>;
