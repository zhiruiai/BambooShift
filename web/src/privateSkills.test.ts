import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppConnectionScope } from './appConnections';
import { parsePrivateSkillShelf, privateSkillTargets, type PrivateSkill } from './privateSkills';
import { harness, json } from './testSupport/appsFixture';

const workspaceId = 'fixture-space';
const userId = 'fixture-owner';
const root = `/api/workspaces/${workspaceId}/private-skills`;
const agents = [
  { id: 'source', name: '来源 Bot' },
  { id: 'target', name: '目标一' },
  { id: 'other', name: '目标二' },
];
const original: PrivateSkill = {
  id: 'reviewed-skill',
  sourceAgentId: 'source',
  sourceAgentName: '来源 Bot',
  name: '核对报告',
  description: '来源说明',
  content: '当前原件的完整技能文本',
  version: 2,
  revision: 'b'.repeat(64),
  available: true,
  enabledAgentIds: [],
};
const previous: PrivateSkill = {
  ...original,
  content: '已经固定的旧版全文',
  version: 1,
  revision: 'a'.repeat(64),
  available: false,
  enabledAgentIds: ['target'],
};
const shelf = (...skills: PrivateSkill[]) => ({ agents, skills });
const actor = { workspaceId, userId };

function panel(transport: typeof fetch) {
  const scope = createAppConnectionScope({ ...actor, identity: () => actor, fetch: transport });
  return harness(
    'web/src/components/apps/PrivateSkillsPanel.tsx',
    'SkillsHarness',
    { scope, onBusyChange() {} },
    transport,
    {},
    '\nfunction SkillsHarness(props: any) { return PrivateSkillsPanel(props); }',
  );
}
function reviewVersion(ui: Awaited<ReturnType<typeof panel>>, version: number) {
  const label =
    version === 2
      ? '核对报告版本 2 · 来源 来源 Bot当前原件 · 已启用的 Bot 0 位'
      : '核对报告版本 1 · 来源 来源 Bot已固定的旧版或不可用版本 · 已启用的 Bot 1 位';
  ui.button(label).props.onClick();
}
async function selectTarget(ui: Awaited<ReturnType<typeof panel>>, targetId = 'target') {
  ui.field('目标 Bot').props.onChange({ target: { value: targetId } });
  await ui.flush();
}

test('private shelf preserves distinct exact revisions of a single source ID and excludes the source Bot', () => {
  assert.deepEqual(parsePrivateSkillShelf(shelf(original, previous)), shelf(original, previous));
  assert.equal(parsePrivateSkillShelf(shelf(original, original)), undefined);
  assert.equal(parsePrivateSkillShelf(shelf({ ...original, revision: 'malformed' })), undefined);
  assert.deepEqual(
    privateSkillTargets(shelf(original), original).map((agent) => agent.id),
    ['target', 'other'],
  );
  assert.deepEqual(
    privateSkillTargets(shelf(previous), previous).map((agent) => agent.id),
    ['target'],
  );
});

test('reviewing current or pinned content keeps the exact revision and refreshes each change', async () => {
  let current = shelf(original, previous);
  const requests: { method: string | undefined; body?: unknown }[] = [];
  const ui = await panel(async (path, init) => {
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), userId);
    if (init?.method === 'GET') {
      assert.equal(path, root);
      requests.push({ method: 'GET' });
      return json(current);
    }
    assert.equal(path, `${root}/${original.id}/bots/target`);
    assert.equal(init?.method, 'PUT');
    const body = JSON.parse(String(init?.body));
    requests.push({ method: 'PUT', body });
    current = shelf({ ...original, enabledAgentIds: body.enabled ? ['target'] : [] });
    return body.enabled ? json({ enabled: true }) : json({ error: 'Response lost' }, 503);
  });
  try {
    await ui.flush();
    reviewVersion(ui, 2);
    await ui.flush();
    assert.match(ui.copy, /当前原件的完整技能文本/);
    assert.ok(ui.copy.includes(original.revision));
    assert.equal(ui.button('启用此版本').props.disabled, true);
    await selectTarget(ui);
    assert.equal(ui.maybeButton('启用此版本'), undefined);
    ui.button('查看已安装版本').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /已经固定的旧版全文/);
    assert.ok(ui.copy.includes(previous.revision));
    ui.button('停用此版本').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /技能版本已停用/);
    reviewVersion(ui, 2);
    await ui.flush();
    await selectTarget(ui);
    ui.button('启用此版本').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /技能版本已启用/);
    assert.match(ui.copy, /已为 目标一 启用/);
    assert.deepEqual(requests, [
      { method: 'GET' },
      { method: 'PUT', body: { enabled: false, expectedRevision: previous.revision } },
      { method: 'GET' },
      { method: 'PUT', body: { enabled: true, expectedRevision: original.revision } },
      { method: 'GET' },
    ]);
  } finally {
    ui.dispose();
  }
});

test('a changed target invalidates a retained enable action and failed reconciliation locks writes', async () => {
  let saved = false;
  let lostRead = false;
  let puts = 0;
  const ui = await panel(async (path, init) => {
    if (init?.method === 'PUT') {
      assert.equal(path, `${root}/${original.id}/bots/other`);
      puts++;
      saved = true;
      lostRead = true;
      return json({ error: 'Response lost' }, 503);
    }
    if (lostRead) return json({}, 503);
    return json(shelf({ ...original, enabledAgentIds: saved ? ['other'] : [] }));
  });
  try {
    await ui.flush();
    reviewVersion(ui, 2);
    await ui.flush();
    await selectTarget(ui);
    const stale = ui.button('启用此版本').props.onClick;
    await selectTarget(ui, 'other');
    stale();
    await ui.flush();
    assert.equal(puts, 0);
    const enable = ui.button('启用此版本').props.onClick;
    enable();
    await ui.flush();
    assert.match(ui.copy, /暂未确认更改是否生效/);
    assert.equal(ui.button('启用此版本').props.disabled, true);
    enable();
    await ui.flush();
    assert.equal(puts, 1);
    lostRead = false;
    ui.button('刷新技能').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /技能版本已启用/);
    assert.equal(ui.button('停用此版本').props.disabled, false);
  } finally {
    ui.dispose();
  }
});
