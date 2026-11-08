import test from 'node:test';
import assert from 'node:assert/strict';
import { speechStatus, transcribeSpeech } from './speech.js';
import { encodeSpeechWav } from './speechAudio.js';

const userId = 'dc2548c0-1c85-4c52-88ce-fddab713bcbe';
const workspaceId = '6cb39dfd-a267-4057-8c62-a8dd2c924a02';
const blob = () => encodeSpeechWav(new Float32Array(1600));
async function withTransport(check: (events: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const events: string[] = [];
  const target = Object.assign(new EventTarget(), { location: { pathname: `/w/${workspaceId}` } });
  for (const name of ['openbot:account-expired', 'openbot:revalidate'])
    target.addEventListener(name, () => events.push(name));
  globalThis.window = target as unknown as Window & typeof globalThis;
  try {
    await check(events);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) globalThis.window = originalWindow;
    else delete (globalThis as any).window;
  }
}
test('speech transport sends only bounded raw WAV to the current workspace with expected identity', async () => {
  await withTransport(async () => {
    let calls = 0;
    const audio = blob(),
      abort = new AbortController();
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, `/api/workspaces/${workspaceId}/speech/transcribe`);
      assert.equal(options?.method, 'POST');
      assert.equal(options?.credentials, 'same-origin');
      assert.equal(options?.body, audio);
      assert.equal(options?.signal, abort.signal);
      assert.deepEqual(options?.headers, {
        'Accept-Language': 'zh-CN',
        'Content-Type': 'audio/wav',
        'X-OpenBot-Expected-User': userId,
      });
      return Response.json({ text: '  识别文字  ', durationMs: 100, userId });
    };
    assert.equal(await transcribeSpeech(audio, abort.signal, userId), '识别文字');
    assert.equal(calls, 1);
    await assert.rejects(
      transcribeSpeech(new Blob([], { type: 'audio/wav' }), abort.signal, userId),
      /录音/,
    );
    await assert.rejects(
      transcribeSpeech(
        new Blob([new Uint8Array(2097153)], { type: 'audio/wav' }),
        abort.signal,
        userId,
      ),
      /录音/,
    );
    assert.equal(calls, 1, 'invalid recordings are never sent');
  });
});
test('speech transport rejects changed users and late cancelled responses and revalidates access errors', async () => {
  await withTransport(async (events) => {
    const abort = new AbortController();
    globalThis.fetch = async () =>
      Response.json({ text: '别人的结果', durationMs: 100, userId: 'different' });
    await assert.rejects(transcribeSpeech(blob(), abort.signal, userId), /账号已变化/);
    globalThis.fetch = async () => {
      abort.abort();
      return Response.json({ text: '迟到', durationMs: 100, userId });
    };
    await assert.rejects(transcribeSpeech(blob(), abort.signal, userId), { name: 'AbortError' });
    for (const status of [401, 403]) {
      globalThis.fetch = async () => Response.json({ error: '拒绝访问' }, { status });
      await assert.rejects(
        transcribeSpeech(blob(), new AbortController().signal, userId),
        /拒绝访问/,
      );
    }
    assert.deepEqual(events, ['openbot:account-expired', 'openbot:revalidate']);
  });
});
test('speech status reads the local-processing contract without recording or sending audio', async () => {
  await withTransport(async () => {
    const status = {
      available: false,
      reason: '尚未配置',
      maxSeconds: 60,
      maxBytes: 2097152,
      format: 'wav-pcm16-mono-16000',
      processing: 'server-local',
    };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/api/workspaces/${workspaceId}/speech/status`);
      assert.equal(options?.method, 'GET');
      assert.equal(options?.body, undefined);
      return Response.json(status);
    };
    assert.deepEqual(await speechStatus(new AbortController().signal), status);
    globalThis.fetch = async () => Response.json({ ...status, format: 'unsupported' });
    await assert.rejects(speechStatus(new AbortController().signal), /不兼容/);
  });
});
