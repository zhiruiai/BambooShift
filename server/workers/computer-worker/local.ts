import { mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserContext, Page } from 'playwright-core';
import type { ComputerState } from '../../../shared/types.js';
import type { BrowserScreenSession } from '../computer-runtime/browser-engine.js';
import { browserEnvironment } from '../computer-runtime/browser-environment.js';
import {
  listComputerEntries,
  readComputerText,
  writeComputerText,
} from '../computer-runtime/computer-files.js';
import {
  createDesktopAdapter,
  type DesktopAdapter,
  type DesktopInput,
} from '../computer-runtime/desktop.js';
import { createBrowserNetworkProxy, resolveBrowserTarget } from './network.js';
import {
  type ComputerSurface,
  type TakeoverState,
  type TakeoverLease,
  type ComputerActionInput,
  viewport,
  isSurfaceAction,
  terminalCommands,
  validateTakeoverInput,
  validateComputerAction,
  pngDimensions,
} from './protocol.js';
import { captureDownload } from './download.js';
import { localComputerStatus } from './local-status.js';
const execFileAsync = promisify(execFile);
export class LocalComputer {
  private context?: BrowserContext;
  private page?: Page;
  private launching?: Promise<Page>;
  private proxy?: Awaited<ReturnType<typeof createBrowserNetworkProxy>>;
  private surface: ComputerSurface = 'browser';
  private readonly desktop: DesktopAdapter;
  private desktopState?: ComputerState['desktop'];
  private browserState?: { available: boolean; reason?: string };
  private takeover?: { id: string; expiresAt: number };
  private downloadTask?: { controller: AbortController; done: Promise<unknown> };
  constructor(
    readonly workspace: string,
    readonly profileDir = resolve(workspace, '../browser-profile'),
    private readonly leaseOptions: {
      now?: () => number;
      ttlMs?: number;
      desktopAdapter?: DesktopAdapter;
      downloadTimeoutMs?: number;
      browserSession?: BrowserScreenSession;
    } = {},
  ) {
    this.desktop = leaseOptions.desktopAdapter ?? createDesktopAdapter();
  }
  private dimensions() {
    return this.surface === 'desktop'
      ? { width: this.desktopState?.width ?? 0, height: this.desktopState?.height ?? 0 }
      : viewport;
  }
  async refreshStatus(): Promise<ComputerState> {
    this.desktopState = await this.desktop.status();
    this.browserState = await this.leaseOptions.browserSession?.status?.();
    return this.status();
  }
  async setSurface(
    surface: ComputerSurface,
    confirmed = false,
    options: { signal?: AbortSignal } = {},
  ): Promise<ComputerState> {
    options.signal?.throwIfAborted();
    if (!['browser', 'desktop'].includes(surface)) throw new Error('不支持的电脑界面。');
    if (surface === 'desktop') {
      if (!confirmed) throw new Error('请明确确认开启整机桌面。');
      await this.refreshStatus();
      if (!this.desktopState?.available || !this.desktopState.authorized)
        throw new Error(this.desktopState?.reason || '整机桌面权限尚未授予。');
      await this.leaseOptions.browserSession?.prepareDesktop?.(options);
      options.signal?.throwIfAborted();
    }
    await this.cancelBrowserDownload('电脑界面已切换，网页导出已取消。');
    this.takeover = undefined;
    this.desktop.setEnabled(surface === 'desktop');
    this.surface = surface;
    await this.refreshStatus();
    await this.auditTakeover('surface', { surface });
    return this.status();
  }
  private async assertDesktopReady() {
    if (this.surface !== 'desktop') throw new Error('请先在电脑面板手动开启整机桌面。');
    await this.refreshStatus();
    if (!this.desktopState?.enabled || !this.desktopState.authorized)
      throw new Error(this.desktopState?.reason || '整机桌面权限不可用。');
  }
  private now() {
    return this.leaseOptions.now?.() ?? Date.now();
  }
  takeoverStatus(): TakeoverState {
    if (this.takeover && this.takeover.expiresAt <= this.now()) this.takeover = undefined;
    return {
      active: Boolean(this.takeover),
      ...(this.takeover ? { expiresAt: new Date(this.takeover.expiresAt).toISOString() } : {}),
      surface: this.surface,
      ...this.dimensions(),
    };
  }
  cancelTakeover() {
    this.takeover = undefined;
  }
  private assertAgentAccess() {
    if (this.takeoverStatus().active)
      throw new Error('用户正在人工接管电脑，请等待结束接管后继续。');
  }
  private assertLease(id: string) {
    if (!this.takeoverStatus().active || this.takeover?.id !== id)
      throw new Error('接管凭据已失效或过期，请重新接管电脑。');
  }
  private async auditTakeover(event: string, detail: Record<string, unknown> = {}) {
    const dir = resolve(this.workspace, '../computer');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(dir, 'takeover.jsonl'),
      JSON.stringify({ at: new Date(this.now()).toISOString(), actor: 'human', event, ...detail }) +
        '\n',
      { mode: 0o600 },
    );
  }
  async startTakeover(): Promise<TakeoverLease> {
    if (this.takeoverStatus().active)
      throw new Error('另一端正在接管电脑，请等待本次接管结束或过期。');
    await this.cancelBrowserDownload('用户正在接管电脑，网页导出已取消。');
    const lease = {
      id: randomUUID(),
      expiresAt: this.now() + Math.min(Math.max(this.leaseOptions.ttlMs ?? 300_000, 100), 300_000),
    };
    this.takeover = lease;
    try {
      if (this.surface === 'desktop') await this.assertDesktopReady();
      else await this.browser();
      this.assertLease(lease.id);
      await this.auditTakeover('start');
      return {
        leaseId: lease.id,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        active: true,
        surface: this.surface,
        ...this.dimensions(),
      };
    } catch (error) {
      if (this.takeover === lease) this.takeover = undefined;
      throw error;
    }
  }
  async endTakeover(leaseId: string): Promise<TakeoverState> {
    this.assertLease(leaseId);
    this.takeover = undefined;
    await this.auditTakeover('end');
    return this.takeoverStatus();
  }
  async takeoverInput(
    raw: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ ok: true; capturedAt: string; width: number; height: number }> {
    options.signal?.throwIfAborted();
    if (this.surface === 'desktop') await this.assertDesktopReady();
    const input = validateTakeoverInput(raw, this.dimensions(), this.surface);
    this.assertLease(input.leaseId);
    if (this.surface === 'desktop') {
      const { leaseId: _lease, ...native } = input;
      await this.desktop.execute(native as DesktopInput, options);
    } else {
      const page = await this.browser();
      this.assertLease(input.leaseId);
      if (input.type === 'click')
        await page.mouse.click(input.x!, input.y!, {
          button: input.button,
          clickCount: input.clickCount,
        });
      if (input.type === 'type') await page.keyboard.insertText(input.text!);
      if (input.type === 'key')
        await page.keyboard.press(
          input.key === 'ControlOrMeta+A'
            ? platform() === 'darwin'
              ? 'Meta+A'
              : 'Control+A'
            : input.key!,
        );
      if (input.type === 'scroll') await page.mouse.wheel(input.deltaX ?? 0, input.deltaY!);
      if (input.type === 'navigate') {
        const url = new URL(input.url!);
        await resolveBrowserTarget(url);
        const response = await page.goto(url.href, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        if (response && response.status() >= 400)
          throw new Error(`网页请求失败 (${response.status()})。`);
      }
    }
    const { leaseId: _lease, text: _text, ...details } = input;
    await this.auditTakeover(input.type, {
      ...details,
      ...(_text !== undefined ? { characters: _text.length } : {}),
    });
    return { ok: true, capturedAt: new Date().toISOString(), ...this.dimensions() };
  }
  status(): ComputerState {
    if (this.leaseOptions.browserSession) {
      const current = this.leaseOptions.browserSession.peek();
      this.page = current?.page;
      this.context = current?.context;
    }
    return localComputerStatus(
      this.surface,
      this.desktopState,
      this.page,
      this.takeoverStatus().active,
      this.browserState,
    );
  }
  private async browser(): Promise<Page> {
    if (this.leaseOptions.browserSession) {
      const current = await this.leaseOptions.browserSession.open();
      this.page = current.page;
      this.context = current.context;
      return current.page;
    }
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.launching) return this.launching;
    if (this.context) {
      try {
        this.page =
          this.context.pages().find((p) => !p.isClosed()) ?? (await this.context.newPage());
        return this.page;
      } catch {
        await this.close();
      }
    }
    this.launching = (async () => {
      const { chromium } = await import('playwright-core');
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      const executablePath = process.env.OPENBOT_BROWSER_EXECUTABLE;
      try {
        this.proxy = await createBrowserNetworkProxy();
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          ...(executablePath ? { executablePath } : { channel: 'chrome' }),
          headless: process.env.OPENBOT_BROWSER_HEADLESS !== 'false',
          env: browserEnvironment(this.profileDir),
          viewport,
          deviceScaleFactor: 1,
          acceptDownloads: false,
          serviceWorkers: 'block',
          timeout: 30_000,
          proxy: { server: this.proxy.url, bypass: '<-loopback>' },
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        });
      } catch {
        await this.proxy?.close();
        this.proxy = undefined;
        throw new Error(
          '无法启动独立浏览器。请安装 Chrome，或设置 OPENBOT_BROWSER_EXECUTABLE。OpenBot 不会读取你现有的浏览器登录信息。',
        );
      }
      await this.context.route('**/*', (route) => {
        const protocol = new URL(route.request().url()).protocol;
        return ['http:', 'https:'].includes(protocol)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
      this.context.on('page', (page) => {
        this.page = page;
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      return this.page;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = undefined;
    }
  }
  async screenshot(
    options: {
      forAgent?: boolean;
      signal?: AbortSignal;
      authorize?: () => void;
      leaseId?: string;
    } = {},
  ): Promise<Buffer> {
    const authorize = () => {
      options.signal?.throwIfAborted();
      options.authorize?.();
      if (options.forAgent) this.assertAgentAccess();
      // Expire the lease before comparing proof, including after capture.
      this.takeoverStatus();
      if (this.takeover?.id !== options.leaseId)
        throw Object.assign(new Error('只有当前接管端可以查看接管画面。'), {
          status: 409,
          code: 'COMPUTER_PRIVATE_TAKEOVER',
        });
    };
    authorize();
    if (this.surface === 'desktop') {
      await this.assertDesktopReady();
      authorize();
      const frame = await this.desktop.capture({ signal: options.signal });
      authorize();
      return frame.png;
    }
    if (this.leaseOptions.browserSession) this.page = this.leaseOptions.browserSession.peek()?.page;
    if (!this.page || this.page.isClosed())
      throw new Error('尚未打开独立浏览器。请先接管电脑，或批准一次“打开网页”操作，再查看截图。');
    const frame = await this.page.screenshot({ type: 'png', timeout: 10_000 });
    authorize();
    return frame;
  }
  async cancelBrowserDownload(reason = '网页导出已取消。'): Promise<void> {
    const task = this.downloadTask;
    if (!task) return;
    task.controller.abort(new Error(reason));
    await task.done.catch(() => {});
  }
  private captureDownload(action: ComputerActionInput, signal: AbortSignal) {
    return captureDownload(
      {
        workspace: this.workspace,
        browser: () => this.browser(),
        context: () => this.context,
        assertAgentAccess: () => this.assertAgentAccess(),
      },
      action,
      signal,
    );
  }
  private download(action: ComputerActionInput, externalSignal?: AbortSignal): Promise<unknown> {
    if (this.downloadTask) throw new Error('另一个网页导出正在进行。');
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new Error('网页导出超时，请确认所选按钮会下载文件后重试。')),
      Math.min(this.leaseOptions.downloadTimeoutMs ?? 30_000, 30_000),
    );
    const task = {
      controller,
      done: Promise.resolve().then(() => this.captureDownload(action, signal)),
    };
    this.downloadTask = task;
    return task.done.finally(() => {
      clearTimeout(timer);
      if (this.downloadTask === task) this.downloadTask = undefined;
    });
  }
  /** Intercept an explicitly requested export before Chromium stores its body on disk. */
  async execute(raw: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    const action = validateComputerAction(raw);
    if (action.type === 'remote_shell')
      throw new Error('此命令仅支持通过隔离检查的远程电脑，本机不可执行。');
    if (['upload_file', 'download_file'].includes(action.type))
      throw new Error('二进制文件传输必须通过已绑定资料库的控制端执行。');
    if (isSurfaceAction(action.type)) {
      this.assertAgentAccess();
      if (!action.type.startsWith(this.surface + '_'))
        throw new Error(
          `当前为 ${this.surface === 'desktop' ? '整机桌面' : '独立浏览器'} 模式，请使用对应操作；模式只能由用户手动切换。`,
        );
    }
    if (action.type.startsWith('desktop_') && action.type !== 'desktop_screenshot') {
      await this.assertDesktopReady();
      this.assertAgentAccess();
      const input = validateTakeoverInput(
        { ...action, type: action.type.slice(8), leaseId: 'validated-model-desktop' },
        this.dimensions(),
        'desktop',
      );
      const { leaseId: _lease, ...native } = input;
      return {
        ...(await this.desktop.execute(native as DesktopInput, options)),
        surface: 'desktop',
        ...this.dimensions(),
      };
    }
    await mkdir(this.workspace, { recursive: true });
    switch (action.type) {
      case 'browser_download':
        return this.download(action, options.signal);
      case 'list_files': {
        return {
          path: action.path ?? '.',
          entries: await listComputerEntries(this.workspace, action.path, options.signal),
        };
      }
      case 'read_file': {
        return {
          path: action.path,
          content: await readComputerText(this.workspace, action.path!, options.signal),
        };
      }
      case 'write_file': {
        await writeComputerText(this.workspace, action.path!, action.content!, options.signal);
        return { path: action.path, bytes: Buffer.byteLength(action.content!) };
      }
      case 'terminal_command': {
        const [command, args] = terminalCommands[action.command!];
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: this.workspace,
          timeout: 5_000,
          maxBuffer: 100_000,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
        });
        return { command: action.command, stdout, stderr };
      }
      case 'desktop_screenshot':
      case 'browser_screenshot': {
        const png = await this.screenshot({ forAgent: true, signal: options.signal });
        return {
          mimeType: 'image/png',
          data: png.toString('base64'),
          capturedAt: new Date().toISOString(),
          surface: this.surface,
          ...pngDimensions(png),
        };
      }
      default: {
        const page = await this.browser();
        this.assertAgentAccess();
        if (action.type === 'browser_navigate') {
          await resolveBrowserTarget(new URL(action.url!));
          const response = await page.goto(action.url!, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          if (response && response.status() >= 400)
            throw new Error(
              `网页请求失败 (${response.status()})：${(await page.locator('body').innerText()).slice(0, 300)}`,
            );
        }
        if (action.type === 'browser_click')
          await page.locator(action.selector!).first().click({ timeout: 10_000 });
        if (action.type === 'browser_type')
          await page.locator(action.selector!).first().fill(action.text!, { timeout: 10_000 });
        if (action.type === 'browser_scroll')
          await page.mouse.wheel(0, action.direction === 'up' ? -650 : 650);
        if (action.type === 'browser_back')
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Visible text and selectors let Pi inspect a real page without executing page JS.
        const text = (await page.locator('body').innerText({ timeout: 10_000 })).slice(0, 16_000);
        const controls = await page
          .locator('a,button,input,textarea,select')
          .evaluateAll((elements) =>
            elements.slice(0, 100).map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: (el.textContent ?? '').trim().slice(0, 100),
              id: el.id || undefined,
              name: el.getAttribute('name') ?? undefined,
              placeholder: el.getAttribute('placeholder') ?? undefined,
              href: el.getAttribute('href') ?? undefined,
            })),
          );
        return { url: page.url(), title: await page.title(), text, controls };
      }
    }
  }
  async close(): Promise<void> {
    await this.cancelBrowserDownload('电脑连接已关闭，网页导出已取消。');
    this.takeover = undefined;
    this.surface = 'browser';
    this.desktop.setEnabled(false);
    await this.desktop.close();
    if (this.desktopState) this.desktopState = { ...this.desktopState, enabled: false };
    if (this.leaseOptions.browserSession) {
      await this.leaseOptions.browserSession.close();
      this.context = undefined;
      this.page = undefined;
      return;
    }
    // A shutdown can arrive while Chromium is launching; wait so its late result cannot leak.
    try {
      await this.launching;
    } catch {
      /* Failed launches already close their proxy. */
    }
    try {
      await this.context?.close();
    } finally {
      await this.proxy?.close();
      this.context = undefined;
      this.page = undefined;
      this.proxy = undefined;
    }
  }
}
