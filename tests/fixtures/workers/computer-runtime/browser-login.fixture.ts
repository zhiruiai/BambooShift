import { EventEmitter } from 'node:events';
import type { BrowserContext, Page } from 'playwright-core';

export type LoginState = Awaited<ReturnType<BrowserContext['storageState']>>;
export const cookie = (value: string) => ({
  name: 'session',
  value,
  domain: 'example.test',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
});
export class LoginContext extends EventEmitter {
  state: LoginState = { cookies: [], origins: [] };
  closed = false;
  binding?: (source: { frame: { url(): string } }) => unknown;
  pageList: LoginPage[] = [];
  asContext() {
    return this as unknown as BrowserContext;
  }
  async storageState() {
    if (this.closed) throw new Error('closed');
    return structuredClone(this.state);
  }
  async addCookies(values: LoginState['cookies']) {
    for (const value of values) {
      this.state.cookies = this.state.cookies.filter(
        (old) =>
          old.name !== value.name ||
          old.path !== value.path ||
          old.domain !== value.domain ||
          'partitionKey' in old,
      );
      if (value.expires !== 1) this.state.cookies.push(structuredClone(value));
    }
  }
  async exposeBinding(_name: string, callback: LoginContext['binding']) {
    this.binding = callback;
  }
  async addInitScript() {}
  async route() {}
  pages() {
    return this.pageList.filter((page) => !page.closed) as unknown as Page[];
  }
  async newPage() {
    const page = new LoginPage();
    this.pageList.push(page);
    this.emit('page', page);
    return page as unknown as Page;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pageList) await page.close();
    this.emit('close');
  }
}
class LoginPage extends EventEmitter {
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return 'about:blank';
  }
  async opener() {
    return null;
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}
export function latch() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
