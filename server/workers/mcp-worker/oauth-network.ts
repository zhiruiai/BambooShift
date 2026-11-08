import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as httpFetch } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/client';
import { isPublicAddress } from './network-policy.js';

export class AppOAuthProviderError extends Error {
  constructor(readonly kind: 'blocked' | 'auth' | 'protocol' | 'network') {
    super(
      kind === 'auth'
        ? '应用授权已失效，请重新登录授权。'
        : kind === 'blocked'
          ? '应用授权地址不可访问。请使用公网 HTTPS 服务，且不要设置跳转。'
          : kind === 'network'
            ? '暂时无法连接应用授权服务，请稍后重试。'
            : '应用返回了不支持的授权信息，请检查服务配置。',
    );
  }
}

export function oauthUrl(value: string, testOrigins: ReadonlySet<string> = new Set()): URL {
  let url: URL;
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    url = new URL(value);
  } catch {
    throw new AppOAuthProviderError('blocked');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const fixture = testOrigins.has(url.origin) && url.protocol === 'http:' && host === '127.0.0.1';
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!fixture &&
      (url.protocol !== 'https:' ||
        (url.port && url.port !== '443') ||
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        (isIP(host) && !isPublicAddress(host))))
  )
    throw new AppOAuthProviderError('blocked');
  return url;
}

/** One bounded OAuth operation, with a separate validated and pinned pool per origin. */
export class OAuthNetwork {
  readonly signal: AbortSignal;
  private agents = new Map<string, Promise<Agent>>();
  private failed?: AppOAuthProviderError;
  private requests = 0;
  private bytes = 0;
  private closed = false;
  constructor(
    private testOrigins: ReadonlySet<string>,
    signal: AbortSignal,
    private authorize?: () => Promise<void>,
    private publicOrigin?: string,
  ) {
    this.signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  }
  assertSafe() {
    if (this.failed) throw this.failed;
    if (this.closed || this.signal.aborted) throw new AppOAuthProviderError('network');
  }
  private reject(kind: AppOAuthProviderError['kind']): never {
    this.failed ??= new AppOAuthProviderError(kind);
    throw this.failed;
  }
  async validate(value: string, allowOwnMetadataDocument = false): Promise<URL> {
    this.assertSafe();
    let url: URL;
    try {
      url = oauthUrl(value, this.testOrigins);
    } catch {
      return this.reject('blocked');
    }
    const own = this.publicOrigin;
    if (!allowOwnMetadataDocument && own && new URL(own).hostname === url.hostname)
      return this.reject('blocked');
    await this.agent(url);
    this.assertSafe();
    return url;
  }
  private async agent(url: URL): Promise<Agent> {
    let pending = this.agents.get(url.origin);
    if (!pending) {
      pending = (async () => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
        let stop!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          stop = () => reject(new AppOAuthProviderError('network'));
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        });
        let addresses;
        try {
          addresses = await Promise.race([
            isIP(host)
              ? Promise.resolve([{ address: host, family: isIP(host) }])
              : lookup(host, { all: true }),
            cancelled,
          ]);
        } catch {
          return this.reject('network');
        } finally {
          signal.removeEventListener('abort', stop);
        }
        this.assertSafe();
        if (
          !addresses.length ||
          (!this.testOrigins.has(url.origin) &&
            addresses.some((entry) => !isPublicAddress(entry.address)))
        )
          return this.reject('blocked');
        return new Agent({
          connections: 2,
          maxHeaderSize: 16384,
          headersTimeout: 10000,
          bodyTimeout: 10000,
          connect: {
            timeout: 10000,
            lookup: ((_host: string, settings: { all?: boolean }, callback: Function) => {
              if (settings.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            }) as any,
          },
        });
      })();
      this.agents.set(url.origin, pending);
    }
    return pending;
  }
  fetch: FetchLike = async (input, init) => {
    this.assertSafe();
    if (++this.requests > 16) return this.reject('protocol');
    const target = await this.validate(String(input));
    const method = (init?.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return this.reject('blocked');
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(15000),
      ...(init?.signal ? [init.signal] : []),
    ]);
    let response;
    try {
      await this.authorize?.();
      response = await httpFetch(target, {
        ...(init as any),
        method,
        dispatcher: await this.agent(target),
        signal,
        redirect: 'manual',
      });
    } catch {
      return this.reject('network');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return this.reject('blocked');
    }
    if (Number(response.headers.get('content-length') || '0') > 1024 * 1024) {
      await response.body?.cancel();
      return this.reject('protocol');
    }
    let size = 0;
    const source = response.body as unknown as ReadableStream<Uint8Array> | null;
    const bounded = source?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          size += chunk.byteLength;
          this.bytes += chunk.byteLength;
          if (size > 1024 * 1024 || this.bytes > 2 * 1024 * 1024) this.reject('protocol');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(bounded || null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers([...response.headers]),
    });
  };
  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.agents.values()].map(async (pending) => (await pending).destroy()),
    );
  }
}
