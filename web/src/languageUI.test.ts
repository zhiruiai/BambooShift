import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { languageFixture, languageHooks, nodes } from './testSupport/languageFixture';
import { agent } from './testSupport/botProfilesFixture';

const noHan = (markup: string) => assert.doesNotMatch(markup, /[\u3400-\u9fff]/);

test('real language select changes the shared language and html, while hidden or unmounted handlers cannot write', async () => {
  const hooks = languageHooks();
  const { api, root, values } = await languageFixture({ require: hooks.require });
  const render = (active: boolean) => hooks.render(() => api.LanguageSettings({ active }));
  let tree = render(true);
  const select = nodes(tree, (node) => node.type === 'select')[0];
  select.props.onChange({ target: { value: 'en' } });
  assert.equal(root.lang, 'en');
  assert.equal(JSON.parse(values.get('openbot-language')!).locale, 'en');
  tree = render(false);
  assert.equal(nodes(tree, (node) => node.type === 'select')[0].props.disabled, true);
  select.props.onChange({ target: { value: 'zh-CN' } });
  assert.equal(root.lang, 'en');
  render(true);
  hooks.dispose();
  select.props.onChange({ target: { value: 'zh-CN' } });
  assert.equal(root.lang, 'en');
});

test('actual settings, account, Bot profile, routine and computer views render English and preserve user text', async () => {
  const { api } = await languageFixture();
  api.initializeLanguage().setLanguage('en');
  const render = (component: any, props: any) =>
    renderToStaticMarkup(React.createElement(component, props));
  noHan(render(api.AppearanceSettings, { active: true }));
  noHan(render(api.AccountShell, { title: 'Sign in', operator: true, children: 'Access' }));
  const profile = {
    ...agent,
    name: 'User Bot',
    role: 'Research',
    description: 'Notes',
    instructions: 'User instructions',
  };
  const markup = render(api.BotProfileFields, { draft: profile, onChange() {} });
  assert.match(markup, /Persistent instructions/);
  noHan(markup);
  const personalText = '我的指令：不要翻译这段文字';
  const original = render(api.BotProfileFields, {
    draft: { ...profile, instructions: personalText },
    section: 'instructions',
    onChange() {},
  });
  assert.ok(original.includes(personalText));
  noHan(render(api.RemoteShellDetails, { payload: { command: 'pwd', path: '.' } }));
  noHan(
    render(api.RemoteShellResult, {
      result: { exitCode: null, resourceLimit: 'memory', stdout: '', stderr: '' },
    }),
  );
  noHan(render(api.RoutineDetails, { agents: [], routines: [], onClose() {} }));
  assert.match(api.routineScheduleLabel('weekly:1,2,3,4,5:09:00'), /Weekdays 09:00.*Beijing time/);
  assert.match(
    api.routineScheduleLabel('weekly:1,3:09:00', 'America/New_York'),
    /Mon, Wed.*America\/New_York/,
  );
  assert.equal(api.displayTimeZone('Asia/Shanghai'), 'Beijing time');
  const primary = {
    available: true,
    agentId: 'bot-a',
    checkIn: { enabled: true, time: '09:00', timeZone: 'bad/zone' },
  };
  assert.match(api.primaryBotSummary(primary, { id: 'chat-a' }), /time zone.*corrected/i);
  assert.match(api.calendarLabel('2026-11-05T12:00:00', '2026-11-07T12:00:00'), /Nov 5/);
  api.initializeLanguage().setLanguage('zh-CN');
  assert.equal(api.routineScheduleLabel('weekly:1,3:09:00'), '每周一、三 09:00 · 北京时间');
  assert.equal(api.displayTimeZone('Asia/Shanghai'), '北京时间');
});

test('changing locale rerenders actual Bot settings without replacing its unsaved configuration or revision', async () => {
  const hooks = languageHooks();
  const { api } = await languageFixture({ require: hooks.require });
  const props = {
    agent,
    workspaceId: 'space-a',
    userId: 'owner-a',
    readOnly: false,
    busy: false,
    deleteBlocked: '',
    boundScreen: false,
    skillCount: 0,
    fileCount: 0,
    onClose() {},
    onSaved() {},
    onDeleted() {},
    onComputer() {},
    onSkills() {},
    onFiles() {},
  };
  let model = hooks.render(() => api.useAgentSettingsContent(props));
  const profileFields = nodes(
    api.AgentSettingsContentView(model),
    (n) => n.type?.name === 'BotProfileFields',
  )[0];
  assert.ok(profileFields);
  profileFields.props.onChange({
    ...profileFields.props.draft,
    name: '未保存的名字',
    instructions: '仍是原文',
  });
  model = hooks.render(() => api.useAgentSettingsContent(props));
  api.initializeLanguage().setLanguage('en');
  const translated = hooks.render(() => api.useAgentSettingsContent(props));
  const fields = nodes(
    api.AgentSettingsContentView(translated),
    (n) => n.type?.name === 'BotProfileFields',
  )[0];
  assert.equal(fields.props.draft.name, '未保存的名字');
  assert.equal(fields.props.draft.instructions, '仍是原文');
  assert.equal(translated.base.configRevision, model.base.configRevision);
  hooks.dispose();
});

test('locale metadata changes request language but keeps its fixed expected account and workspace', async () => {
  const { api } = await languageFixture();
  const calls: Array<{ path: string; headers: Headers }> = [];
  const identity = { userId: 'owner-a', workspaceId: 'space-a' };
  const scope = api.createAppConnectionScope({
    ...identity,
    identity: () => identity,
    fetch: async (path: string, init: RequestInit) => {
      calls.push({ path, headers: new Headers(init.headers) });
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    },
  });
  api.initializeLanguage().setLanguage('en');
  await scope.request('/apps');
  assert.equal(calls[0].path, '/api/workspaces/space-a/apps');
  assert.equal(calls[0].headers.get('Accept-Language'), 'en');
  assert.equal(calls[0].headers.get('X-OpenBot-Expected-User'), 'owner-a');
  api.initializeLanguage().setLanguage('zh-CN');
  await scope.request('/apps');
  assert.equal(calls[1].headers.get('Accept-Language'), 'zh-CN');
  identity.userId = 'owner-b';
  await assert.rejects(scope.request('/apps'));
  assert.equal(calls.length, 2);
});
