import assert from 'node:assert/strict';
import test from 'node:test';
import { action, all, app, compile, harness, json, text } from './testSupport/appsFixture';
import {
  choices,
  environment,
  memory,
  policyOptions,
  receipt,
} from './testSupport/appPolicyFixture';

const props = () => ({
  app: { ...app, id: 'connection-a' },
  userId: 'owner-a',
  workspaceId: 'workspace-a',
  canManage: true,
  onBusy() {},
});
test('actual panel shows only real readonly candidates and requires reconfirmation after parameters or scope changes', async () => {
  const posts: any[] = [];
  let options = policyOptions;
  const ui = await harness(
    'web/src/components/apps/AppPolicyPanel.tsx',
    'PolicyPanel',
    props(),
    async (url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return json(receipt(body.requestId));
      }
      return String(url).endsWith('/options') ? json(options) : json([]);
    },
    environment(),
  );
  await ui.flush();
  assert.match(ui.copy, /Read-only routine authorization/);
  assert.match(ui.copy, /Provider annotations do not prove/);
  assert.ok(
    !all(ui.tree, (node) => node.type === 'option').some((node) => text(node) === 'write_note'),
  );
  assert.equal(ui.button('Authorize this exact read').props.disabled, true);
  ui.field('Saved routine').props.onChange({ target: { value: 'routine-a' } });
  ui.field('Trusted read-only tool').props.onChange({ target: { value: 'read_notes' } });
  ui.field('Exact arguments').props.onChange({ target: { value: '{"query":"newer_than:1d"}' } });
  await ui.flush();
  ui.field('I trust this service').props.onChange({ target: { checked: true } });
  await ui.flush();
  assert.equal(ui.button('Authorize this exact read').props.disabled, false);
  ui.field('Exact arguments').props.onChange({ target: { value: '{"query":"newer_than:2d"}' } });
  await ui.flush();
  assert.equal(ui.button('Authorize this exact read').props.disabled, true);
  ui.field('I trust this service').props.onChange({ target: { checked: true } });
  await ui.flush();
  options = { ...policyOptions, catalogRevision: 'catalog-r2' };
  ui.button('Check authorizations').props.onClick();
  await ui.flush();
  assert.equal(ui.button('Authorize this exact read').props.disabled, true);
  assert.equal(posts.length, 0);
  ui.field('I trust this service').props.onChange({ target: { checked: true } });
  await ui.flush();
  ui.form().props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].catalogRevision, 'catalog-r2');
  assert.equal(posts[0].arguments.query, 'newer_than:2d');
  ui.dispose();
});

test('actual panel uses Chinese copy, retains unknown grant and blocks a stale owner click', async () => {
  let posts = 0;
  const ui = await harness(
    'web/src/components/apps/AppPolicyPanel.tsx',
    'PolicyPanel',
    props(),
    async (url, init) => {
      if (init?.method === 'POST') {
        posts++;
        throw new TypeError('lost response');
      }
      return choices(url);
    },
    environment(memory(), 'zh-CN'),
  );
  await ui.flush();
  const selects = all(ui.tree, (node) => node.type === 'select');
  selects[0].props.onChange({ target: { value: 'routine-a' } });
  selects[1].props.onChange({ target: { value: 'read_notes' } });
  await ui.flush();
  all(ui.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange(
    { target: { checked: true } },
  );
  await ui.flush();
  const oldSubmit = ui.form().props.onSubmit;
  oldSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(posts, 1);
  assert.match(ui.copy, /核对|确认/);
  assert.ok(
    all(ui.tree, (node) => node.type === 'button').some((node) => text(node).includes('取消')),
  );
  ui.setProps({ userId: 'owner-b' });
  await ui.flush();
  oldSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(posts, 1);
  ui.dispose();
});

test('members never load owner policy choices, and audit card preserves issuer and ordinary approval permissions', async () => {
  let requests = 0;
  const ui = await harness(
    'web/src/components/apps/AppPolicyPanel.tsx',
    'PolicyPanel',
    { ...props(), canManage: false },
    async () => {
      requests++;
      return json([]);
    },
    environment(),
  );
  await ui.flush();
  assert.equal(ui.tree, null);
  assert.equal(requests, 0);
  ui.dispose();
  const policy = {
    kind: 'routine_read',
    policyId: '11111111-1111-4111-8111-111111111111',
    issuerUserId: 'owner-a',
    routineId: 'routine-a',
    routineTitle: '<script>Daily notes</script>',
    issuedAt: '2026-11-07T00:00:00Z',
  };
  const audited = {
    ...action,
    status: 'done',
    result: { text: 'Actual notes', isError: false },
    policy,
  };
  const module = await compile('web/src/components/AppActionCard.tsx', '', environment());
  assert.ok(module.parseAppAction(audited));
  assert.equal(
    module.parseAppAction({
      ...audited,
      source: {
        kind: 'shared_bot',
        shareId: policy.policyId,
        botName: 'Shared',
        ownerName: 'Publisher',
      },
    }),
    undefined,
  );
  const card = await harness(
    'web/src/components/AppActionCard.tsx',
    'AppActionContent',
    {
      action: audited,
      owner: true,
      workspaceId: 'workspace-a',
      userId: 'owner-a',
      onChanged: async () => {},
      onApps() {},
    },
    async () => {
      throw new Error('No decision for completed audit');
    },
    environment(),
  );
  await card.flush();
  assert.match(card.copy, /Authorized by you/);
  assert.match(card.copy, /Actual notes/);
  assert.equal(all(card.tree, (node) => node.type === 'script').length, 0);
  assert.equal(
    all(card.tree, (node) => node.type === 'button' && /Approve/.test(text(node))).length,
    0,
  );
  card.dispose();
});
