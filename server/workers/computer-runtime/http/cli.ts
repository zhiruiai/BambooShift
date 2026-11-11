import { isAbsolute, resolve } from 'node:path';
import { isComputerOperationId } from '../../../../shared/computer-operations.js';
import { createDesktopAdapter } from '../desktop.js';
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
  const workspaceScopeId = process.env.OPENBOT_WORKER_WORKSPACE_ID;
  const hostDesktop = process.env.OPENBOT_WORKER_ALLOW_HOST_DESKTOP === 'true';
  const desktopHelperPath = process.env.OPENBOT_MACOS_DESKTOP_HELPER;
  if (workspaceScopeId !== undefined && !isComputerOperationId(workspaceScopeId))
    throw new Error('OPENBOT_WORKER_WORKSPACE_ID must be the MosoCrew workspace UUID.');
  if (workspaceScopeId && screenConfigurationPath)
    throw new Error('Set the workspace ID in the screen pool configuration.');
  if (
    hostDesktop &&
    (process.platform !== 'darwin' ||
      !workspaceScopeId ||
      screenConfigurationPath ||
      desktopPython ||
      desktopHelper ||
      desktopManifest ||
      (desktopHelperPath !== undefined && !isAbsolute(desktopHelperPath)))
  )
    throw new Error('Host desktop access requires a dedicated macOS worker and workspace ID.');
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
        workspaceScopeId,
        ...(hostDesktop
          ? { hostDesktop, desktopAdapter: createDesktopAdapter({ helperPath: desktopHelperPath }) }
          : {}),
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
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : port;
    console.log(`OpenBot Computer Worker: http://${host}:${boundPort}`);
    console.log(`Workspace: ${workspaceDir}`);
  });
  const shutdown = () => {
    server.close();
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
