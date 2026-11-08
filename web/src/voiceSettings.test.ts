import test from 'node:test';
import assert from 'node:assert/strict';
import { all, base, component, env, harness } from './testSupport/memoryImportSettingsFixture';
import {
  fakeSpeech,
  storage,
  input,
  completed,
  snapshot,
  FakeUtterance,
  voiceFixture,
} from './testSupport/voiceFixture';
import { voicePreferenceKey } from './voicePreferences';
import { createDictationController } from './dictation';
import { emptyComposer } from './chatDrafts';

const props = {
  userId: base.userId,
  workspaceId: base.workspaceId,
  conversationId: 'chat-a',
  agentId: 'bot-a',
  enabled: true,
  blocked: false,
};
function environment() {
  const speech = fakeSpeech(),
    saved = storage();
  const window = Object.assign(new EventTarget(), env().window, {
    localStorage: saved,
    speechSynthesis: speech.synthesis,
    SpeechSynthesisUtterance: FakeUtterance,
    dispatchEvent: EventTarget.prototype.dispatchEvent,
  });
  const document = Object.assign(new EventTarget(), { hidden: false });
  return { ...env(), window, document, speech, saved, setTimeout, clearTimeout };
}
const buttonByLabel = (tree: any, label: string) => {
  const result = all(
    tree,
    (node) => node.type === 'button' && node.props['aria-label'] === label,
  )[0];
  assert.ok(result, `Missing button ${label}`);
  return result;
};

test('actual voice hook consumes only new own replies after a user starts, and old callbacks cannot speak after account switch or unmount', async () => {
  const globals = environment();
  globals.saved.setItem(
    voicePreferenceKey(props),
    JSON.stringify({ version: 1, voiceURI: '', rate: 1, autoRead: true }),
  );
  const h = await harness('web/src/useVoice.ts', 'useWorkspaceVoice', props, globals);
  try {
    await h.flush();
    h.tree.baseline(snapshot([input(base.userId), completed('history')]));
    h.tree.receive(completed('before-click'));
    assert.equal(globals.speech.spoken.length, 0);
    h.tree.arm();
    await h.flush();
    assert.equal(h.tree.state.armed, true);
    h.tree.receive(completed('live'));
    await h.flush();
    assert.equal(globals.speech.spoken.length, 1);
    const old = h.tree;
    h.setProps({ userId: 'other-user' });
    await h.flush();
    old.receive(completed('late'));
    old.read(completed('late-manual'));
    old.baseline(snapshot([input(base.userId)]));
    old.arm();
    assert.equal(globals.speech.spoken.length, 1);
    assert.ok(globals.speech.cancels > 0);
    h.dispose();
    old.baseline(snapshot([input()]));
    old.read(completed());
    assert.equal(globals.speech.spoken.length, 1);
  } finally {
    h.dispose();
  }
});

test('actual hook stops on Bot or conversation change, recording, page hide, and expired identity; stale voice events cannot resume', async () => {
  const globals = environment();
  const h = await harness('web/src/useVoice.ts', 'useWorkspaceVoice', props, globals);
  try {
    await h.flush();
    h.tree.read({ ...completed(), content: 'Hello '.repeat(300) });
    const old = h.tree,
      utterance = globals.speech.spoken[0];
    h.setProps({ agentId: 'bot-b' });
    await h.flush();
    old.read(completed('old-bot'));
    utterance.onend?.();
    assert.equal(globals.speech.spoken.length, 1);
    assert.equal(h.tree.state.speakingId, undefined);
    h.tree.read(completed());
    await h.flush();
    h.setProps({ blocked: true });
    await h.flush();
    assert.equal(h.tree.state.speakingId, undefined);
    h.tree.read(completed('while-recording'));
    assert.equal(globals.speech.spoken.length, 2);
    h.setProps({ blocked: false });
    await h.flush();
    h.tree.arm();
    h.tree.read(completed());
    await h.flush();
    globals.document.hidden = true;
    globals.document.dispatchEvent(new Event('visibilitychange'));
    await h.flush();
    assert.equal(h.tree.state.armed, false);
    assert.equal(h.tree.state.speakingId, undefined);
    globals.document.hidden = false;
    h.tree.read(completed());
    await h.flush();
    globals.window.dispatchEvent(new Event('openbot:account-expired'));
    await h.flush();
    const count = globals.speech.spoken.length;
    h.tree.read(completed('expired'));
    assert.equal(globals.speech.spoken.length, count);
    h.setProps({ conversationId: 'other-chat' });
    await h.flush();
    h.tree.read(completed());
    assert.equal(globals.speech.spoken.length, count);
  } finally {
    h.dispose();
  }
});

test('voice settings actual controls retain manual consent, never record or send, and reject closed popover callbacks', async () => {
  const f = voiceFixture(),
    globals = environment();
  let stops = 0;
  const voice = () => ({ ...f.playback, state: f.playback.getSnapshot() });
  const h = await harness(
    'web/src/components/VoiceControls.tsx',
    'VoiceControls',
    {
      voice: voice(),
      blocked: false,
      onStop: () => {
        stops++;
        f.playback.stop();
      },
    },
    globals,
  );
  try {
    await h.flush();
    assert.equal(f.speech.spoken.length, 0);
    buttonByLabel(h.tree, '语音设置').props.onClick();
    await h.flush();
    assert.match(h.copy, /手动发送/);
    assert.doesNotMatch(h.copy, /remote-en-GB/);
    const selects = all(h.tree, (node) => node.type === 'select');
    selects[0].props.onChange({ target: { value: 'local-en-US' } });
    selects[1].props.onChange({ target: { value: '1.5' } });
    all(h.tree, (node) => node.type === 'input')[0].props.onChange({ target: { checked: true } });
    h.setProps({ voice: voice() });
    await h.flush();
    assert.equal(f.playback.getSnapshot().armed, false);
    h.button('开启本次朗读').props.onClick();
    h.setProps({ voice: voice() });
    await h.flush();
    assert.equal(f.playback.getSnapshot().armed, true);
    assert.equal(f.speech.spoken.length, 0);
    h.button('结束本次朗读').props.onClick();
    assert.equal(stops, 1);
    const retained = all(h.tree, (node) => node.type === 'select')[1].props.onChange;
    buttonByLabel(h.tree, '关闭语音设置').props.onClick();
    await h.flush();
    retained({ target: { value: '2' } });
    assert.equal(f.playback.getSnapshot().rate, 1.5);
  } finally {
    h.dispose();
    f.dispose();
  }
});

test('actual composer microphone action cancels read-aloud first; recording completion only returns editable transcription', async () => {
  const f = voiceFixture(),
    draft = emptyComposer();
  let sent = 0,
    started = 0,
    cancelled = 0,
    transcript = '';
  const capture = {
    scope: 'scope-a',
    conversationId: 'chat-a',
    draft,
    selection: { start: 0, end: 0, version: 0 },
  };
  const dictation = createDictationController({
    currentScope: () => 'scope-a',
    onState() {},
    recorder: () => ({
      start: async () => {
        assert.equal(f.playback.getSnapshot().speakingId, undefined);
        started++;
      },
      finish: async () => new Blob(['synthetic-wave'], { type: 'audio/wav' }),
      cancel: () => {
        cancelled++;
      },
    }),
    transcribe: async () => '可编辑的转写文字',
    onTranscript: (_capture, value) => {
      transcript = value;
    },
  });
  const h = await harness(
    'web/src/workspace/ChatComposer.tsx',
    'ChatComposer',
    {
      conversation: { id: 'chat-a', agentIds: ['bot-a'] },
      selected: 'chat-a',
      data: { settings: { configured: true } },
      currentComposer: draft,
      lead: { id: 'bot-a' },
      voice: { ...f.playback, state: f.playback.getSnapshot() },
      dictation: {
        state: { phase: 'idle', durationMs: 0 },
        busy: false,
        cancel: () => dictation.cancel(),
      },
      send: () => {
        sent++;
      },
      toggleDictation: () => void dictation.start(capture),
      sendErrors: {},
      sending: new Set(),
      uploading: new Set(),
      receipts: { pending: () => 0 },
      attachments: [],
      draft: '',
      members: [],
      fileRef: { current: null },
    },
    environment(),
  );
  try {
    await h.flush();
    f.read('Playback before the explicit microphone click');
    assert.equal(started, 0);
    component(h.tree, 'DictationButton').props.onToggle();
    await h.flush();
    assert.equal(started, 1);
    await dictation.finish();
    assert.equal(transcript, '可编辑的转写文字');
    assert.equal(sent, 0);
    component(h.tree, 'VoiceControls').props.onStop();
    assert.ok(cancelled > 0);
    assert.equal(started, 1);
    assert.equal(sent, 0);
    f.read('Playback before keyboard recording');
    component(h.tree, 'ComposerInput').props.toggleDictation();
    await h.flush();
    assert.equal(started, 2);
    assert.equal(sent, 0);
  } finally {
    h.dispose();
    dictation.cancel();
    f.dispose();
  }
});

test('voice popover respects IME Escape, normal Escape returns focus, and outside clicks close without changing preferences', async () => {
  const f = voiceFixture(),
    globals = environment();
  const container = Object.assign(new EventTarget(), {
    contains: (target: unknown) => target === container,
  });
  let focused = 0;
  const h = await harness(
    'web/src/components/VoiceControls.tsx',
    'VoiceControls',
    {
      voice: { ...f.playback, state: f.playback.getSnapshot(), blocked: false },
      blocked: false,
      onStop() {},
    },
    globals,
    (tree) => {
      tree.props.ref.current = container;
      buttonByLabel(tree, '语音设置').props.ref.current = {
        focus: () => {
          focused++;
        },
      };
    },
  );
  try {
    await h.flush();
    buttonByLabel(h.tree, '语音设置').props.onClick();
    await h.flush();
    container.dispatchEvent(
      Object.assign(new Event('keydown', { cancelable: true }), {
        key: 'Escape',
        isComposing: true,
      }),
    );
    await h.flush();
    assert.equal(buttonByLabel(h.tree, '语音设置').props['aria-expanded'], true);
    container.dispatchEvent(
      Object.assign(new Event('keydown', { cancelable: true }), {
        key: 'Escape',
        isComposing: false,
      }),
    );
    await h.flush();
    assert.equal(buttonByLabel(h.tree, '语音设置').props['aria-expanded'], false);
    assert.equal(focused, 1);
    buttonByLabel(h.tree, '语音设置').props.onClick();
    await h.flush();
    globals.document.dispatchEvent(new Event('pointerdown'));
    await h.flush();
    assert.equal(buttonByLabel(h.tree, '语音设置').props['aria-expanded'], false);
    assert.equal(f.playback.getSnapshot().autoRead, false);
  } finally {
    h.dispose();
    f.dispose();
  }
});

test('English voice settings explain unavailable local voices without creating an utterance or permission request', async () => {
  const f = voiceFixture(),
    globals = environment();
  f.speech.setVoices([]);
  globals.saved.setItem('openbot-language', JSON.stringify({ version: 1, locale: 'en' }));
  const h = await harness(
    'web/src/components/VoiceControls.tsx',
    'VoiceControls',
    {
      voice: { ...f.playback, state: f.playback.getSnapshot(), blocked: false },
      blocked: false,
      onStop() {},
    },
    globals,
  );
  try {
    await h.flush();
    buttonByLabel(h.tree, 'Voice settings').props.onClick();
    await h.flush();
    assert.match(h.copy, /No local voice is available/);
    assert.match(h.copy, /review and send manually/);
    assert.match(h.copy, /network voices will not be used/);
    assert.equal(all(h.tree, (node) => node.type === 'select')[0].props.disabled, true);
    assert.equal(f.speech.spoken.length, 0);
  } finally {
    h.dispose();
    f.dispose();
  }
});
