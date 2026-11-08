import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
const require = createRequire(import.meta.url);
const token = 'a'.repeat(43),
  workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = 'owner-a';
const workspace = {
  id: workspaceId,
  name: '研究空间',
  kind: 'personal',
  role: 'owner',
  status: 'active',
};
const preview = {
  token,
  revision: 'reviewed-publication',
  audience: 'public',
  blueprint: {
    version: 1,
    profile: {
      name: '研究 Bot',
      role: '查证',
      instructions: '标记来源',
      description: '',
      avatar: 'leaf',
      color: '#8a61bf',
    },
    skills: [],
    routines: [{ title: '早报', prompt: '整理新闻', schedule: 'daily:09:00', enabled: true }],
  },
};
const receipt = {
  requestId: '',
  agentId: 'installed-bot',
  conversationId: 'installed-dm',
  skillIds: [],
  routineIds: [],
  createdAt: '2026-11-05T00:00:00Z',
};
const installed = {
  agents: [{ ...preview.blueprint.profile, id: receipt.agentId }],
  conversations: [{ id: receipt.conversationId, isGroup: false, agentIds: [receipt.agentId] }],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) || null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function nodes(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => nodes(item, match));
  return [...(match(node) ? [node] : []), ...nodes(node.props?.children, match)];
}
function words(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(words).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return words(node.props?.children);
}
const codes = new Map<string, string>();
async function mount(
  transport: typeof fetch,
  options: {
    store?: ReturnType<typeof storage>;
    identity?: () => unknown;
    preview?: typeof preview | null;
    teamPage?: boolean;
    onPendingRevision?: (revision?: string) => void;
  } = {},
) {
  const sourceName = options.teamPage ? 'TeamPage' : 'BotTemplatePage';
  let code = codes.get(sourceName);
  if (!code) {
    const file = resolve(`web/src/platform/${sourceName}.tsx`);
    const result = await build({
      stdin: {
        contents:
          (await readFile(file, 'utf8')) +
          `\nexport { ${options.teamPage ? 'TeamPage' : 'TemplateImportForm'} as Tested };`,
        sourcefile: file,
        resolveDir: dirname(file),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
      loader: { '.css': 'empty' },
    });
    code = result.outputFiles[0].text;
    codes.set(sourceName, code);
  }
  let cursor = 0,
    dirty = true,
    tree: any;
  const slots: any[] = [],
    effects: Array<() => void> = [],
    navigations: string[] = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (value: any) => {
          const next = typeof value === 'function' ? value(slots[index].value) : value;
          if (!Object.is(next, slots[index].value)) {
            slots[index].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(value: any) {
      return (slots[cursor++] ||= { current: value });
    },
    useEffect(effect: () => any, deps?: unknown[]) {
      const index = cursor++,
        before = slots[index];
      if (!before || !deps || deps.some((value, i) => !Object.is(value, before.deps?.[i]))) {
        const slot = { deps, cleanup: before?.cleanup };
        slots[index] = slot;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
  const module = { exports: {} as any };
  const window = new EventTarget() as any;
  window.location = {
    pathname: `/templates/${token}`,
    assign: (url: string) => navigations.push(url),
  };
  window.sessionStorage = options.store || storage();
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    window,
    fetch: transport,
    crypto: webcrypto,
    Error,
    TypeError,
    DOMException,
    AbortController,
    AbortSignal,
    URL,
    Response,
    Blob,
    Event,
  });
  const props = {
    session: { authenticated: true, user: { id: userId, name: '研究者' }, workspaces: [workspace] },
    token,
    target: workspace,
    targets: [workspace],
    workspaceId,
    preview: options.preview === null ? undefined : options.preview || preview,
    disabled: false,
    identity: options.identity || (() => ({ userId, workspaceId })),
    onTarget: () => {},
    onMode: () => {},
    onPendingRevision: options.onPendingRevision || (() => {}),
  };
  return {
    navigations,
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          cursor = 0;
          dirty = false;
          tree = expandPureViews(module.exports.Tested(props));
        }
        for (const effect of effects.splice(0)) effect();
        await new Promise((done) => setImmediate(done));
        if (!dirty && !effects.length) return;
      }
      throw Error('Effects did not settle');
    },
    get tree() {
      return tree;
    },
    button(label: string) {
      const button = nodes(
        tree,
        (node) => node.type === 'button' && words(node).trim() === label,
      )[0];
      assert.ok(button, label);
      return button;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

test('actual public import form submits reviewed revision and waits for authoritative Bot/DM before navigation', async () => {
  const bootstrap = deferred<Response>();
  const bodies: any[] = [];
  const calls: string[] = [];
  const h = await mount((async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), userId);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return json({ ...receipt, requestId: body.requestId });
    }
    return bootstrap.promise;
  }) as typeof fetch);
  await h.flush();
  assert.equal(calls.length, 0);
  const input = nodes(h.tree, (node) => node.type === 'input')[0];
  input.props.onChange({ target: { value: '我的研究 Bot' } });
  await h.flush();
  h.tree.props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].name, '我的研究 Bot');
  assert.equal(bodies[0].expectedRevision, 'reviewed-publication');
  assert.equal(bodies[0].routineMode, 'pause');
  assert.equal(bodies[0].token, token);
  assert.equal(h.navigations.length, 0);
  assert.equal(calls[1], `/api/workspaces/${workspaceId}/bootstrap`);
  bootstrap.resolve(json(installed));
  await h.flush();
  assert.deepEqual(h.navigations, [`/w/${workspaceId}?conversation=installed-dm`]);
  h.unmount();
});

test('actual form restores unknown request even when public template was revoked, reads receipt without another POST', async () => {
  const store = storage();
  let body: any,
    posts = 0;
  const first = await mount(
    (async (_url, init) => {
      posts++;
      body = JSON.parse(String(init?.body));
      throw new TypeError('lost');
    }) as typeof fetch,
    { store },
  );
  await first.flush();
  first.tree.props.onSubmit({ preventDefault() {} });
  await first.flush();
  first.unmount();
  assert.equal(posts, 1);
  const reads: string[] = [];
  const recovered = await mount(
    (async (url, init) => {
      assert.equal(init?.method, 'GET');
      reads.push(String(url));
      return json(
        String(url).endsWith('/bootstrap') ? installed : { ...receipt, requestId: body.requestId },
      );
    }) as typeof fetch,
    { store, preview: null },
  );
  await recovered.flush();
  assert.equal(reads.length, 0);
  assert.equal(nodes(recovered.tree, (node) => node.type === 'input')[0].props.value, body.name);
  await recovered.button('检查创建结果').props.onClick();
  await recovered.flush();
  assert.equal(reads[0], `/api/workspaces/${workspaceId}/bot-template-imports/${body.requestId}`);
  assert.equal(posts, 1);
  assert.equal(recovered.navigations.length, 1);
  recovered.unmount();
});

test('actual form ignores an old-account installation response and does not fetch new-account bootstrap or navigate', async () => {
  let currentUser = userId,
    calls = 0;
  const response = deferred<Response>();
  const h = await mount(
    (async () => {
      calls++;
      return response.promise;
    }) as typeof fetch,
    { identity: () => ({ userId: currentUser, workspaceId }) },
  );
  await h.flush();
  h.tree.props.onSubmit({ preventDefault() {} });
  await h.flush();
  currentUser = 'different-user';
  response.resolve(json({ ...receipt, requestId: webcrypto.randomUUID() }));
  await h.flush();
  assert.equal(calls, 1);
  assert.equal(h.navigations.length, 0);
  h.unmount();
});

test('actual reopened import distinguishes original reviewed revision from the latest publication', async () => {
  const store = storage();
  store.setItem(
    `openbot:template-import:${userId}:${workspaceId}:${token}`,
    JSON.stringify({
      kind: 'import',
      token,
      requestId: webcrypto.randomUUID(),
      expectedRevision: 'previous-publication',
      name: '此前确认的 Bot',
      routineMode: 'preserve',
    }),
  );
  let frozenRevision: string | undefined;
  const h = await mount(
    (async () => {
      throw Error('no automatic request');
    }) as typeof fetch,
    {
      store,
      onPendingRevision: (value) => {
        frozenRevision = value;
      },
    },
  );
  await h.flush();
  assert.equal(frozenRevision, 'previous-publication');
  assert.match(words(h.tree), /正在恢复此前确认的旧版本/);
  assert.match(words(h.tree), /新版内容不会用于这次请求/);
  assert.equal(nodes(h.tree, (node) => node.type === 'input')[0].props.value, '此前确认的 Bot');
  assert.equal(nodes(h.tree, (node) => node.type?.name === 'RoutineInstallChoice').length, 0);
  h.unmount();
});

test('actual personal-space TeamPage exposes sharing policy without querying unsupported team membership API', async () => {
  let calls = 0;
  const h = await mount(
    (async () => {
      calls++;
      throw Error('personal team endpoint must not be called');
    }) as typeof fetch,
    { teamPage: true },
  );
  await h.flush();
  assert.equal(calls, 0);
  const policy = nodes(h.tree, (node) => node.type?.name === 'BotSharingPolicy')[0];
  assert.ok(policy);
  assert.equal(policy.props.kind, 'personal');
  assert.equal(policy.props.workspaceId, workspaceId);
  assert.equal(policy.props.userId, userId);
  assert.match(words(h.tree), /管理个人空间的模板分享/);
  assert.doesNotMatch(words(h.tree), /正在读取成员|暂时无法读取空间信息/);
  h.unmount();
});
