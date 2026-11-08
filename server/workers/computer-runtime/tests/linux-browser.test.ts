import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLinuxBrowserEngine } from '../linux-browser.js';
import { browserLeaseJournal } from '../linux-browser-leases.js';
import { LoginContext, latch } from './browser-login.fixture.js';
import { LocalComputer } from '../../computer-worker/index.js';

function configuration() {
  const id = randomUUID();
  return {
    id,
    manifestPath: `/opt/openbot/desktop/sessions/${id}/manifest.json`,
    session: { id, generation: randomUUID() },
  };
}
async function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'linux-browser-'));
  const launches: any[] = [],
    contexts: LoginContext[] = [],
    cleaned: string[] = [];
  const scope = randomUUID();
  let proxies = 0,
    closed = 0;
  const engine = createLinuxBrowserEngine({
    interpreterPath: '/usr/bin/python3.11',
    launcherPath: '/opt/openbot/desktop-browser.py',
    workspaceScopeId: scope,
    stateDirectory: directory,
    probe: async () => {},
    cleanup: async (_screen, lease) => {
      cleaned.push(lease);
    },
    createProxy: async () => {
      proxies++;
      return {
        url: 'http://127.0.0.1:18000',
        close: async () => {
          closed++;
        },
      };
    },
    launchPersistentContext: async (profile, settings) => {
      launches.push({ profile, settings });
      const context = new LoginContext();
      contexts.push(context);
      return context.asContext();
    },
    ...overrides,
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return {
    engine,
    directory,
    scope,
    launches,
    contexts,
    cleaned,
    counts: () => ({ proxies, closed }),
  };
}
test('readonly status never launches; two pinned screens launch distinct profiles with fixed pipe helper', async (t) => {
  const f = await fixture(t),
    a = configuration(),
    b = configuration();
  assert.equal((await f.engine.screen(a).status!()).available, true);
  assert.deepEqual(f.counts(), { proxies: 0, closed: 0 });
  const first = await f.engine.screen(a).open(),
    second = await f.engine.screen(b).open();
  assert.notEqual(first.context, second.context);
  assert.notEqual(f.launches[0].profile, f.launches[1].profile);
  for (let i = 0; i < 2; i++) {
    const value = f.launches[i].settings,
      screen = [a, b][i];
    assert.equal(value.executablePath, '/usr/bin/python3.11');
    assert.equal(value.ignoreDefaultArgs, true);
    assert.equal(value.chromiumSandbox, true);
    assert.equal(value.headless, false);
    assert.ok(value.args.includes(screen.session.id));
    assert.ok(value.args.includes(screen.session.generation));
    assert.ok(value.args.includes(f.scope));
    assert.ok(value.args.includes('18000'));
    assert.deepEqual(Object.keys(value.env).sort(), ['LANG', 'PATH']);
    assert.ok(!value.args.includes('--no-sandbox'));
  }
  await f.engine.close();
  assert.equal(f.cleaned.length, 2);
  assert.deepEqual(f.counts(), { proxies: 2, closed: 2 });
  assert.deepEqual(await readdir(join(f.directory, 'leases')), []);
});
test('missing verified runtime advertises no browser and cannot start a proxy', async (t) => {
  const f = await fixture(t, {
    probe: async () => {
      throw new Error('missing display');
    },
  });
  const session = f.engine.screen(configuration());
  assert.equal((await session.status!()).available, false);
  await assert.rejects(session.open());
  assert.equal(f.counts().proxies, 0);
  const computer = new LocalComputer(join(f.directory, 'workspace'), undefined, {
    browserSession: session,
  });
  const state = await computer.refreshStatus();
  assert.ok(state.capabilities.every((value) => !value.startsWith('browser')));
});
test('unknown cleanup poisons the screen and retains durable lease for recovery', async (t) => {
  const f = await fixture(t, {
    cleanup: async () => {
      throw Object.assign(new Error('unknown'), { cleanupConfirmed: false });
    },
  });
  const screen = configuration(),
    session = f.engine.screen(screen);
  await session.open();
  await assert.rejects(session.close(), /unknown/);
  await assert.rejects(session.status!(), /需要维护/);
  assert.equal((await readdir(join(f.directory, 'leases'))).length, 1);
  assert.equal(f.counts().closed, 1);
  await assert.rejects(f.engine.recover(screen), /unknown/);
});
test('restart checks old cleanup receipt before launching and does not start during recovery', async (t) => {
  const f = await fixture(t),
    screen = configuration(),
    lease = randomUUID();
  await browserLeaseJournal(join(f.directory, 'leases'), f.scope).write(screen, 'initial', lease);
  await f.engine.recover(screen);
  assert.deepEqual(f.cleaned, [lease]);
  assert.equal(f.launches.length, 0);
  await f.engine.screen(screen).open();
  assert.equal(f.launches.length, 1);
});
test('cancel during launch waits for actual context and cleanup before releasing the transition', async (t) => {
  const gate = latch(),
    entered = latch(),
    cleanupGate = latch(),
    cleanupEntered = latch();
  const context = new LoginContext();
  const f = await fixture(t, {
    launchPersistentContext: async () => {
      entered.resolve();
      await gate.promise;
      return context.asContext();
    },
    cleanup: async () => {
      cleanupEntered.resolve();
      await cleanupGate.promise;
    },
  });
  const abort = new AbortController(),
    session = f.engine.screen(configuration());
  let done = false;
  const opening = session.prepareDesktop!({ signal: abort.signal }).finally(() => {
    done = true;
  });
  void opening.catch(() => {});
  await entered.promise;
  abort.abort();
  assert.equal(done, false);
  gate.resolve();
  await cleanupEntered.promise;
  assert.equal(context.closed, true);
  assert.equal(done, false);
  cleanupGate.resolve();
  await assert.rejects(opening);
  await assert.rejects(session.status!(), /需要维护/);
});
