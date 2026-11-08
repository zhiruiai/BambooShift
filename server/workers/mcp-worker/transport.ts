import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as remoteFetch } from 'undici';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isPublicAddress } from './network-policy.js';
import type { ConnectedAppTool, ConnectedAppResult } from '../../../shared/app-connections.js';

export interface AppEndpoint {
  url: string;
  token?: string;
}
export interface AppClient {
  tools(): Promise<ConnectedAppTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<ConnectedAppResult>;
  close(): Promise<void>;
}
export type AppClientFactory = (
  endpoint: AppEndpoint,
  signal: AbortSignal,
  options?: { authorize?: () => Promise<void> },
) => Promise<AppClient>;
export class AppTransportError extends Error {
  constructor(
    public kind: 'auth' | 'network' | 'protocol' | 'blocked',
    message: string,
  ) {
    super(message);
  }
}

export function parseAppEndpoint(value: unknown, publicOrigin?: string): URL {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('请输入有效的 HTTPS 应用服务地址。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 HTTPS 应用服务地址。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new Error('应用地址须使用 HTTPS 默认端口，不能包含登录信息、查询参数或片段。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host)))
    throw new Error('应用连接只支持公网服务地址。');
  const own = publicOrigin;
  if (own && new URL(own).hostname.replace(/\.$/, '') === url.hostname.replace(/\.$/, ''))
    throw new Error('不能把平台自身连接为应用服务。');
  return url;
}

const fail = (kind: AppTransportError['kind']) =>
  new AppTransportError(
    kind,
    kind === 'auth'
      ? '应用需要重新授权。请检查凭据后再连接。'
      : kind === 'blocked'
        ? '应用地址不可访问。请使用公网 HTTPS 服务，且不要设置跳转。'
        : kind === 'protocol'
          ? '应用返回了不支持的响应。请确认这是 MCP 服务地址。'
          : '无法连接应用。请检查服务状态后重试。',
  );

/** Redact before truncating, including credentials embedded in serialized JSON. */
export function redactAppCredential(text: string, token?: string): string {
  if (!token) return text;
  const encoded = JSON.stringify(token).slice(1, -1);
  return text.split(encoded).join('[凭据已隐藏]').split(token).join('[凭据已隐藏]');
}

async function resolveAppHost(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(fail('network'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([lookup(host, { all: true }), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** No browser, ambient proxy, local process, OAuth navigation, or arbitrary headers. */
export async function openAppClient(
  endpoint: AppEndpoint,
  signal: AbortSignal,
  options: {
    /** Server-only live task/decision grant, checked before each actual dispatch. */
    authorize?: () => Promise<void>;
    /** Constructor-only test seam; never populated from a request or environment. */
    testOrigin?: string;
    publicOrigin?: string;
  } = {},
): Promise<AppClient> {
  const testUrl = options.testOrigin ? new URL(endpoint.url) : undefined;
  const isFixture =
    !!testUrl &&
    testUrl.origin === options.testOrigin &&
    testUrl.protocol === 'http:' &&
    testUrl.hostname === '127.0.0.1' &&
    !testUrl.username &&
    !testUrl.password &&
    !testUrl.search &&
    !testUrl.hash;
  const url = isFixture ? testUrl! : parseAppEndpoint(endpoint.url, options.publicOrigin);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolveAppHost(
    host,
    AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  );
  signal.throwIfAborted();
  if (
    !addresses.length ||
    (!isFixture && addresses.some((entry) => !isPublicAddress(entry.address)))
  )
    throw fail('blocked');
  // Pin the validated addresses for the entire connection to prevent DNS rebinding.
  const dispatcher = new Agent({
    connections: 2,
    maxHeaderSize: 16384,
    headersTimeout: 15000,
    bodyTimeout: 30000,
    connect: {
      timeout: 10000,
      lookup: ((_hostname: string, settings: { all?: boolean }, callback: Function) => {
        if (settings.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }) as any,
    },
  });
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(45000)]);
  const client = new Client(
    { name: 'openbot', version: '0.1.0' },
    { capabilities: {}, listMaxPages: 4, versionNegotiation: { mode: 'auto' } },
  );
  let closed = false;
  let terminating: AbortSignal | undefined;
  let transportFailure: AppTransportError | undefined;
  const reject = (kind: AppTransportError['kind']) => {
    transportFailure = fail(kind);
    return transportFailure;
  };
  const sanitized = (cause: unknown) =>
    cause instanceof AppTransportError ? cause : transportFailure || fail('protocol');
  const close = async () => {
    if (closed) return;
    closed = true;
    // End only this SDK-created session, with a separate short cleanup budget.
    // This releases server resources; it cannot roll back an already sent action.
    if (transport.sessionId) {
      terminating = AbortSignal.timeout(1500);
      await transport.terminateSession().catch(() => {});
      terminating = undefined;
    }
    lifetime.abort();
    await client.close().catch(() => {});
    await dispatcher.destroy();
  };
  const transport = new StreamableHTTPClientTransport(url, {
    ...(endpoint.token ? { authProvider: { token: async () => endpoint.token! } } : {}),
    requestInit: { redirect: 'manual' },
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const target = new URL(input);
      if (target.href !== url.href) throw reject('blocked');
      const requestSignal =
        init?.method === 'DELETE' && terminating
          ? terminating
          : init?.signal
            ? AbortSignal.any([combined, init.signal])
            : combined;
      requestSignal.throwIfAborted();
      // Session cleanup must remain possible after the human grant is revoked.
      if (!(init?.method === 'DELETE' && terminating)) await options.authorize?.();
      let response;
      try {
        response = await remoteFetch(target, {
          ...(init as any),
          dispatcher,
          redirect: 'manual',
          signal: requestSignal,
        });
      } catch {
        throw reject('network');
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw reject('auth');
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw reject('blocked');
      }
      if (Number(response.headers.get('content-length') || '0') > 1024 * 1024) {
        await response.body?.cancel();
        throw reject('protocol');
      }
      // Bound both JSON and SSE, including decoded/chunked bodies and error pages.
      let total = 0;
      const source = response.body as unknown as ReadableStream<Uint8Array> | null;
      const bounded = source?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > 1024 * 1024) throw reject('protocol');
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(bounded || null, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers([...response.headers]),
      });
    },
  });
  try {
    await client.connect(transport, { signal: combined, timeout: 15000 });
    return {
      async tools() {
        try {
          const result = await client.listTools(undefined, { signal: combined, timeout: 15000 });
          if (result.tools.length > 64) throw fail('protocol');
          return result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema as Record<string, unknown>,
            ...(tool.annotations && {
              annotations: Object.fromEntries(
                (['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
                  .filter((key) => typeof tool.annotations?.[key] === 'boolean')
                  .map((key) => [key, tool.annotations?.[key]]),
              ),
            }),
          }));
        } catch (cause) {
          throw sanitized(cause);
        }
      },
      async call(name, args) {
        try {
          const result = await client.callTool(
            { name, arguments: args },
            { signal: combined, timeout: 30000 },
          );
          const chunks = result.content.flatMap((item) =>
            item.type === 'text'
              ? [item.text]
              : ['[此应用返回了非文本内容，当前连接未读取该内容。]'],
          );
          if (result.structuredContent) chunks.push(JSON.stringify(result.structuredContent));
          const full = redactAppCredential(chunks.join('\n'), endpoint.token);
          return {
            isError: result.isError === true,
            text: full.length > 48000 ? `${full.slice(0, 48000)}\n[结果过长，已截断。]` : full,
          };
        } catch (cause) {
          throw sanitized(cause);
        }
      },
      close,
    };
  } catch (error) {
    const safe = sanitized(error);
    await close();
    throw safe;
  }
}
