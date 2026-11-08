import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandToken,
  composerCommands,
  matchingCommands,
  mentionToken,
  replaceCommand,
} from './workspace/composerCommands';
import { bot, peer, skill, composerFixture } from './testSupport/composerCommandsFixture';

test('command parsing uses the collapsed caret, preserves both sides, and rejects URLs and path fragments', () => {
  const text = 'Before /settings after\nkeep this';
  const token = commandToken(text, 11)!;
  assert.equal(token.query, 'settings');
  assert.deepEqual(replaceCommand(text, token), { text: 'Before  after\nkeep this', caret: 7 });
  assert.deepEqual(replaceCommand(text, token, 'Skill draft\n'), {
    text: 'Before Skill draft\n after\nkeep this',
    caret: 19,
  });
  assert.equal(replaceCommand('changed content', token), undefined);
  for (const value of [
    'https://example.test/',
    'prefix/skill',
    '/folder/file',
    '//network',
    'normal text',
  ])
    assert.equal(commandToken(value, value.length), undefined, value);
  assert.equal(commandToken('/settings', 1, 5), undefined);
  assert.equal(commandToken('/settings', 0), undefined);
  assert.equal(commandToken('First\n/', 7)?.query, '');
});

test('only actual active skills of eligible current members are listed, with owner-only routines', () => {
  const commands = composerCommands({
    members: [bot, peer],
    canManage: false,
    skills: [
      skill,
      { ...skill, id: 'proposed', status: 'proposed' },
      { ...skill, id: 'archived', status: 'archived' },
      { ...skill, id: 'disabled', status: 'disabled' },
      { ...skill, id: 'foreign', agentId: 'foreign' },
      { ...skill, id: 'peer', agentId: peer.id },
    ],
    agentId: bot.id,
  });
  assert.deepEqual(
    commands.map((item) => item.id),
    ['skill:skill-a', 'settings', 'computer', 'apps'],
  );
  assert.equal(matchingCommands(commands, 'summarize')[0].agentId, bot.id);
  assert.equal(matchingCommands(commands, 'does-not-exist').length, 0);
  assert.equal(
    composerCommands({ members: [bot], skills: [], canManage: true }).filter(
      (item) => item.kind === 'skill',
    ).length,
    0,
  );
});

test('arrow keys and Enter select a skill into the existing draft without sending or losing attachments', async () => {
  const f = await composerFixture({ draft: 'Before / after' });
  try {
    await f.select(8);
    await f.focus();
    assert.equal(f.input().props['aria-controls'], 'composer-commands');
    assert.equal(f.options().length, 5);
    await f.key('ArrowDown');
    assert.equal(f.option('设置').props['aria-selected'], true);
    await f.key('ArrowUp');
    assert.equal(f.option('Summarize').props['aria-selected'], true);
    const original = f.props.currentComposer;
    assert.equal((await f.key('Enter')).prevented, true);
    assert.equal(f.props.draft, 'Before 请使用「Summarize」技能处理以下内容：\n after');
    assert.equal(f.props.currentComposer.agentId, bot.id);
    assert.equal(f.props.currentComposer.attachments, original.attachments);
    assert.equal(f.props.currentComposer.replyTo, original.replyTo);
    assert.equal(f.field.selectionStart, f.props.draft.indexOf(' after'));
    assert.equal(f.calls.includes('send'), false);
    assert.equal(f.input().props['aria-expanded'], false);
    assert.equal((await f.key('Enter', { repeat: true })).prevented, true);
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('settings, computer, apps and routine shortcuts preserve draft content and open existing panels', async () => {
  for (const [query, label, expected] of [
    ['settings', '设置', 'settings:general'],
    ['computer', '电脑', 'computer'],
    ['apps', '连接应用', 'modal:apps'],
    ['routines', '例行任务', 'modal:routine'],
  ]) {
    const f = await composerFixture({ draft: `Left /${query} right` });
    try {
      await f.select(7);
      await f.focus();
      const before = f.props.currentComposer;
      f.option(label).props.onPointerDown({ preventDefault() {} });
      f.option(label).props.onClick();
      await f.flush();
      assert.equal(f.props.draft, 'Left  right');
      assert.equal(f.props.currentComposer.attachments, before.attachments);
      assert.equal(f.props.currentComposer.replyTo, before.replyTo);
      assert.ok(f.calls.includes(expected));
      if (query === 'routines')
        assert.ok(f.calls.indexOf('routine:null') < f.calls.indexOf('modal:routine'));
      assert.equal(f.calls.includes('send'), false);
    } finally {
      f.dispose();
    }
  }
});

test('Escape, blur, outside pointer and range selection close the command menu without altering the draft', async () => {
  const f = await composerFixture();
  try {
    await f.focus();
    assert.deepEqual(await f.key('Escape'), { prevented: true, stopped: true });
    assert.equal(f.input().props['aria-expanded'], false);
    await f.type('/s');
    assert.equal(f.input().props['aria-expanded'], true);
    f.input().props.onBlur();
    await f.flush();
    assert.equal(f.input().props['aria-expanded'], false);
    await f.focus();
    f.document.dispatchEvent(new Event('pointerdown'));
    await f.flush();
    assert.equal(f.input().props['aria-expanded'], false);
    await f.type('/set');
    await f.focus();
    await f.select(1, 3);
    assert.equal(f.input().props['aria-expanded'], false);
    assert.equal(f.props.draft, '/set');
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('IME commit Enter and keyCode 229 never choose a command or submit the message', async () => {
  const f = await composerFixture();
  try {
    await f.focus();
    f.input().props.onCompositionStart();
    await f.flush();
    await f.key('Enter');
    f.input().props.onCompositionEnd();
    await f.flush();
    await f.key('Enter');
    await f.timers();
    await f.key('Enter', { nativeEvent: { isComposing: true, keyCode: 13 } });
    await f.key('Enter', { nativeEvent: { isComposing: false, keyCode: 229 } });
    assert.equal(f.props.draft, '/');
    assert.equal(f.calls.includes('send'), false);
    await f.key('Enter');
    assert.match(f.props.draft, /Summarize/);
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('no-match Enter is consumed while Shift+Enter and existing Bot mention selection retain their behavior', async () => {
  const f = await composerFixture({ draft: '/no-match' });
  try {
    await f.focus();
    assert.equal(f.options().length, 0);
    assert.equal((await f.key('Enter')).prevented, true);
    assert.equal((await f.key('Enter', { shiftKey: true })).prevented, false);
    assert.equal(f.calls.includes('send'), false);
    await f.type('@');
    assert.equal(f.input().props['aria-controls'], 'composer-mentions');
    await f.key('ArrowDown');
    await f.key('Enter');
    assert.equal(f.props.draft, '@Birch ');
    assert.equal(f.props.currentComposer.agentId, peer.id);
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('mention parsing recognizes punctuation and rejects email or URL tokens', () => {
  const draft = '请@Bi，继续';
  assert.equal(mentionToken(draft, 3)?.query, 'Bi');
  assert.deepEqual(replaceCommand(draft, mentionToken(draft, 3)!, '@Birch'), {
    text: '请@Birch，继续',
    caret: 7,
  });
  for (const text of ['hello@example', 'https://example.test/@handle'])
    assert.equal(mentionToken(text, text.length), undefined);
  assert.equal(mentionToken('@Birch', 1, 3), undefined);
});

test('a mention selected mid-draft preserves the rest and pins the chosen Bot with a duplicate name', async () => {
  const f = await composerFixture({ draft: 'Before @Bi after' });
  try {
    await f.change({ members: [{ ...bot, name: peer.name }, peer] });
    await f.select(9);
    await f.focus();
    assert.equal(f.input().props['aria-controls'], 'composer-mentions');
    assert.equal(f.options().length, 2);
    const original = f.props.currentComposer;
    await f.key('ArrowDown');
    assert.equal(f.input().props['aria-activedescendant'], `mention-option-${peer.id}`);
    assert.equal((await f.key('Enter')).prevented, true);
    assert.equal(f.props.draft, 'Before @Birch after');
    assert.equal(f.field.selectionStart, 14);
    assert.equal(f.props.currentComposer.agentId, peer.id);
    assert.equal(f.props.currentComposer.attachments, original.attachments);
    assert.equal(f.props.currentComposer.replyTo, original.replyTo);
    assert.equal(f.calls.includes('send'), false);
  } finally {
    f.dispose();
  }
});

test('a stale mention click cannot replace a new draft, withdrawn member or changed account', async () => {
  for (const change of ['draft', 'member', 'account']) {
    const f = await composerFixture({ draft: '@Bi' });
    try {
      await f.focus();
      const option = f.option('Birch');
      if (change === 'draft') await f.type('Changed draft');
      if (change === 'member') await f.change({ members: [bot] });
      if (change === 'account') f.scope.suspend();
      option.props.onClick();
      await f.flush();
      assert.equal(f.props.currentComposer.agentId, undefined);
      assert.equal(f.props.draft, change === 'draft' ? 'Changed draft' : '@Bi');
      assert.equal(f.calls.includes('send'), false);
    } finally {
      f.dispose();
    }
  }
});
