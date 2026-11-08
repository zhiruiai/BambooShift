import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_TRANSFER_BYTES } from '../shared/computer-files.js';

export interface CubeWorkerBridgeConfig {
  sandboxID: string;
  domain: string;
  trafficAccessToken: string;
  bridge?: { listenPort: number; upstreamPort: number };
}

function validateConfig(value: unknown): CubeWorkerBridgeConfig {
  const data = value as Partial<CubeWorkerBridgeConfig> | null;
  if (
    !data ||
    typeof data.sandboxID !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(data.sandboxID) ||
    typeof data.domain !== 'string' ||
    !data.domain
      .split('.')
      .every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part)) ||
    `3002-${data.sandboxID}.${data.domain}`.length > 253 ||
    typeof data.trafficAccessToken !== 'string' ||
    !/^[\x21-\x7e]{1,4096}$/.test(data.trafficAccessToken)
  )
    throw new Error('Cube Worker 桥配置无效，需要唯一实例 ID、合法域名和流量凭据。');
  if (
    data.bridge !== undefined &&
    (!data.bridge ||
      typeof data.bridge !== 'object' ||
      Array.isArray(data.bridge) ||
      !Object.keys(data.bridge).every((key) => ['listenPort', 'upstreamPort'].includes(key)) ||
      ![data.bridge.listenPort, data.bridge.upstreamPort].every(
        (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
      ) ||
      data.bridge.listenPort === data.bridge.upstreamPort)
  )
    throw new Error('Cube Worker 桥端口配置无效。');
  return {
    ...(data.bridge ? { bridge: { ...data.bridge } } : {}),
    sandboxID: data.sandboxID,
    domain: data.domain.toLowerCase(),
    trafficAccessToken: data.trafficAccessToken,
  };
}

/** Read only this explicit private file; never inherit API credentials or arbitrary headers. */
export async function loadCubeWorkerBridgeConfig(path: string): Promise<CubeWorkerBridgeConfig> {
  let handle;
  try {
    handle = await open(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65_536 ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('invalid private file');
    const bytes = Buffer.alloc(65_537);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > 65_536) throw new Error('oversized private file');
    return validateConfig(JSON.parse(bytes.subarray(0, count).toString('utf8')));
  } catch {
    throw new Error(
      '无法读取 Cube Worker 私有配置。请确认是当前用户所有、权限 0600 的普通 JSON 文件。',
    );
  } finally {
    await handle?.close();
  }
}

const routes: Record<string, readonly string[]> = {
  '/health': ['GET'],
  '/screens': ['GET'],
  '/operations/cancel': ['POST'],
  '/files': ['GET'],
  '/files/content': ['GET', 'PUT'],
  '/screenshot': ['GET'],
  '/surface': ['POST'],
  '/takeover/status': ['GET'],
  '/takeover/start': ['POST'],
  '/takeover/input': ['POST'],
  '/takeover/end': ['POST'],
  '/execute': ['POST'],
  '/execute-with-frame': ['POST'],
  '/shell/cancel': ['POST'],
};
const requestHeaders = [
  'authorization',
  'content-type',
  'x-openbot-worker-instance',
  'x-openbot-control-origin',
  'x-openbot-action-id',
  'x-openbot-desktop-session',
  'x-openbot-desktop-generation',
  'x-openbot-screen-id',
  'x-openbot-screen-revision',
  'x-openbot-workspace-scope',
  'x-openbot-operation-id',
] as const;
const responseHeaders = [
  'content-type',
  'x-frame-width',
  'x-frame-height',
  'x-computer-surface',
  'x-captured-at',
] as const;
const errorBody = (error: string) => JSON.stringify({ error });

function limitBytes(limit: number, exceeded: () => void) {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        exceeded();
        callback(new Error('bridge body limit exceeded'));
      } else callback(null, chunk);
    },
  });
}

/** The only configurable destination is a loopback CubeProxy port, never a host or URL. */
export function createCubeWorkerBridge(options: {
  config: CubeWorkerBridgeConfig;
  configLoader?: () => Promise<CubeWorkerBridgeConfig>;
  upstreamPort?: number;
  requestTimeoutMs?: number;
}) {
  const config = validateConfig(options.config);
  const upstreamPort = options.upstreamPort ?? config.bridge?.upstreamPort;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  if (
    typeof upstreamPort !== 'number' ||
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw new Error('CubeProxy 端口无效。');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 180_000)
    throw new Error('CubeProxy 请求超时配置无效。');
  const active = new Set<() => void>();
  let closing = false;
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const reject = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(errorBody(message), () => req.destroy());
    };
    if (closing) return reject(503, '电脑转发器正在停止。');
    if (req.headers.origin !== undefined) return reject(403, '电脑转发器只接受服务端请求。');
    if (
      req.headers['cube-traffic-access-token'] !== undefined ||
      req.headers['e2b-traffic-access-token'] !== undefined
    )
      return reject(400, '不能覆盖固定实例的流量凭据。');
    if (
      typeof req.headers.authorization !== 'string' ||
      !/^Bearer [\x21-\x7e]{24,4096}$/.test(req.headers.authorization)
    )
      return reject(401, '缺少有效的 Worker Bearer 凭据。');
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : undefined;
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host ?? '')
    )
      return reject(421, '请求必须发送到本机电脑转发器。');
    for (const name of requestHeaders) {
      const count = req.rawHeaders.filter(
        (_v, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
      ).length;
      if (count > 1) return reject(400, '请求包含重复的鉴权或协议头。');
    }
    const raw = req.url ?? '';
    const path = raw.split('?')[0];
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const screenMatch = /^\/screens\/([^/]+)(\/.*)$/.exec(path);
    const routePath = screenMatch ? screenMatch[2] : path;
    const screenHeader = req.headers['x-openbot-screen-id'];
    const scopeHeader = req.headers['x-openbot-workspace-scope'];
    const revisionHeader = req.headers['x-openbot-screen-revision'];
    const lifecycleRoute =
      routePath === '/lifecycle' || /^\/lifecycle\/[a-f0-9-]{36}$/.test(routePath);
    const operationHeader = req.headers['x-openbot-operation-id'];
    if (
      (screenMatch && (!uuid.test(screenMatch[1]) || screenHeader !== screenMatch[1])) ||
      (!screenMatch && screenHeader !== undefined) ||
      (revisionHeader !== undefined &&
        (!screenMatch || typeof revisionHeader !== 'string' || !uuid.test(revisionHeader))) ||
      (lifecycleRoute &&
        (!screenMatch || typeof revisionHeader !== 'string' || typeof scopeHeader !== 'string')) ||
      (scopeHeader !== undefined && (typeof scopeHeader !== 'string' || !uuid.test(scopeHeader))) ||
      (operationHeader !== undefined &&
        (typeof operationHeader !== 'string' ||
          !uuid.test(operationHeader) ||
          ![
            '/execute',
            '/execute-with-frame',
            '/screenshot',
            '/takeover/input',
            '/files/content',
          ].includes(routePath)))
    )
      return reject(400, '画面或操作标识无效。');
    const screenRoutes = [
      '/health',
      '/screenshot',
      '/surface',
      '/takeover/status',
      '/takeover/start',
      '/takeover/input',
      '/takeover/end',
      '/execute',
      '/execute-with-frame',
      '/operations/cancel',
    ];
    const methods =
      screenMatch && routePath === '/lifecycle'
        ? ['POST']
        : screenMatch &&
            routePath.startsWith('/lifecycle/') &&
            uuid.test(routePath.slice('/lifecycle/'.length))
          ? ['GET']
          : (!screenMatch || screenRoutes.includes(routePath)) && Object.hasOwn(routes, routePath)
            ? routes[routePath]
            : undefined;
    if (!methods) return reject(404, '不支持的 Worker 路径。');
    if (!methods.includes(req.method ?? '')) return reject(405, '不支持的 Worker 方法。');
    const actionId = req.headers['x-openbot-action-id'];
    if (
      actionId !== undefined &&
      (routePath !== '/execute' ||
        typeof actionId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(actionId))
    )
      return reject(400, '电脑动作标识无效。');
    const desktopId = req.headers['x-openbot-desktop-session'];
    const desktopGeneration = req.headers['x-openbot-desktop-generation'];
    if (
      (desktopId !== undefined || desktopGeneration !== undefined) &&
      ![desktopId, desktopGeneration].every(
        (value) =>
          typeof value === 'string' &&
          value.length === 36 &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),
      )
    )
      return reject(400, '远程桌面会话标识无效。');
    const parsed = new URL(raw, 'http://127.0.0.1');
    const keys = [...parsed.searchParams.keys()];
    if (
      parsed.hash ||
      keys.some((key) => key !== 'path') ||
      keys.length > 1 ||
      (keys.length && !routePath.startsWith('/files'))
    )
      return reject(400, 'Worker 查询参数无效。');
    if (
      req.method === 'GET' &&
      (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
    )
      return reject(400, '读取请求不能包含请求体。');
    const requestLimit = lifecycleRoute
      ? 16_384
      : ['/shell/cancel', '/operations/cancel'].includes(routePath)
        ? 1024
        : req.method === 'PUT'
          ? MAX_FILE_TRANSFER_BYTES
          : 256 * 1024;
    if (Number(req.headers['content-length'] ?? 0) > requestLimit)
      return reject(413, '电脑请求超过大小限制。');
    let upstream: ReturnType<typeof request> | undefined;
    let upstreamResponse: import('node:http').IncomingMessage | undefined;
    let settled = false;
    let responseStarted = false;
    const fail = (status: number, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(shutdown);
      req.unpipe(input);
      input.destroy();
      upstreamResponse?.destroy();
      output?.destroy();
      upstream?.destroy();
      if (res.destroyed) return;
      if (responseStarted || res.headersSent) res.destroy();
      else reject(status, message);
    };
    const input = limitBytes(requestLimit, () => fail(413, '电脑请求超过大小限制。'));
    let output: Transform | undefined;
    const shutdown = () => fail(503, '电脑转发器正在停止。');
    const timer = setTimeout(() => fail(504, '远程电脑请求超时。'), requestTimeoutMs);
    timer.unref();
    active.add(shutdown);
    input.on('error', () => fail(413, '电脑请求超过大小限制。'));
    req.once('aborted', () => fail(499, '电脑请求已取消。'));
    req.once('error', () => fail(499, '电脑请求已取消。'));
    res.once('error', () => fail(499, '电脑请求已取消。'));
    res.once('close', () => {
      if (!res.writableFinished) fail(499, '电脑请求已取消。');
    });
    res.once('finish', () => {
      settled = true;
      clearTimeout(timer);
      active.delete(shutdown);
      if (!req.complete) {
        req.unpipe(input);
        input.destroy();
        upstream?.destroy();
        req.destroy();
      }
    });
    // Resolve one validated snapshot per request. Never reuse an old credential
    // after a failed reload or let a late loader forward after cancellation.
    let snapshot = config;
    try {
      if (options.configLoader) snapshot = validateConfig(await options.configLoader());
      if (
        snapshot.sandboxID !== config.sandboxID ||
        snapshot.domain !== config.domain ||
        snapshot.bridge?.listenPort !== config.bridge?.listenPort ||
        snapshot.bridge?.upstreamPort !== config.bridge?.upstreamPort
      )
        throw new Error('fixed target changed');
    } catch {
      return fail(503, '电脑转发器私有配置不可用，请检查固定实例配置。');
    }
    if (settled || closing || req.aborted || res.destroyed) return shutdown();
    const headers: IncomingHttpHeaders = {
      host: `3002-${snapshot.sandboxID}.${snapshot.domain}`,
      'cube-traffic-access-token': snapshot.trafficAccessToken,
    };
    for (const name of requestHeaders) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    // Only fixed, selected headers cross the boundary. No cookies, forwarded hosts,
    // client proxy credentials, connection headers, or redirects are propagated.
    try {
      upstream = request({
        hostname: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: raw,
        headers,
        agent: false,
      });
    } catch {
      return fail(502, '无法连接远程电脑代理。');
    }
    upstream.on('error', () => fail(502, '无法连接远程电脑代理。'));
    upstream.once('response', (incoming) => {
      upstreamResponse = incoming;
      if (settled) return incoming.destroy();
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) return fail(502, '远程电脑代理返回了不允许的跳转。');
      const responseLimit = lifecycleRoute
        ? 16_384
        : routePath === '/files/content'
          ? MAX_FILE_TRANSFER_BYTES
          : 32 * 1024 * 1024;
      if (
        incoming.headers['content-encoding'] ||
        Number(incoming.headers['content-length'] ?? 0) > responseLimit
      )
        return fail(502, '远程电脑响应超过限制或编码不受支持。');
      res.statusCode = status;
      for (const name of responseHeaders) {
        const value = incoming.headers[name];
        if (typeof value === 'string') res.setHeader(name, value);
      }
      // Stream bodies with native pipe backpressure; never buffer a whole file.
      output = limitBytes(responseLimit, () => fail(502, '远程电脑响应超过大小限制。'));
      output.on('error', () => fail(502, '远程电脑响应超过大小限制。'));
      incoming.once('error', () => fail(502, '远程电脑响应中断。'));
      incoming.once('aborted', () => fail(502, '远程电脑响应中断。'));
      output.once('data', () => {
        responseStarted = true;
      });
      incoming.pipe(output).pipe(res);
    });
    req.pipe(input).pipe(upstream);
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(15_000, requestTimeoutMs);
  server.maxConnections = 128;
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('checkContinue', (_req, res) => {
    res.writeHead(417, { Connection: 'close' });
    res.end();
  });
  return {
    server,
    async close() {
      closing = true;
      for (const stop of active) stop();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    console.error(
      '用法：node scripts/run.mjs scripts/cube-worker-bridge.ts --config <私有配置文件>',
    );
    process.exitCode = 1;
  } else {
    try {
      const configPath = resolve(args[1]);
      const config = await loadCubeWorkerBridgeConfig(configPath);
      if (!config.bridge)
        throw new Error('请在私有配置中填写 bridge.listenPort 和 bridge.upstreamPort。');
      const bridge = createCubeWorkerBridge({
        config,
        configLoader: () => loadCubeWorkerBridgeConfig(configPath),
      });
      bridge.server.on('error', () => {
        console.error('无法启动本机电脑转发器，请检查私有配置中的监听端口。');
        process.exitCode = 1;
      });
      bridge.server.listen(config.bridge.listenPort, '127.0.0.1', () => {
        console.log('OpenBot Cube Worker Bridge: ready on configured loopback listener');
      });
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void bridge.close();
        });
    } catch (error) {
      console.error(error instanceof Error ? error.message : '无法启动本机电脑转发器。');
      process.exitCode = 1;
    }
  }
}
