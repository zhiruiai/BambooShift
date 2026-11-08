import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDictationController,
  mergeDictation,
  type DictationCapture,
  type DictationState,
} from './dictation.js';
import { emptyComposer } from './chatDrafts.js';
import { encodeSpeechWav, type RecorderCallbacks } from './speechAudio.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const wav = () => encodeSpeechWav(new Float32Array(1600));
const capture = (scope = 'user:space:chat'): DictationCapture => ({
  scope,
  userId: 'user',
  conversationId: 'chat',
  draft: { ...emptyComposer(), text: '原草稿' },
  selection: { start: 1, end: 1, version: 4 },
});
function fixture(timeoutMs?: number) {
  let scope = 'user:space:chat';
  const states: DictationState[] = [],
    inserted: string[] = [],
    runs: ReturnType<typeof run>[] = [],
    signals: AbortSignal[] = [];
  function run(callbacks: RecorderCallbacks) {
    const start = deferred<void>(),
      finish = deferred<Blob>(),
      text = deferred<string>();
    let cancelled = 0;
    return {
      callbacks,
      start,
      finish,
      text,
      get cancelled() {
        return cancelled;
      },
      recorder: {
        start: () => start.promise,
        finish: () => finish.promise,
        cancel() {
          cancelled++;
        },
      },
    };
  }
  const controller = createDictationController({
    currentScope: () => scope,
    recorder: (callbacks) => {
      const value = run(callbacks);
      runs.push(value);
      return value.recorder;
    },
    transcribe: (_blob, signal, userId) => {
      assert.equal(userId, 'user');
      signals.push(signal);
      return runs.at(-1)!.text.promise;
    },
    onTranscript: (original, text) => {
      assert.equal(original.scope, scope);
      inserted.push(text);
    },
    onState: (value) => states.push(value),
    timeoutMs,
  });
  return {
    controller,
    runs,
    states,
    inserted,
    signals,
    scope: (value: string) => {
      scope = value;
      controller.cancel();
    },
  };
}
test('dictation prevents repeated starts and finishes, and only delivers recognized text for manual sending', async () => {
  const f = fixture();
  const start = f.controller.start(capture());
  await f.controller.start(capture());
  assert.equal(f.runs.length, 1);
  f.runs[0].start.resolve();
  await start;
  assert.equal(f.controller.state.phase, 'recording');
  const finished = f.controller.finish();
  await f.controller.finish();
  f.runs[0].finish.resolve(wav());
  await flush();
  assert.equal(f.signals.length, 1);
  f.runs[0].text.resolve('识别出的文字');
  await finished;
  assert.deepEqual(f.inserted, ['识别出的文字']);
  assert.equal(f.controller.busy, false);
  assert.match(f.controller.state.notice, /手动发送/);
});
test('conversation and account switches cancel permission and ignore an old start after a new capture begins', async () => {
  const f = fixture();
  const old = f.controller.start(capture());
  f.scope('new-user:space:other');
  const next = f.controller.start({ ...capture('new-user:space:other'), userId: 'new-user' });
  f.runs[0].start.reject(new Error('late denial'));
  await old;
  assert.equal(f.controller.state.phase, 'requesting');
  assert.equal(f.runs[0].cancelled, 1);
  f.runs[1].start.resolve();
  await next;
  assert.equal(f.controller.state.phase, 'recording');
  f.controller.cancel();
  assert.equal(f.runs[1].cancelled, 1);
  assert.deepEqual(f.inserted, []);
});
test('cancelling conversion sends no audio; cancelling a request discards late recognition', async () => {
  for (const during of ['conversion', 'request']) {
    const f = fixture();
    const start = f.controller.start(capture());
    f.runs[0].start.resolve();
    await start;
    const finish = f.controller.finish();
    if (during === 'request') {
      f.runs[0].finish.resolve(wav());
      await flush();
    }
    f.controller.cancel();
    f.runs[0].finish.resolve(wav());
    f.runs[0].text.resolve('不应插入');
    await finish;
    assert.deepEqual(f.inserted, []);
    assert.equal(f.signals.length, during === 'request' ? 1 : 0);
    if (f.signals[0]) assert.equal(f.signals[0].aborted, true);
  }
});
test('dictation failures and timeout keep the original draft and never retry', async () => {
  const f = fixture(5),
    original = capture();
  const before = structuredClone(original.draft);
  const start = f.controller.start(original);
  f.runs[0].start.resolve();
  await start;
  const finish = f.controller.finish();
  f.runs[0].finish.resolve(wav());
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.controller.state.phase, 'error');
  assert.match(f.controller.state.error, /超时/);
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0].aborted, true);
  f.runs[0].text.resolve('太迟');
  await finish;
  assert.deepEqual(original.draft, before);
  assert.deepEqual(f.inserted, []);
});
test('dictation inserts only at an unchanged selection and otherwise appends without losing attachments or reply mode', () => {
  const original = capture();
  assert.equal(mergeDictation(original.draft, original, '听写', 4).text, '原听写草稿');
  const latest = {
    ...original.draft,
    text: '用户刚刚编辑',
    mode: 'followUp' as const,
    attachments: [{ id: 'file' }] as any,
    replyTo: { id: 'quoted' } as any,
  };
  const merged = mergeDictation(latest, original, '听写', 4);
  assert.equal(merged.text, '用户刚刚编辑\n听写');
  assert.equal(merged.attachments, latest.attachments);
  assert.equal(merged.replyTo, latest.replyTo);
  assert.equal(merged.mode, 'followUp');
  assert.equal(mergeDictation(original.draft, original, '听写', 5).text, '原草稿\n听写');
  assert.equal(original.draft.text, '原草稿');
});

test('recording publishes elapsed time only when the displayed second changes and finishes with precise duration', async () => {
  const f = fixture();
  const started = f.controller.start(capture());
  f.runs[0].start.resolve();
  await started;
  const baseline = f.states.length;
  for (const ms of [85, 170, 255, 340, 425, 510, 595, 680, 765, 850, 935])
    f.runs[0].callbacks.onTime(ms);
  assert.equal(f.states.length, baseline);
  f.runs[0].callbacks.onTime(1020);
  f.runs[0].callbacks.onTime(1105);
  assert.equal(f.states.length, baseline + 1);
  const finish = f.controller.finish();
  assert.equal(f.states.at(-1)?.durationMs, 1105);
  f.controller.cancel();
  f.runs[0].finish.resolve(wav());
  await finish;
});
