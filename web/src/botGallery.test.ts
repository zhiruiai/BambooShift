import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfirmedBotInstall } from './botTemplates';
import {
  all,
  component,
  harness,
  storage,
  userId,
  workspaceId,
} from './testSupport/creationFlowFixture';
import { starterBotPacks, starterTeamMemberPacks } from './starterSkillPacks';
import { starterTemplates } from './starterTemplates';
import teamTemplates from '../../shared/team-starter-templates.json';

const catalogFile = 'web/src/components/templates/TemplateLibrary.tsx';
const teamFile = 'web/src/components/team/TeamStarterPicker.tsx';

test('every built-in Bot and newly created team role previews localized real skill packs', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    for (const bot of starterTemplates()) {
      const packs = starterBotPacks(bot.id, language);
      assert.ok(packs.length, bot.id);
      assert.equal(new Set(packs.map((pack) => pack.id)).size, packs.length);
      assert.ok(
        packs.every(
          (pack) => pack.name && pack.description && pack.instructions && pack.checklist.length,
        ),
      );
    }
    for (const team of teamTemplates[language])
      for (const member of team.draft.members)
        assert.ok(starterTeamMemberPacks(team.id, member.key, language).length, member.key);
  }
});

test('Bot Gallery exposes built-in Bots, read-only teams and published templates in one place', async () => {
  const ui = await harness(catalogFile, 'TemplateLibrary', {
    owner: false,
    scope: { ticket: () => 1, current: () => true },
    onClose() {},
  });
  const picker = await harness(teamFile, 'TeamStarterPicker', { disabled: false });
  try {
    await ui.flush();
    assert.equal(component(ui.tree, 'Dialog').props.title, 'Bot 广场');
    assert.ok(component(ui.tree, 'StarterTemplateCatalog'));
    ui.button('团队模板').props.onClick();
    await ui.flush();
    assert.ok(component(ui.tree, 'TeamStarterPicker'));
    await picker.flush();
    picker.button('产品发布小组').props.onClick();
    await picker.flush();
    assert.match(picker.copy, /包含技能/);
    assert.match(
      picker.copy,
      new RegExp(
        starterTeamMemberPacks('launch', teamTemplates['zh-CN'][0].draft.members[0].key, 'zh-CN')[0]
          .name,
      ),
    );
    assert.equal(
      all(picker.tree, (node) => node.props?.className === 'smart-team-actions').length,
      0,
    );
    assert.ok(ui.button('用户发布'));
  } finally {
    picker.dispose();
    ui.dispose();
  }
});

test('direct use retries the same stock request across reopening and keeps authoritative skill rows', async () => {
  const packs = starterBotPacks('research', 'zh-CN');
  const profile = starterTemplates().find((entry) => entry.id === 'research')!.profile;
  const agent = { ...profile, id: 'created-bot', status: 'idle' as const };
  const result: ConfirmedBotInstall = {
    agent,
    conversation: {
      id: 'created-chat',
      title: agent.name,
      agentIds: [agent.id],
      isGroup: false,
      pinned: false,
      unread: 0,
      updatedAt: '',
    },
    skills: packs.map((pack, index) => ({
      id: `skill-${index}`,
      agentId: agent.id,
      name: pack.id,
      description: pack.description,
      content: pack.instructions,
      status: 'active',
      version: 1,
      createdAt: '',
      skillPackage: {
        format: 'agent-skills',
        root: pack.id,
        frontmatter: {
          name: pack.id,
          description: pack.description,
          metadata: { title: pack.name },
        },
        files: [],
      },
    })),
  };
  const submitted: unknown[] = [];
  const opened: ConfirmedBotInstall[] = [];
  const sessionStorage = storage();
  const props = {
    workspaceId,
    userId,
    owner: true,
    scope: {
      ticket: () => 1,
      current: () => true,
      async request(path: string, method: string, body: unknown) {
        assert.equal(path, '/starter-bots');
        assert.equal(method, 'POST');
        submitted.push(JSON.parse(JSON.stringify(body)));
        if (submitted.length === 1) throw new Error('Response lost');
        return result;
      },
    },
    onCreated: (value: ConfirmedBotInstall) => opened.push(value),
    onClose() {},
  };
  for (const attempt of [1, 2]) {
    const ui = await harness(catalogFile, 'TemplateLibrary', props, { window: { sessionStorage } });
    try {
      await ui.flush();
      const install = component(ui.tree, 'StarterTemplateCatalog').props.onInstall;
      await install('research', 'zh-CN');
      await ui.flush();
      assert.equal(opened.length, attempt === 1 ? 0 : 1);
      if (attempt === 1)
        assert.match(component(ui.tree, 'StarterTemplateCatalog').props.installError, /重试/);
    } finally {
      ui.dispose();
    }
  }
  assert.deepEqual(submitted[0], submitted[1]);
  assert.match((submitted[0] as { requestId: string }).requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(opened, [result]);
});
