import { isAbsolute } from 'node:path';
import type { ActionRequester } from '../../../shared/approvals.js';
import type { ComputerFrame } from '../../../shared/types.js';
import type { DesktopSessionRef } from '../../../shared/linux-desktop.js';
import { validateShellInput } from '../computer-runtime/isolated-shell.js';
import { validateComputerPath } from '../computer-runtime/computer-files.js';
import { validateDesktopInput } from '../computer-runtime/desktop.js';
export type ComputerSurface = 'browser' | 'desktop';
export const COMPUTER_WORKER_PROTOCOL = 'openbot-computer-v2';
/** Canonical declaration shared by the controller and execution-time Worker guard. */
export function workerControlOrigin(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Worker 控制台隔离声明无效。');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Worker 控制台隔离声明必须为完整 HTTPS origin。');
  return url.origin;
}

export type ComputerActionType =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'upload_file'
  | 'download_file'
  | 'terminal_command'
  | 'remote_shell'
  | 'browser_navigate'
  | 'browser_click'
  | 'browser_download'
  | 'browser_type'
  | 'browser_scroll'
  | 'browser_back'
  | 'browser_screenshot'
  | 'desktop_screenshot'
  | 'desktop_click'
  | 'desktop_type'
  | 'desktop_key'
  | 'desktop_scroll'
  | 'desktop_drag';
export interface ComputerActionInput {
  type: ComputerActionType;
  fileId?: string;
  sourceName?: string;
  size?: number;
  sha256?: string;
  path?: string;
  content?: string;
  command?: string;
  url?: string;
  selector?: string;
  text?: string;
  direction?: 'up' | 'down';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  button?: 'left' | 'right';
  clickCount?: 1 | 2;
  durationMs?: number;
}
export interface ComputerAction {
  id: string;
  type: ComputerActionType;
  payload: ComputerActionInput;
  status: 'pending' | 'running' | 'done' | 'rejected' | 'error';
  createdAt: string;
  agentId?: string;
  requester?: ActionRequester;
  screenBinding?: { screenId: string; assignmentRevision?: string };
  desktopSession?: DesktopSessionRef;
  result?: unknown;
  error?: string;
  frame?: ComputerFrame;
  frameUnavailable?: string;
}
const actionTypes = new Set<ComputerActionType>([
  'list_files',
  'read_file',
  'write_file',
  'upload_file',
  'download_file',
  'terminal_command',
  'remote_shell',
  'browser_navigate',
  'browser_click',
  'browser_download',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'desktop_screenshot',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_scroll',
  'desktop_drag',
]);
const readOnlyTypes = new Set([
  'list_files',
  'read_file',
  'download_file',
  'terminal_command',
  'browser_screenshot',
  'desktop_screenshot',
]);
export const viewport = { width: 1440, height: 900 };
const takeoverKeys = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ControlOrMeta+A',
]);
export interface TakeoverState {
  active: boolean;
  expiresAt?: string;
  width: number;
  height: number;
  surface: ComputerSurface;
}
export interface TakeoverLease extends TakeoverState {
  leaseId: string;
  expiresAt: string;
}
export interface TakeoverInput {
  leaseId: string;
  type: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'drag';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  deltaX?: number;
  url?: string;
  button?: 'left' | 'right';
  clickCount?: 1 | 2;
  toX?: number;
  toY?: number;
  durationMs?: number;
}
export function validateTakeoverInput(
  raw: unknown,
  bounds = viewport,
  surface: ComputerSurface = 'browser',
): TakeoverInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('需要人工接管输入。');
  const a = raw as TakeoverInput;
  if (typeof a.leaseId !== 'string' || a.leaseId.length > 200 || a.leaseId.length < 20)
    throw new Error('接管凭据无效。');
  if (
    ![
      'click',
      'type',
      'key',
      'scroll',
      'navigate',
      ...(surface === 'desktop' ? ['drag'] : []),
    ].includes(a.type)
  )
    throw new Error('不支持的接管输入。');
  const point = (x: number | undefined, y: number | undefined) =>
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x! >= 0 &&
    y! >= 0 &&
    x! < bounds.width &&
    y! < bounds.height;
  if (['click', 'drag'].includes(a.type) && !point(a.x, a.y)) throw new Error('点击坐标超出画面。');
  if (a.type === 'drag' && !point(a.toX, a.toY)) throw new Error('拖动目标超出画面。');
  if (
    a.durationMs !== undefined &&
    (!Number.isFinite(a.durationMs) || a.durationMs < 100 || a.durationMs > 2000)
  )
    throw new Error('拖动时间必须为 100 到 2000 毫秒。');
  if (a.button !== undefined && !['left', 'right'].includes(a.button))
    throw new Error('不支持的鼠标按钮。');
  if (a.clickCount !== undefined && ![1, 2].includes(a.clickCount))
    throw new Error('点击次数必须为 1 或 2。');
  if (a.type === 'type' && (typeof a.text !== 'string' || a.text.length > 20_000))
    throw new Error('输入内容必须为不超过 20,000 字符的文本。');
  if (
    a.type === 'key' &&
    (surface === 'browser'
      ? !takeoverKeys.has(a.key!)
      : typeof a.key !== 'string' || a.key.length > 80 || !a.key.length)
  )
    throw new Error('不允许使用此按键。');
  if (
    a.type === 'scroll' &&
    (!Number.isFinite(a.deltaY) ||
      Math.abs(a.deltaY!) > 3000 ||
      (a.deltaX !== undefined && (!Number.isFinite(a.deltaX) || Math.abs(a.deltaX) > 3000)))
  )
    throw new Error('滚动幅度必须在 -3000 到 3000 之间。');
  if (a.type === 'navigate') {
    if (surface === 'desktop') throw new Error('整机模式请通过桌面输入打开应用或网址。');
    validateComputerAction({ type: 'browser_navigate', url: a.url });
  }
  if (surface === 'desktop') {
    const { leaseId: _lease, ...native } = a;
    validateDesktopInput(native);
  }
  return Object.fromEntries(
    [
      'leaseId',
      'type',
      'x',
      'y',
      'toX',
      'toY',
      'text',
      'key',
      'deltaY',
      'deltaX',
      'url',
      'button',
      'clickCount',
      'durationMs',
    ]
      .filter((k) => (a as any)[k] !== undefined)
      .map((k) => [k, (a as any)[k]]),
  ) as unknown as TakeoverInput;
}
export const isSurfaceAction = (type: string) =>
  type.startsWith('browser_') || type.startsWith('desktop_');
export function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('电脑返回了无效的 PNG 截图。');
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768) throw new Error('截图尺寸无效。');
  return { width, height };
}
export const terminalCommands: Record<string, [string, string[]]> = {
  pwd: ['pwd', []],
  ls: ['ls', ['-lah']],
  date: ['date', []],
  uname: ['uname', ['-a']],
};
export const capabilities = [
  'workspace-files',
  'binary-file-transfer',
  'read-only-terminal',
  'browser',
  'browser-screenshot',
  'browser-download',
  'human-approval',
  'human-takeover',
  'desktop',
];

export function validateComputerAction(input: unknown): ComputerActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('需要电脑操作参数。');
  const a = input as ComputerActionInput;
  if (!actionTypes.has(a.type)) throw new Error('不支持的电脑操作。');
  if (['upload_file', 'download_file'].includes(a.type)) {
    if (['sourceName', 'size', 'sha256'].some((key) => Object.hasOwn(a, key)))
      throw new Error('文件审批信息必须由资料库生成。');
    if (
      a.type === 'upload_file' &&
      (typeof a.fileId !== 'string' || !a.fileId || a.fileId.length > 200)
    )
      throw new Error('请选择资料库文件。');
    if (a.type === 'download_file' || a.path !== undefined) a.path = validateComputerPath(a.path);
    return {
      type: a.type,
      ...(a.type === 'upload_file' ? { fileId: a.fileId } : {}),
      ...(a.path !== undefined ? { path: a.path } : {}),
    };
  }
  for (const key of ['path', 'content', 'command', 'url', 'selector', 'text'] as const) {
    if (a[key] !== undefined && typeof a[key] !== 'string') throw new Error(`${key} 必须是文本。`);
    if ((a[key]?.length ?? 0) > (key === 'content' ? 200_000 : 20_000))
      throw new Error('操作内容过长。');
  }
  if (['read_file', 'write_file'].includes(a.type) && !a.path) throw new Error('需要文件路径。');
  if (
    a.path &&
    (isAbsolute(a.path) || a.path.split(/[\\/]/).includes('..') || a.path.includes('\0'))
  )
    throw new Error('只能访问工作区内的相对路径。');
  if (a.type === 'write_file' && a.content === undefined) throw new Error('需要文件内容。');
  if (a.type === 'terminal_command' && !Object.hasOwn(terminalCommands, a.command ?? ''))
    throw new Error('终端仅支持只读命令：pwd、ls、date、uname。');
  if (a.type === 'remote_shell') {
    const { command, cwd } = validateShellInput(a.command, a.path);
    return { type: a.type, command, path: cwd };
  }
  if (a.type === 'browser_navigate') {
    let url: URL;
    try {
      url = new URL(a.url!);
    } catch {
      throw new Error('请输入完整的网址。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('浏览器只支持不带凭据的 HTTP(S) 网址。');
    a.url = url.href;
  }
  if (['browser_click', 'browser_type', 'browser_download'].includes(a.type) && !a.selector)
    throw new Error('需要目标元素 selector。');
  if (a.type === 'browser_download')
    return { type: a.type, selector: a.selector, path: validateComputerPath(a.path) };
  if (a.type === 'browser_type' && a.text === undefined) throw new Error('需要输入内容。');
  if (a.type === 'browser_scroll' && !['up', 'down'].includes(a.direction!))
    throw new Error('滚动方向必须为 up 或 down。');
  if (a.type.startsWith('desktop_') && a.type !== 'desktop_screenshot')
    validateTakeoverInput(
      { ...a, type: a.type.slice(8), leaseId: 'validation-only-desktop' },
      { width: 32768, height: 32768 },
      'desktop',
    );
  // Copy only known fields; metadata cannot replace approval state or IDs.
  return Object.fromEntries(
    [
      'type',
      'fileId',
      'path',
      'content',
      'command',
      'url',
      'selector',
      'text',
      'direction',
      'x',
      'y',
      'toX',
      'toY',
      'key',
      'deltaY',
      'deltaX',
      'button',
      'clickCount',
      'durationMs',
    ]
      .filter((k) => (a as any)[k] !== undefined)
      .map((k) => [k, (a as any)[k]]),
  ) as unknown as ComputerActionInput;
}
