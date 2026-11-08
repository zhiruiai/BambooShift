import { resolve } from 'node:path';
import { createSharedBrowserEngine } from '../browser-engine.js';
import { readComputerScreenPoolConfiguration } from '../computer-screen-pool.js';
import { createBrowserNetworkProxy } from '../../computer-worker/index.js';

import { createComputerWorkerPool } from './pool.js';
import { createComputerWorker } from './worker.js';
export async function startComputerWorker() {
  const token = process.env.OPENBOT_WORKER_TOKEN ?? '';
  const host = process.env.OPENBOT_WORKER_HOST ?? '127.0.0.1';
  const port = Number(process.env.OPENBOT_WORKER_PORT ?? 3002);
  const workspaceDir = resolve(process.env.OPENBOT_WORKER_WORKSPACE ?? 'data/worker/workspace');
  const interpreterPath = process.env.OPENBOT_ISOLATED_SHELL_PYTHON;
  const supervisorPath = process.env.OPENBOT_ISOLATED_SHELL_SUPERVISOR;
  const desktopPython = process.env.OPENBOT_LINUX_DESKTOP_PYTHON;
  const desktopHelper = process.env.OPENBOT_LINUX_DESKTOP_HELPER;
  const desktopManifest = process.env.OPENBOT_LINUX_DESKTOP_MANIFEST;
  const screenConfigurationPath = process.env.OPENBOT_WORKER_SCREENS_CONFIG;
  const browserLauncher = process.env.OPENBOT_LINUX_BROWSER_LAUNCHER;
  if (browserLauncher && (!screenConfigurationPath || !desktopPython))
    throw new Error('受管 Linux 浏览器需要固定画面池和桌面运行器。');
  const lifecycleStateDir = process.env.OPENBOT_WORKER_SCREEN_LIFECYCLE_STATE_DIR;
  const lifecycleHelper = process.env.OPENBOT_WORKER_SCREEN_LIFECYCLE_HELPER;
  if (
    (lifecycleStateDir || lifecycleHelper) &&
    (!lifecycleStateDir || !lifecycleHelper || !screenConfigurationPath || !desktopPython)
  )
    throw new Error('画面维护必须配置私有记录目录、固定桌面程序及画面池。');
  const desktopConfiguration = [desktopPython, desktopHelper, desktopManifest];
  if (
    (!screenConfigurationPath &&
      desktopConfiguration.some(Boolean) &&
      !desktopConfiguration.every(Boolean)) ||
    (screenConfigurationPath && (!desktopPython || !desktopHelper))
  )
    throw new Error('远程虚拟桌面配置不完整，需要同时指定运行器、控制程序和会话文件。');
  const sharedBrowser =
    screenConfigurationPath && !browserLauncher
      ? createSharedBrowserEngine({
          profileDir: resolve(workspaceDir, '../browser-profile'),
          createProxy: () => createBrowserNetworkProxy(),
          executablePath: process.env.OPENBOT_BROWSER_EXECUTABLE,
          headless: process.env.OPENBOT_BROWSER_HEADLESS !== 'false',
        })
      : undefined;
  const worker = screenConfigurationPath
    ? createComputerWorkerPool({
        token,
        workspaceDir,
        configuration: await readComputerScreenPoolConfiguration(screenConfigurationPath),
        interpreterPath: desktopPython!,
        helperPath: desktopHelper!,
        ...(browserLauncher
          ? { linuxBrowser: { launcherPath: browserLauncher } }
          : { browserSessionFor: (id: string) => sharedBrowser!.screen(id) }),
        ...(lifecycleStateDir && lifecycleHelper && desktopPython
          ? {
              lifecycle: {
                stateDir: lifecycleStateDir,
                helperPath: lifecycleHelper,
                interpreterPath: desktopPython,
              },
            }
          : {}),
        ...(interpreterPath && supervisorPath
          ? { isolatedShell: { interpreterPath, supervisorPath } }
          : {}),
      })
    : createComputerWorker({
        token,
        workspaceDir,
        ...(interpreterPath && supervisorPath
          ? { isolatedShell: { interpreterPath, supervisorPath } }
          : {}),
        ...(desktopPython && desktopHelper && desktopManifest
          ? {
              linuxDesktop: {
                interpreterPath: desktopPython,
                helperPath: desktopHelper,
                manifestPath: desktopManifest,
              },
            }
          : {}),
      });
  const { app } = worker;
  const close = async () => {
    await worker.close();
    await sharedBrowser?.close();
  };
  const server = app.listen(port, host, () => {
    console.log(`OpenBot Computer Worker: http://${host}:${port}`);
    console.log(`Workspace: ${workspaceDir}`);
  });
  const shutdown = () => {
    server.close();
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
