import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { clearSubmittedDraft, emptyComposer, makeSendAttempt, submissionKey } from './chatDrafts';
import { createPendingSubmissions } from './pendingSubmissions';
import { encodeSpeechWav, SPEECH_RATE } from './speechAudio';
import { loadVoiceMemo, messageVoiceMemo } from './voiceMemo';
import type { Message, WorkspaceFile } from '../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';

test('a voice memo request is one-shot and requires its own exact receipt after reload', async () => {
  const storage = new Map<string, string>();
  const create = () =>
    createPendingSubmissions({
      userId,
      workspaceId,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, v) => storage.set(key, v),
      },
    });
  const draft = { ...emptyComposer(), text: 'A synthetic question' };
  const optedIn = { ...draft, requestVoiceMemo: true as const };
  const registry = create();
  const initial = await registry.prepare(makeSendAttempt('chat', optedIn));
  assert.equal(initial.mode, 'followUp');
  assert.equal(initial.requestVoiceMemo, true);
  assert.equal(clearSubmittedDraft(optedIn, optedIn).mode, 'steer');
  assert.equal(clearSubmittedDraft(optedIn, optedIn).requestVoiceMemo, undefined);
  assert.notEqual(submissionKey(draft), submissionKey(optedIn));

  const recovered = create();
  const message: Message = {
    id: 'stored',
    conversationId: 'chat',
    role: 'user',
    userId,
    content: draft.text,
    createdAt: new Date().toISOString(),
    delivery: { state: 'delivered', mode: 'followUp', clientId: initial.clientId },
  };
  recovered.confirm(message);
  assert.equal(recovered.pending(), 1);
  const retry = await recovered.prepare(makeSendAttempt('chat', optedIn));
  assert.equal(retry.clientId, initial.clientId);
  assert.notEqual(
    (await recovered.prepare(makeSendAttempt('chat', draft))).clientId,
    retry.clientId,
  );
  assert.equal(recovered.confirm({ ...message, metadata: { requestVoiceMemo: true } }), retry);
});

test('voice memo accepts only authorized canonical audio and retains transcript without it', async () => {
  const wav = new Uint8Array(await encodeSpeechWav(new Float32Array(SPEECH_RATE)).arrayBuffer());
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const file: WorkspaceFile = {
    id: 'audio',
    name: 'audio.wav',
    type: 'audio/wav',
    size: wav.length,
    sha256,
    conversationId: 'chat',
    createdAt: new Date().toISOString(),
  };
  const message: Message = {
    id: 'memo',
    conversationId: 'chat',
    role: 'assistant',
    kind: 'file',
    content: 'Synthetic transcript',
    createdAt: file.createdAt,
    metadata: {
      fileId: file.id,
      name: file.name,
      size: file.size,
      sha256,
      voiceMemo: { transcript: 'Synthetic transcript', durationMs: 1000 },
    },
  };
  const memo = messageVoiceMemo(message, [file])!;
  assert.ok(memo.audio);
  assert.equal(messageVoiceMemo(message, [])?.transcript, 'Synthetic transcript');
  assert.equal(messageVoiceMemo(message, [{ ...file, sha256: 'b'.repeat(64) }])?.audio, undefined);
  assert.equal(messageVoiceMemo(message, [{ ...file, conversationId: 'other' }])?.audio, undefined);
  assert.equal(messageVoiceMemo({ ...message, role: 'user' }, [file]), undefined);

  const signal = new AbortController().signal;
  let authorized = true;
  let mime = 'audio/wav';
  let body = wav;
  let fetches = 0;
  const load = (duration = memo.durationMs, pathname = `/w/${workspaceId}`) =>
    loadVoiceMemo(
      memo.audio!,
      duration,
      { workspaceId, userId, pathname },
      signal,
      () => authorized,
      async (url, options) => {
        fetches++;
        assert.equal(url, `/api/workspaces/${workspaceId}/files/audio/download`);
        assert.equal(new Headers(options?.headers).get('X-OpenBot-Expected-User'), userId);
        assert.equal(options?.redirect, 'error');
        assert.equal(options?.cache, 'no-store');
        return new Response(body, {
          headers: { 'Content-Type': mime, 'Content-Disposition': 'attachment' },
        });
      },
    );
  assert.equal((await load()).size, wav.length);
  await assert.rejects(load(500), /audio/);
  body = wav.slice();
  body[body.length - 1] = 1;
  await assert.rejects(load(), /match/);
  body = wav;
  mime = 'text/html';
  await assert.rejects(load(), /response/);
  authorized = false;
  await assert.rejects(load(), /scope/);
  await assert.rejects(load(1000, '/account'), /scope/);
  assert.equal(fetches, 4);
});
