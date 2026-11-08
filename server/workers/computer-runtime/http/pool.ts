import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createSharedBrowserEngine, type BrowserScreenSession } from '../browser-engine.js';
import { createLinuxBrowserEngine } from '../linux-browser.js';
import type { DesktopLifecycleDriver } from '../computer-screen-lifecycle.js';
import { createComputerScreenPool } from '../computer-screen-pool.js';
import { createBrowserNetworkProxy, workerControlOrigin } from '../../computer-worker/index.js';
import type { DesktopAdapter } from '../desktop.js';
import { type IsolatedShellConfiguration } from '../isolated-shell.js';
import { type ScreenLifecycleOptions } from '../../../../shared/computer-screen-lifecycle.js';
import {
  type ComputerScreenConfiguration,
  type ComputerScreenPoolConfiguration,
} from '../../../../shared/computer-screens.js';

import { createComputerWorker } from './worker.js';
/** One machine identity and workspace, with independently draining screen runtimes. */
export function createComputerWorkerPool(options: {
  token: string;
  workspaceDir: string;
  configuration: ComputerScreenPoolConfiguration;
  interpreterPath: string;
  helperPath: string;
  isolatedShell?: IsolatedShellConfiguration;
  browserSessionFor?: (screenId: string) => BrowserScreenSession;
  linuxBrowser?: { launcherPath: string };
  /** Controlled component tests supply adapters; production uses fixed manifests. */
  desktopAdapterFor?: (screen: ComputerScreenConfiguration) => DesktopAdapter;
  lifecycle?: ScreenLifecycleOptions;
  /** Component tests only: production always uses the fixed Linux helper. */
  lifecycleDriver?: DesktopLifecycleDriver;
}) {
  const instanceId = randomUUID();
  const managedBrowser = options.linuxBrowser
    ? createLinuxBrowserEngine({
        interpreterPath: options.interpreterPath,
        launcherPath: options.linuxBrowser.launcherPath,
        workspaceScopeId: options.configuration.workspaceScopeId,
        stateDirectory: resolve(options.workspaceDir, '../managed-browser'),
        createProxy: () => createBrowserNetworkProxy(),
      })
    : undefined;
  const ownedBrowser =
    options.browserSessionFor || managedBrowser
      ? undefined
      : createSharedBrowserEngine({
          profileDir: resolve(options.workspaceDir, '../browser-profile'),
          createProxy: () => createBrowserNetworkProxy(),
          executablePath: process.env.OPENBOT_BROWSER_EXECUTABLE,
          headless: process.env.OPENBOT_BROWSER_HEADLESS !== 'false',
        });
  const browserSessionFor = options.browserSessionFor ?? ((id: string) => ownedBrowser!.screen(id));
  const unavailableBrowser: BrowserScreenSession = {
    peek: () => undefined,
    status: async () => ({ available: false, reason: '请选择已分配给 Bot 的独立画面。' }),
    open: async () => {
      throw new Error('请选择已分配给 Bot 的独立画面。');
    },
    close: async () => {},
  };
  const disabledDesktop: DesktopAdapter = {
    async status() {
      return {
        available: false,
        authorized: false,
        enabled: false,
        width: 0,
        height: 0,
        displays: [],
        reason: '请选择已分配给 Bot 的独立画面。',
        permissions: { screenRecording: 'denied', accessibility: 'denied' },
      };
    },
    async capture() {
      throw new Error('默认路径不提供虚拟桌面。');
    },
    async execute() {
      throw new Error('默认路径不提供虚拟桌面。');
    },
    setEnabled(value) {
      if (value) throw new Error('默认路径不提供虚拟桌面。');
    },
    async close() {},
  };
  const machine = createComputerWorker({
    token: options.token,
    workspaceDir: options.workspaceDir,
    instanceId,
    workspaceScopeId: options.configuration.workspaceScopeId,
    screenPool: true,
    screenLifecycle: !!options.lifecycle,
    desktopAdapter: disabledDesktop,
    browserSession: managedBrowser ? unavailableBrowser : browserSessionFor('default'),
    isolatedShell: options.isolatedShell,
  });
  const pool = createComputerScreenPool({
    configuration: options.configuration,
    token: options.token,
    instanceId,
    controlOrigin: () => workerControlOrigin(process.env.OPENBOT_PUBLIC_ORIGIN),
    lifecycle: options.lifecycle,
    lifecycleDriver: options.lifecycleDriver,
    recoverBrowser: async (id, revision) => {
      if (managedBrowser) {
        const configuration = options.configuration.screens.find((screen) => screen.id === id);
        if (!configuration) throw new Error('画面配置不存在。');
        await managedBrowser.recover(configuration, revision);
        return;
      }
      const session = browserSessionFor(`${id}:${revision}`);
      await session.open();
      await session.close();
    },
    createScreen: (screen, revision) =>
      createComputerWorker({
        token: options.token,
        workspaceDir: options.workspaceDir,
        instanceId,
        workspaceScopeId: options.configuration.workspaceScopeId,
        screenId: screen.id,
        screenRevision: revision,
        screenOnly: true,
        screenLifecycle: !!options.lifecycle,
        browserSession:
          managedBrowser?.screen(screen, revision) ??
          browserSessionFor(revision ? `${screen.id}:${revision}` : screen.id),
        ...(options.desktopAdapterFor
          ? { desktopAdapter: options.desktopAdapterFor(screen) }
          : {
              linuxDesktop: {
                interpreterPath: options.interpreterPath,
                helperPath: options.helperPath,
                manifestPath: screen.manifestPath,
                expectedSessionId: screen.session.id,
                expectedGeneration: screen.session.generation,
              },
            }),
      }),
  });
  const app = express();
  app.disable('x-powered-by');
  app.use('/screens', pool.router);
  app.use(machine.app);
  return {
    app,
    health: machine.health,
    inventory: pool.inventory,
    close: async () => {
      await Promise.all([pool.close(), machine.close()]);
      await ownedBrowser?.close();
      await managedBrowser?.close();
    },
  };
}
