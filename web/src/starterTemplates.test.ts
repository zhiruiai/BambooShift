import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { starterCategoryLabel, starterTemplates, filterStarterTemplates } from './starterTemplates';
import { botProfileProblem, type BotProfileDraft } from './botProfiles';
import { initializeLanguage } from './i18n';
import {
  all,
  click,
  component,
  fixture,
  harness,
  json,
  receipt,
  storage,
  text,
  userId,
  workspaceId,
  writes,
  until,
} from './testSupport/creationFlowFixture';

test('nine original bilingual profiles are valid independent starting points without portable secrets or scheduled work', () => {
  const asset = (path: string) =>
    readFileSync(new URL(`../../${path}/bot-starter-templates.json`, import.meta.url));
  assert.deepEqual(asset('mobile/assets/templates'), asset('shared'));
  const language = initializeLanguage();
  try {
    for (const locale of ['zh-CN', 'en'] as const) {
      language.setLanguage(locale);
      const items = starterTemplates();
      assert.deepEqual(
        items.map((item) => [item.id, item.profile.avatar, item.profile.color]),
        [
          ['research', 'orb', '#9363ed'],
          ['writing', 'leaf', '#0ac987'],
          ['coordination', 'arch', '#3294f9'],
          ['engineering', 'gem', '#ff871f'],
          ['organization', 'drop', '#e65e91'],
          ['briefing', 'spark', '#b96b22'],
          ['support', 'arch', '#32766d'],
          ['analysis', 'gem', '#187f9a'],
          ['recruitment', 'arch', '#8b5eaa'],
        ],
      );
      assert.equal(starterCategoryLabel('engineering'), locale === 'en' ? 'Engineering' : '编程');
      for (const item of items) {
        assert.equal(botProfileProblem(item.profile), '');
        assert.deepEqual(Object.keys(item.profile).sort(), [
          'avatar',
          'avatarImageId',
          'color',
          'description',
          'instructions',
          'name',
          'role',
        ]);
        assert.equal(item.profile.avatarImageId, null);
        assert.ok(item.profile.instructions.length > 200);
        assert.doesNotMatch(
          JSON.stringify(item),
          /apiKey|token|endpoint|installCount|authorId|https?:\/\//,
        );
      }
      assert.equal(
        filterStarterTemplates(items, locale === 'en' ? 'evidence' : '证据', 'research').length,
        1,
      );
      assert.equal(filterStarterTemplates(items, 'no-such-template', 'all').length, 0);
      items[0].profile.instructions = 'Local edit';
      assert.notEqual(starterTemplates()[0].profile.instructions, 'Local edit');
    }
  } finally {
    language.setLanguage('zh-CN');
  }
});

test('catalog search, category, full instruction preview and explicit selection issue no requests', async () => {
  let requests = 0;
  const chosen: BotProfileDraft[] = [];
  const ui = await harness(
    'web/src/components/StarterTemplateCatalog.tsx',
    'StarterTemplateCatalog',
    { canCreate: true, current: () => true, onChoose: (p: BotProfileDraft) => chosen.push(p) },
    {
      fetch: async () => {
        requests++;
        throw Error('No network expected');
      },
    },
  );
  try {
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.props?.className?.startsWith('starter-card')).length, 9);
    const search = all(ui.tree, (n) => n.type === 'input')[0];
    search.props.onChange({ target: { value: '不存在的模板' } });
    await ui.flush();
    assert.match(ui.copy, /没有匹配/);
    search.props.onChange({ target: { value: '' } });
    await ui.flush();
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({
      target: { value: 'engineering' },
    });
    await ui.flush();
    const cards = all(ui.tree, (n) => n.props?.className?.startsWith('starter-card'));
    assert.equal(cards.length, 1);
    cards[0].props.onClick();
    await ui.flush();
    const preview = component(ui.tree, 'BotTemplatePreview');
    assert.match(preview.props.blueprint.profile.instructions, /代码约定/);
    assert.deepEqual(Array.from(preview.props.blueprint.skills), []);
    assert.deepEqual(Array.from(preview.props.blueprint.routines), []);
    assert.equal(chosen.length, 0);
    await click(ui, '使用模板并编辑');
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].name, '编程助手');
    assert.equal(requests, 0);
  } finally {
    ui.dispose();
  }
});

test('read-only viewers can inspect while stale or unmounted catalog callbacks cannot apply a profile', async () => {
  let live = true,
    selected = 0;
  const ui = await harness(
    'web/src/components/StarterTemplateCatalog.tsx',
    'StarterTemplateCatalog',
    {
      canCreate: false,
      current: () => live,
      onChoose: () => {
        selected++;
      },
    },
  );
  try {
    await ui.flush();
    all(ui.tree, (n) => n.props?.className?.startsWith('starter-card'))[0].props.onClick();
    await ui.flush();
    assert.match(ui.copy, /只有空间拥有者/);
    assert.equal(
      all(ui.tree, (n) => n.type === 'button' && text(n) === '使用模板并编辑').length,
      0,
    );
    ui.setProps({ canCreate: true });
    await ui.flush();
    const apply = ui.button('使用模板并编辑').props.onClick;
    live = false;
    apply();
    assert.equal(selected, 0);
    live = true;
    ui.setProps({ canCreate: false });
    await ui.flush();
    apply();
    assert.equal(selected, 0);
    ui.setProps({ canCreate: true });
    await ui.flush();
    const final = ui.button('使用模板并编辑').props.onClick;
    ui.dispose();
    final();
    assert.equal(selected, 0);
  } finally {
    ui.dispose();
  }
});

test('selecting a starter fills editable profile fields; only the existing confirmed durable creation submits it', async () => {
  const f = await fixture();
  try {
    const oldSubmit = all(f.ui.tree, (n) => n.type === 'form')[0].props.onSubmit;
    await click(f.ui, '从原创模板开始');
    oldSubmit({ preventDefault() {} });
    await f.ui.flush();
    assert.equal(writes(f.calls).length, 0);
    const picker = component(f.ui.tree, 'StarterTemplateCatalog');
    picker.props.onChoose(starterTemplates()[0].profile);
    await f.ui.flush();
    const fields = f.profile();
    assert.equal(fields.props.draft.name, '研究员');
    assert.match(fields.props.draft.instructions, /研究助手/);
    assert.equal(writes(f.calls).length, 0);
    fields.props.onChange({ ...fields.props.draft, name: 'My reviewed researcher' });
    await f.ui.flush();
    await f.submit();
    await until(f.ui, () => writes(f.calls).length === 1);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(writes(f.calls)[0].body.kind, 'bot');
    assert.equal(writes(f.calls)[0].body.profile.name, 'My reviewed researcher');
    assert.equal(f.opened.length, 0);
    assert.ok(f.calls.every((c) => c.headers.get('X-OpenBot-Expected-User') === userId));
    assert.doesNotMatch(
      f.calls.map((c) => c.path).join(' '),
      /routines|messages|connections|\/agents/,
    );
  } finally {
    f.ui.dispose();
  }
});

test('choosing another template preserves an edited draft until discard confirmation and unknown creation stays locked', async () => {
  const f = await fixture({
    transport(call, fallback) {
      if (call.method === 'POST') throw new TypeError('Synthetic lost response');
      return fallback();
    },
  });
  try {
    await f.fill('Preserved edit');
    await click(f.ui, '从原创模板开始');
    component(f.ui.tree, 'StarterTemplateCatalog').props.onChoose(starterTemplates()[1].profile);
    await f.ui.flush();
    assert.equal(f.profile().props.draft.name, 'Preserved edit');
    assert.match(f.ui.copy, /未保存|放弃|更改|修改/);
    const leaveButtons = all(f.ui.tree, (n) => n.type === 'button' && text(n).includes('放弃'));
    assert.ok(leaveButtons.length);
    leaveButtons[0].props.onClick();
    await f.ui.flush();
    assert.equal(f.profile().props.draft.name, '写作编辑');
    await f.submit();
    await until(f.ui, () => writes(f.calls).length === 1);
    assert.equal(writes(f.calls).length, 1);
    assert.ok(f.ui.button('从原创模板开始').props.disabled);
    const retained = component(f.ui.tree, 'BotProfileFields').props.onChange;
    retained({ ...f.profile().props.draft, name: 'Should not replace pending' });
    await f.ui.flush();
    assert.equal(f.profile().props.draft.name, '写作编辑');
  } finally {
    f.ui.dispose();
  }
});

test('library separates originals from published templates and hands a fixed profile to the original bot-only form', async () => {
  let live = true,
    requests = 0,
    opened = 0;
  const scope = {
    ticket: () => 1,
    current: () => live,
    request: async () => {
      requests++;
      return [];
    },
  };
  const props = {
    owner: true,
    team: false,
    workspaceId,
    userId,
    scope,
    onClose() {},
    onBack() {},
    onManage() {},
    onCreated() {
      opened++;
    },
    onChanged() {},
    onOpenPublic() {},
  };
  const ui = await harness(
    'web/src/components/templates/TemplateLibrary.tsx',
    'TemplateLibrary',
    props,
    {
      fetch: async () => {
        requests++;
        return json([]);
      },
    },
  );
  try {
    await ui.flush();
    assert.equal(requests, 0);
    assert.ok(ui.button('BambooShift 原创'));
    assert.ok(ui.button('用户发布'));
    const choose = component(ui.tree, 'StarterTemplateCatalog').props.onChoose;
    choose(starterTemplates()[2].profile);
    await ui.flush();
    const starter = component(ui.tree, 'StarterTemplateCreate');
    assert.equal(starter.props.profile.name, '项目协调员');
    assert.equal(opened, 0);
    assert.equal(requests, 0);
    starter.props.onBack();
    await ui.flush();
    live = false;
    choose(starterTemplates()[1].profile);
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.type?.name === 'StarterTemplateCreate').length, 0);
  } finally {
    ui.dispose();
  }
});

test('a library starter uses the existing create receipt and never offers unrelated group or planning modes', async () => {
  const calls: any[] = [];
  const ui = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    {
      agents: [],
      canCreateBot: true,
      botOnly: true,
      initialProfile: starterTemplates()[4].profile,
      userId,
      workspaceId,
      onClose() {},
      onCreated() {},
    },
    {
      window: { location: { pathname: `/w/${workspaceId}/` }, dispatchEvent() {} },
      sessionStorage: storage(),
      TextEncoder,
      Event,
      fetch: async (path: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ path, body });
        return json(receipt(body));
      },
    },
  );
  try {
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.props?.role === 'tab').length, 0);
    assert.equal(component(ui.tree, 'BotProfileFields').props.draft.name, '日程整理员');
    all(ui.tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    await ui.flush();
    await until(ui, () => calls.length === 1);
    await until(ui, () => ui.copy.includes('已创建'));
    assert.equal(calls.length, 1, ui.copy);
    assert.equal(calls[0].path, `/api/workspaces/${workspaceId}/creation-requests`);
    assert.equal(calls[0].body.kind, 'bot');
    assert.match(ui.copy, /已创建/);
  } finally {
    ui.dispose();
  }
});
