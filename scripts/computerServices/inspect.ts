import { dirname, join } from 'node:path';
import { loadCubeWorkerBridgeConfig } from '../cube-worker-bridge.js';

import {
  failure,
  servicePorts,
  privateJson,
  type Listener,
  type Port,
  type ServiceDependencies,
  type ServicesConfig,
  type ServicesStatus,
} from './config.js';
import { defaults } from './system.js';
async function jsonRequest(
  deps: ServiceDependencies,
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  const response = await deps.fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 65536) throw new Error('oversized response');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function inspectServices(
  config: ServicesConfig,
  overrides: Partial<ServiceDependencies> = {},
  signal?: AbortSignal,
): Promise<ServicesStatus> {
  const deps = { ...defaults, ...overrides };
  const [listeners, master] = await Promise.all([
    Promise.all(
      servicePorts(config).map(async (port) => [port, await deps.listener(port)] as const),
    ),
    deps.master(config),
  ]);
  const map = Object.fromEntries(listeners) as Record<Port, Listener>;
  const status: ServicesStatus = {
    checkedAt: new Date().toISOString(),
    api: { state: 'missing' },
    bridge: { state: 'missing' },
    tunnel: { state: 'missing' },
    vm: { state: 'unknown' },
    worker: { state: 'not_checked' },
    ready: false,
  };
  const apiListener = map[config.ports.api];
  const bridgeListener = map[config.ports.bridge];
  if (apiListener) {
    status.api = { state: 'conflict', pid: apiListener.pid };
    if (apiListener.loopback && (await deps.ownsApi(apiListener.pid, config))) {
      status.api.state = 'unavailable';
      try {
        const health = await jsonRequest(
          deps,
          `http://127.0.0.1:${config.ports.api}/api/health`,
          {},
          signal,
        );
        if (health.ok === true && health.architecture === 'platform' && health.backend === 'rust')
          status.api.state = 'ready';
        else status.api.state = 'conflict';
      } catch {}
    }
  }
  if (bridgeListener)
    status.bridge = {
      pid: bridgeListener.pid,
      state:
        bridgeListener.loopback && (await deps.ownsBridge(bridgeListener.pid, config))
          ? 'ready'
          : 'conflict',
    };
  if (map[config.ports.cubeApi] || map[config.ports.cubeProxy])
    status.tunnel = {
      state:
        master &&
        [config.ports.cubeApi, config.ports.cubeProxy].every(
          (port) => map[port as Port]?.pid === master && map[port as Port]?.loopback,
        )
          ? 'ready'
          : 'conflict',
      ...(master ? { pid: master } : {}),
    };
  if (status.tunnel.state !== 'ready') return status;
  let cube: Record<string, any>, connection: Record<string, any>, cloud: Record<string, any>;
  try {
    cube = await privateJson(config.cubeConfigPath);
    const bridge = await loadCubeWorkerBridgeConfig(config.cubeConfigPath);
    if (
      bridge.bridge?.listenPort !== config.ports.bridge ||
      bridge.bridge?.upstreamPort !== config.ports.cubeProxy
    )
      throw new Error('invalid bridge binding');
    connection = await privateJson(config.connectionPath);
    cloud = await privateJson(join(dirname(config.connectionPath), 'cloud.json'));
    const remote = connection.remote;
    if (
      typeof cube.templateID !== 'string' ||
      !cube.templateID ||
      connection.version !== 1 ||
      !remote ||
      remote.url !== `http://127.0.0.1:${config.ports.bridge}` ||
      typeof remote.token !== 'string' ||
      !/^[\x21-\x7e]{24,16000}$/.test(remote.token) ||
      typeof remote.instanceId !== 'string' ||
      remote.instanceId.length < 20 ||
      !(
        remote.controlOrigin === null ||
        (typeof remote.controlOrigin === 'string' &&
          new URL(remote.controlOrigin).origin === remote.controlOrigin)
      ) ||
      cloud.provider !== 'cubesandbox' ||
      cloud.sandboxId !== cube.sandboxID ||
      cloud.autoResume !== false ||
      cloud.apiBaseUrl !== `http://127.0.0.1:${config.ports.cubeApi}` ||
      cloud.workerUrl !== `http://127.0.0.1:${config.ports.bridge}` ||
      (cloud.apiKey !== undefined &&
        (typeof cloud.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(cloud.apiKey)))
    )
      throw new Error('invalid binding');
  } catch {
    throw failure('BINDING_INVALID', '固定实例或已保存 Worker 私有绑定无效；未发送电脑请求。');
  }
  try {
    const detail = await jsonRequest(
      deps,
      `http://127.0.0.1:${config.ports.cubeApi}/sandboxes/${encodeURIComponent(cube.sandboxID)}`,
      cloud.apiKey ? { Authorization: `Bearer ${cloud.apiKey}` } : {},
      signal,
    );
    if (detail.sandboxID !== cube.sandboxID || detail.templateID !== cube.templateID) {
      status.worker.state = 'identity_mismatch';
      return status;
    }
    status.vm.state = ['running', 'paused', 'pausing'].includes(detail.state)
      ? detail.state
      : 'unknown';
    if (typeof detail.endAt === 'string' && Number.isFinite(Date.parse(detail.endAt)))
      status.vm.expiresAt = detail.endAt;
  } catch {
    return status;
  }
  if (status.vm.state === 'paused') status.worker.state = 'paused';
  if (status.vm.state === 'running' && status.bridge.state === 'ready') {
    status.worker.state = 'unavailable';
    try {
      const remote = connection.remote;
      const health = await jsonRequest(
        deps,
        `http://127.0.0.1:${config.ports.bridge}/health`,
        {
          Authorization: `Bearer ${remote.token}`,
          'X-OpenBot-Worker-Instance': remote.instanceId,
          'X-OpenBot-Control-Origin': remote.controlOrigin ?? 'none',
        },
        signal,
      );
      status.worker.state =
        health.protocol === 'openbot-computer-v2' &&
        health.instanceId === remote.instanceId &&
        health.controlOrigin === remote.controlOrigin
          ? 'ready'
          : 'identity_mismatch';
    } catch {}
  }
  status.ready =
    status.api.state === 'ready' &&
    status.bridge.state === 'ready' &&
    ['ready', 'paused'].includes(status.worker.state);
  return status;
}
