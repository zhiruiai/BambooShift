import assert from 'node:assert/strict';
import test from 'node:test';
import { all, deferred, harness } from './testSupport/appsFixture';
import type { RemoteMcpPreview } from './remoteMcpImport';

const source = JSON.stringify({
  servers: {
    Docs: {
      url: 'https://DOCS.example.com:443/mcp',
      token: 'SYNTHETIC_SECRET',
      headers: { Authorization: 'SYNTHETIC_HEADER' },
      env: { KEY: 'SYNTHETIC_ENV' },
    },
    local: { command: 'SYNTHETIC_COMMAND', url: 'https://local.example.com/' },
    credentials: { url: 'https://user:SYNTHETIC_PASSWORD@example.com/' },
    query: { url: 'https://example.com/?token=SYNTHETIC_QUERY' },
  },
});
const preview: RemoteMcpPreview = {
  candidates: [{ name: 'Docs', url: 'https://docs.example.com/mcp' }],
  skipped: 3,
  error: null,
};
async function setup(
  onInspect: (input: unknown) => Promise<RemoteMcpPreview>,
  onApply = (_: unknown) => {},
) {
  const ui = await harness(
    'web/src/components/apps/RemoteMcpImport.tsx',
    'ImportFixture',
    { disabled: false, hasDraft: false, draftVersion: {}, onInspect, onApply },
    async () => {
      throw Error('No unscoped network request is permitted.');
    },
    { TextEncoder },
    '\nconst ImportFixture = RemoteMcpImport;',
  );
  await ui.flush();
  async function begin() {
    ui.button('导入 MCP 配置').props.onClick();
    await ui.flush();
    ui.field('MCP 配置 JSON').props.onChange({ target: { value: source } });
    await ui.flush();
    const task = ui.button('识别远程服务').props.onClick();
    await ui.flush();
    return { task };
  }
  return { ui, begin };
}

test('preview receives only names and addresses; source clears before response; apply requires selection', async () => {
  const pending = deferred<RemoteMcpPreview>();
  const sent: unknown[] = [],
    applied: unknown[] = [];
  const { ui, begin } = await setup(
    async (input) => {
      sent.push(input);
      return pending.promise;
    },
    (value) => applied.push(value),
  );
  const { task } = await begin();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { candidates: [{ name: 'Docs', url: 'https://DOCS.example.com:443/mcp' }], skipped: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC|token|headers|env|command/);
  assert.equal(ui.field('MCP 配置 JSON').props.value, '');
  assert.equal(ui.button('识别远程服务').props.disabled, true);
  pending.resolve(preview);
  await task;
  await ui.flush();
  assert.equal(ui.button('填入名称和地址').props.disabled, true);
  ui.field('远程服务').props.onChange({ target: { value: preview.candidates[0].url } });
  await ui.flush();
  ui.button('填入名称和地址').props.onClick();
  await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), preview.candidates);
  ui.dispose();
});

for (const action of ['cancel', 'unmount', 'revoke']) {
  test(`a late preview cannot reappear after ${action}`, async () => {
    const pending = deferred<RemoteMcpPreview>();
    const { ui, begin } = await setup(() => pending.promise);
    const { task } = await begin();
    if (action === 'cancel') ui.button('取消导入').props.onClick();
    else if (action === 'unmount') ui.dispose();
    else ui.setProps({ disabled: true });
    await ui.flush();
    pending.resolve(preview);
    await task;
    await ui.flush();
    assert.equal(all(ui.tree, (node) => node.type === 'select').length, 0);
    assert.doesNotMatch(ui.copy, /https:\/\/docs\.example\.com/);
    ui.dispose();
  });
}

test('reopening an import ignores the previous response and starts without a selection', async () => {
  const pending = [deferred<RemoteMcpPreview>(), deferred<RemoteMcpPreview>()];
  let calls = 0;
  const { ui, begin } = await setup(() => pending[calls++].promise);
  const first = await begin();
  ui.button('取消导入').props.onClick();
  await ui.flush();
  const second = await begin();
  pending[0].resolve(preview);
  await first.task;
  await ui.flush();
  assert.equal(ui.field('MCP 配置 JSON').props.value, '');
  assert.equal(all(ui.tree, (node) => node.type === 'select').length, 0);
  pending[1].resolve(preview);
  await second.task;
  await ui.flush();
  assert.equal(ui.field('远程服务').props.value, '');
  ui.dispose();
});

test('replacement approval follows the exact draft version, including a previously captured click', async () => {
  const applied: unknown[] = [];
  const { ui, begin } = await setup(
    async () => preview,
    (value) => applied.push(value),
  );
  const initialDraft = { name: 'Original draft', token: 'SYNTHETIC_MANUAL_TOKEN' };
  ui.setProps({ hasDraft: true, draftVersion: initialDraft });
  await ui.flush();
  const { task } = await begin();
  await task;
  await ui.flush();
  ui.field('远程服务').props.onChange({ target: { value: preview.candidates[0].url } });
  await ui.flush();
  ui.button('填入名称和地址').props.onClick();
  await ui.flush();
  const previousApproval = ui.button('替换当前表单').props.onClick;
  ui.setProps({ draftVersion: { ...initialDraft, name: 'New unsaved work' } });
  await ui.flush();
  assert.equal(ui.maybeButton('替换当前表单'), undefined);
  previousApproval();
  await ui.flush();
  assert.deepEqual(applied, [], 'a captured approval cannot overwrite newer work');
  assert.ok(ui.button('替换当前表单'));
  ui.setProps({ hasDraft: true });
  await ui.flush();
  ui.button('替换当前表单').props.onClick();
  await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), preview.candidates);
  ui.dispose();
});

test('old server 404 and rejected preview show bounded errors without reflecting response secrets', async () => {
  for (const status of [404, 500]) {
    const { ui, begin } = await setup(async () => {
      throw { status, message: 'SYNTHETIC_BACKEND_SECRET' };
    });
    const { task } = await begin();
    await task;
    await ui.flush();
    assert.match(ui.copy, status === 404 ? /需要更新/ : /暂时无法预览/);
    assert.match(ui.copy, /手动填写/);
    assert.doesNotMatch(ui.copy, /SYNTHETIC/);
    assert.equal(ui.field('MCP 配置 JSON').props.value, '');
    ui.dispose();
  }
});

test('a malformed successful response cannot silently create candidates', async () => {
  for (const value of [
    { candidates: [], skipped: 0, error: null },
    { ...preview, error: 'empty' },
    { ...preview, candidates: [...preview.candidates, ...preview.candidates] },
  ]) {
    const { ui, begin } = await setup(async () => value as RemoteMcpPreview);
    const { task } = await begin();
    await task;
    await ui.flush();
    assert.match(ui.copy, /暂时无法预览/);
    assert.equal(all(ui.tree, (node) => node.type === 'select').length, 0);
    ui.dispose();
  }
});
