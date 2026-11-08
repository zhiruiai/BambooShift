import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamSkillPublication } from '../../shared/team-skills';
import type { BotAgent, Skill } from '../../shared/types';
import { all, harness } from './testSupport/creationFlowFixture';

const author = { id: 'author', name: '研究员' } as BotAgent;
const recipient = { id: 'recipient', name: '审核员' } as BotAgent;
const skill: Skill = {
  id: 'skill',
  agentId: author.id,
  name: '核对公开资料',
  description: '先确认日期',
  content: '只使用已授权的资料，核对日期和出处。',
  version: 3,
  status: 'active',
  createdAt: '2026-11-07T00:00:00Z',
};
const published: TeamSkillPublication = {
  id: 'publication',
  revision: 'revision-one',
  version: 1,
  name: skill.name,
  description: skill.description,
  content: skill.content,
  updatedAt: '2026-11-07T00:00:00Z',
  source: { agentId: author.id, agentName: author.name, skillId: skill.id, version: skill.version },
};

test('team skills preview precedes publishing and import submits the exact reviewed revision', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const opened: string[] = [];
  const ui = await harness('web/src/components/TeamSkillsView.tsx', 'TeamSkillsView', {
    access: {
      agents: [author, recipient],
      request: async (path: string, method = 'GET', body: unknown) => {
        calls.push({
          path,
          method,
          body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
        });
        if (method === 'GET') return [];
        if (path === '/team-skills') return published;
        return {
          ...skill,
          agentId: recipient.id,
          teamSource: { id: published.id, revision: published.revision },
        };
      },
      onImported: (id: string) => opened.push(id),
    },
    skills: [skill, { ...skill, id: 'proposed', name: '未经审核', status: 'proposed' }],
    readOnly: false,
    onBack() {},
  });
  try {
    await ui.flush();
    assert.doesNotMatch(ui.copy, /未经审核/);
    ui.button('发布到团队').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /敏感信息/);
    assert.deepEqual(calls, [
      { path: '/team-skills', method: 'GET', body: undefined },
      { path: '/team-skills/import-targets', method: 'GET', body: undefined },
    ]);
    ui.button('发布到团队').props.onClick();
    await ui.flush();
    assert.deepEqual(calls[2], {
      path: '/team-skills',
      method: 'POST',
      body: { skillId: skill.id, expectedRevision: null },
    });
    assert.equal(ui.button('导入为待审核').props.disabled, true);
    const select = all(ui.tree, (node) => node.type === 'select')[0];
    select.props.onChange({ target: { value: recipient.id } });
    await ui.flush();
    ui.button('导入为待审核').props.onClick();
    await ui.flush();
    assert.deepEqual(calls[3], {
      path: '/team-skills/publication/import',
      method: 'POST',
      body: { agentId: recipient.id, expectedRevision: published.revision },
    });
    assert.deepEqual(opened, [recipient.id]);
  } finally {
    ui.dispose();
  }
});

test('members import a pinned team skill into their personal Bot without team management controls', async () => {
  const personal = { workspaceId: 'personal-space', workspaceName: '我的空间' };
  const copied = { id: 'personal-bot', name: '我的 Bot' };
  const imports: unknown[] = [];
  const ui = await harness('web/src/components/TeamSkillsView.tsx', 'TeamSkillsView', {
    access: {
      agents: [author, recipient],
      request: async (path: string, method = 'GET', body?: unknown) => {
        if (path === '/team-skills/import-targets') return [{ ...personal, agents: [copied] }];
        if (method === 'GET') return [published];
        imports.push(JSON.parse(JSON.stringify(body)));
        return {
          ...skill,
          agentId: copied.id,
          teamSource: { id: published.id, revision: published.revision },
        };
      },
      onImported() {
        assert.fail('Personal import must not switch the team skill manager to a foreign Bot');
      },
    },
    skills: [skill],
    readOnly: true,
    onBack() {},
  });
  try {
    await ui.flush();
    assert.match(ui.copy, /核对公开资料 · v1 · 研究员/);
    assert.doesNotMatch(ui.copy, /发布到团队|撤回发布|审核员/);
    assert.equal(ui.button('导入为待审核').props.disabled, true);
    const select = all(ui.tree, (node) => node.type === 'select')[0];
    select.props.onChange({ target: { value: `${personal.workspaceId}/${copied.id}` } });
    await ui.flush();
    ui.button('导入为待审核').props.onClick();
    await ui.flush();
    assert.deepEqual(imports, [
      {
        agentId: copied.id,
        targetWorkspaceId: personal.workspaceId,
        expectedRevision: published.revision,
      },
    ]);
    assert.match(ui.copy, /已为 我的空间 的 我的 Bot 保存待审核技能/);
  } finally {
    ui.dispose();
  }
});

test('a personal publication has neutral origin and never matches a team-local source for synchronization', async () => {
  const remote: TeamSkillPublication = {
    ...published,
    source: { origin: 'personal', version: 3 },
  };
  const imports: unknown[] = [];
  const ui = await harness('web/src/components/TeamSkillsView.tsx', 'TeamSkillsView', {
    access: {
      agents: [author, recipient],
      request: async (path: string, method = 'GET', body?: unknown) => {
        if (method === 'GET') return path === '/team-skills' ? [remote] : [];
        imports.push(JSON.parse(JSON.stringify(body)));
        return {
          ...skill,
          agentId: author.id,
          teamSource: { id: remote.id, revision: remote.revision },
        };
      },
      onImported() {},
    },
    skills: [skill],
    readOnly: false,
    onBack() {},
  });
  try {
    await ui.flush();
    assert.match(ui.copy, /核对公开资料 · v1 · 来自个人技能库/);
    assert.equal(ui.button('发布到团队').props.disabled, false);
    const select = all(ui.tree, (node) => node.type === 'select')[0];
    select.props.onChange({ target: { value: author.id } });
    await ui.flush();
    ui.button('导入为待审核').props.onClick();
    await ui.flush();
    assert.deepEqual(imports, [{ agentId: author.id, expectedRevision: remote.revision }]);
  } finally {
    ui.dispose();
  }
});

test('a member can withdraw only an exact publication authorized by the catalog', async () => {
  const memberPublication: TeamSkillPublication = {
    ...published,
    canWithdraw: true,
    source: { origin: 'personal', version: 3 },
  };
  const calls: unknown[] = [];
  const ui = await harness('web/src/components/TeamSkillsView.tsx', 'TeamSkillsView', {
    access: {
      agents: [author],
      request: async (path: string, method = 'GET', body?: unknown) => {
        if (method === 'GET') return path === '/team-skills' ? [memberPublication] : [];
        calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
      },
      onImported() {},
    },
    skills: [skill],
    readOnly: true,
    onBack() {},
  });
  try {
    await ui.flush();
    assert.doesNotMatch(ui.copy, /发布到团队|阻止重新发布/);
    ui.button('撤回发布').props.onClick();
    await ui.flush();
    assert.deepEqual(calls, []);
    assert.equal(ui.button('撤回发布').props.disabled, false);
    ui.button('撤回发布').props.onClick();
    await ui.flush();
    assert.deepEqual(calls, [
      {
        path: `/team-skills/${published.id}/unpublish`,
        body: { expectedRevision: published.revision },
      },
    ]);
    assert.match(ui.copy, /本团队暂无已发布技能/);
  } finally {
    ui.dispose();
  }
});
