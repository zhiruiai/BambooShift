import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSpeech, speechChunks } from './localSpeech';
import { createVoicePreferences, voicePreferenceKey } from './voicePreferences';
import {
  voiceFixture,
  fakeSpeech,
  localVoice,
  storage,
  identity,
  input,
  completed,
  snapshot,
} from './testSupport/voiceFixture';

test('local read-aloud explicitly selects installed Chinese and English voices; no remote or default voice is used', () => {
  const f = voiceFixture();
  try {
    assert.equal(f.speech.spoken.length, 0);
    assert.equal(f.playback.getSnapshot().autoRead, false);
    assert.equal(f.read('你好，世界。'), true);
    assert.equal(f.speech.spoken[0].voice?.lang, 'zh-CN');
    assert.equal(f.speech.spoken[0].voice?.localService, true);
    f.playback.update({ rate: 1.5 });
    assert.equal(f.read('Hello world.'), true);
    assert.equal(f.speech.spoken[1].voice?.lang, 'en-US');
    assert.equal(f.speech.spoken[1].rate, 1.5);
    f.playback.update({ voiceURI: 'remote-en-GB' });
    assert.equal(f.read('Never use the remote voice.'), false);
    assert.equal(f.playback.getSnapshot().error, 'voice_missing');
    assert.equal(f.speech.spoken.length, 2);
  } finally {
    f.dispose();
  }
});

test('unsupported synthesis, remote-only voices, and playback rejection report failure without fallback or retry', () => {
  const f = voiceFixture();
  try {
    f.speech.setVoices([localVoice('en-US', false)]);
    assert.equal(f.read('Unavailable'), false);
    assert.equal(f.playback.getSnapshot().error, 'no_local_voice');
    f.speech.setVoices([localVoice()]);
    f.read('Explicit action');
    f.speech.spoken[0].onerror?.();
    assert.equal(f.playback.getSnapshot().error, 'failed');
    assert.equal(f.speech.spoken.length, 1);
  } finally {
    f.dispose();
  }
  const unavailable = createLocalSpeech({ current: () => true, onChange() {} });
  unavailable.resume();
  assert.equal(
    unavailable.speak({ id: 'a', text: 'a', voiceURI: '', rate: 1, language: 'en' }),
    false,
  );
  assert.equal(unavailable.getSnapshot().error, 'unsupported');
  unavailable.suspend();
});

test('long Unicode text is read completely in bounded chunks, but stop and stale callbacks cannot enqueue more', () => {
  const f = voiceFixture(),
    text = '你好🐷'.repeat(350);
  try {
    assert.equal(speechChunks(text).join(''), text);
    f.read(text);
    let index = 0;
    while (f.playback.getSnapshot().speakingId) f.speech.spoken[index++].onend?.();
    assert.equal(f.speech.spoken.map((utterance) => utterance.text).join(''), text);
    f.read(text);
    const old = f.speech.spoken.at(-1)!;
    f.playback.stop();
    const count = f.speech.spoken.length;
    old.onend?.();
    assert.equal(f.speech.spoken.length, count);
    f.read(text);
    f.setContext({ conversationId: 'other-chat' });
    f.speech.spoken.at(-1)!.onend?.();
    assert.equal(f.speech.spoken.length, count + 1);
    assert.equal(f.playback.getSnapshot().speakingId, undefined);
  } finally {
    f.dispose();
  }
});

test('concurrent playback replaces the prior owner and old cleanup does not cancel a newer owner', () => {
  const speech = fakeSpeech();
  const make = () => createLocalSpeech({ ...speech, current: () => true, onChange() {} });
  const first = make(),
    second = make();
  first.resume();
  second.resume();
  try {
    first.speak({ id: 'a', text: 'A'.repeat(900), voiceURI: '', rate: 1, language: 'en' });
    second.speak({ id: 'b', text: 'B', voiceURI: '', rate: 1, language: 'en' });
    const cancels = speech.cancels;
    first.suspend();
    speech.spoken[0].onend?.();
    assert.equal(speech.cancels, cancels);
    assert.equal(speech.spoken.length, 2);
    assert.equal(second.getSnapshot().speakingId, 'b');
  } finally {
    first.suspend();
    second.suspend();
  }
});

test('automatic reading requires an explicit session and only consumes a new own root reply once', () => {
  const f = voiceFixture();
  try {
    f.playback.update({ autoRead: true });
    f.playback.receive(completed('before-arm'));
    assert.equal(f.speech.spoken.length, 0);
    f.playback.arm();
    f.playback.baseline(snapshot([input(), completed('history')]));
    f.playback.receive(completed('history'));
    f.playback.receive(completed('live'));
    f.playback.receive(completed('live'));
    assert.equal(f.speech.spoken.length, 1);
    f.speech.spoken[0].onend?.();
    f.playback.receive({
      ...completed('child'),
      metadata: { ...completed().metadata, runId: 'child', delegation: true },
    });
    f.playback.receive(input('another-user'));
    f.playback.receive(completed('other-user'));
    f.playback.receive({ ...completed('other-bot'), agentId: 'bot-b' });
    assert.equal(f.speech.spoken.length, 1);
    f.playback.receive(input());
    f.setContext({ blocked: true });
    f.playback.receive(completed('during-recording'));
    f.setContext({ blocked: false });
    f.playback.receive(completed('during-recording'));
    assert.equal(f.speech.spoken.length, 1);
    f.playback.stop();
    f.playback.receive(completed('stopped'));
    assert.equal(f.speech.spoken.length, 1);
  } finally {
    f.dispose();
  }
});

test('account fences and source snapshots never speak, while preferences store no message text and remain identity-scoped', () => {
  const f = voiceFixture();
  try {
    f.playback.update({ autoRead: true, voiceURI: 'local-en-US', rate: 1.25 });
    f.playback.arm();
    f.setCurrent(false);
    f.read('PRIVATE_MESSAGE');
    f.playback.receive(completed('late'));
    assert.equal(f.speech.spoken.length, 0);
    const stored = [...f.saved.values.values()].join('');
    assert.doesNotMatch(stored, /PRIVATE_MESSAGE|SYNTHETIC_PRIVATE_RESULT|chat-a|bot-a/);
    const other = createVoicePreferences({
      identity: { ...identity, userId: 'user-b' },
      storage: f.saved,
    });
    assert.equal(other.getSnapshot().autoRead, false);
    const remount = createVoicePreferences({ identity, storage: f.saved });
    assert.equal(remount.getSnapshot().rate, 1.25);
  } finally {
    f.dispose();
  }
});

test('storage rejection stays usable in memory; delayed cross-window events use the latest actual preference', () => {
  const saved = storage(),
    events = new EventTarget();
  const store = createVoicePreferences({
    identity,
    storage: saved,
    events: events as unknown as Window,
  });
  const release = store.subscribe(() => {});
  try {
    const key = voicePreferenceKey(identity);
    saved.setItem(key, JSON.stringify({ version: 1, rate: 2, voiceURI: '', autoRead: true }));
    store.update({ rate: 0.75, autoRead: false });
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key, newValue: 'stale', storageArea: saved }),
    );
    assert.equal(store.getSnapshot().rate, 0.75);
    assert.equal(store.getSnapshot().autoRead, false);
    saved.setItem = () => {
      throw Error('blocked');
    };
    store.update({ rate: 1.5 });
    assert.equal(store.getSnapshot().rate, 1.5);
    assert.equal(store.getSnapshot().storageAvailable, false);
  } finally {
    release();
  }
});
