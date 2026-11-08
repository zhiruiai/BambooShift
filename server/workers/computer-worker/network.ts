import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectSocket, isIP, type Socket } from 'node:net';
import { workerControlOrigin } from './protocol.js';
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Permit only global unicast IPv6, excluding documentation and IPv4 tunnels.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^2001:(db8|0:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}

function allowedBrowserOrigins(): Set<string> {
  const controlPorts = new Set(
    [
      '3000',
      '3001',
      '3002',
      '5173',
      '5174',
      process.env.PORT,
      process.env.OPENBOT_PORT,
      process.env.OPENBOT_WORKER_PORT,
    ].filter(Boolean),
  );
  return new Set(
    (process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS ?? '')
      .split(',')
      .filter(Boolean)
      .map((origin) => {
        const url = new URL(origin.trim());
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash ||
          controlPorts.has(url.port)
        )
          throw new Error('浏览器测试例外不能包含控制面端口、路径或凭据。');
        return url.origin;
      }),
  );
}

export async function resolveBrowserTarget(
  url: URL,
  allowed = allowedBrowserOrigins(),
): Promise<{ address: string; port: number }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('浏览器网络只允许 HTTP(S)。');
  const publicOrigin = process.env.OPENBOT_PUBLIC_ORIGIN;
  if (publicOrigin) {
    const normalize = (hostname: string) => hostname.toLowerCase().replace(/\.$/, '');
    if (normalize(url.hostname) === normalize(new URL(publicOrigin).hostname))
      throw new Error('浏览器禁止访问 OpenBot 控制台域名，任何端口和测试白名单均不能覆盖。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const resolved = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!resolved.length) throw new Error('无法解析目标地址。');
  if (
    !allowed.has(url.origin) &&
    (resolved.some((item) => !isPublicAddress(item.address)) || ![80, 443].includes(port))
  )
    throw new Error('浏览器禁止访问本机、内网、元数据服务和控制面。');
  return { address: resolved[0].address, port };
}

/** A pinned-address egress proxy: redirects and subrequests cannot bypass host checks. */
export async function createBrowserNetworkProxy() {
  const allowed = allowedBrowserOrigins();
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '');
      const target = await resolveBrowserTarget(url, allowed);
      if (url.protocol !== 'http:') throw new Error('HTTPS requires CONNECT.');
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: url.host,
      };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        {
          hostname: target.address,
          port: target.port,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          timeout: 30_000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('Connection timed out')));
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Browser connection failed.');
      });
      res.once('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    } catch (error: any) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', async (req, client, head) => {
    try {
      const url = new URL(`https://${req.url}`);
      const target = await resolveBrowserTarget(url, allowed);
      const upstream = connectSocket({ host: target.address, port: target.port });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
  );
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
