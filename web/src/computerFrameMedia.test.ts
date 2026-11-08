import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './api';
import {
  createComputerFrameMedia,
  PRIVATE_FRAME_DENIED,
  readScreenFrame,
} from './computerFrameMedia';
import { createComputerScope } from './computerScope';

const capturedAt = '2026-11-07T00:00:00Z';
const image = Uint8Array.of(137, 80, 78, 71);
const reply = (visibility?: string, cache = 'private, no-store', mime = 'image/png') =>
  new Response(image, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': cache,
      'X-Captured-At': capturedAt,
      ...(visibility ? { 'X-OpenBot-Frame-Visibility': visibility } : {}),
    },
  });
const denied = (error: unknown) => error instanceof ApiError && error.code === PRIVATE_FRAME_DENIED;

test('public and private frame receipts are separate before any bytes are read', async () => {
  await assert.rejects(
    readScreenFrame(reply('takeover'), 'shared', () => true),
    denied,
  );
  await assert.rejects(
    readScreenFrame(reply('shared'), 'takeover', () => true),
    denied,
  );
  await assert.rejects(
    readScreenFrame(reply(), 'takeover', () => true),
    denied,
  );
  await assert.rejects(
    readScreenFrame(reply('takeover', 'no-store'), 'takeover', () => true),
    denied,
  );
  await assert.rejects(
    readScreenFrame(reply('takeover', 'private'), 'takeover', () => true),
    denied,
  );
  await assert.rejects(
    readScreenFrame(
      reply('takeover', 'private, no-store', 'image/svg+xml'),
      'takeover',
      () => true,
    ),
  );
  assert.equal((await readScreenFrame(reply(), 'shared', () => true)).capturedAt, capturedAt);
  assert.equal(
    (await readScreenFrame(reply('takeover'), 'takeover', () => true)).blob.size,
    image.length,
  );
});

test('clearing a frame strips its DOM source, revokes its URL and discards an in-flight reply', async () => {
  const visible: (string | null)[] = [];
  const revoked: string[] = [];
  let currentSource = '';
  let created = 0;
  const media = createComputerFrameMedia((frame) => visible.push(frame?.url ?? null), {
    createObjectURL: () => `blob:frame-${++created}`,
    revokeObjectURL: (value) => revoked.push(value),
  });
  const frame = await readScreenFrame(reply('takeover'), 'takeover', () => true);
  const first = media.begin()!;
  media.replace(first, 'takeover', frame.blob, frame.capturedAt);
  media.finish(first);
  currentSource = 'blob:frame-1';
  media.bindImage({
    getAttribute: () => currentSource,
    removeAttribute: () => {
      currentSource = '';
    },
  } as unknown as HTMLImageElement);
  const pending = media.begin()!;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream = controller;
      },
    }),
    {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-store',
        'X-OpenBot-Frame-Visibility': 'takeover',
      },
    },
  );
  const loading = readScreenFrame(response, 'takeover', () => media.current(pending));
  media.clear();
  assert.equal(pending.signal.aborted, true);
  assert.equal(currentSource, '');
  assert.deepEqual(revoked, ['blob:frame-1']);
  assert.deepEqual(visible, ['blob:frame-1', null]);
  stream.enqueue(image);
  await assert.rejects(loading, { name: 'AbortError' });
  media.replace(pending, 'takeover', frame.blob, frame.capturedAt);
  assert.equal(created, 1);
  assert.ok(media.begin());
});

test('private frame transport sends its proof only as a scoped POST header', async () => {
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  const transport: typeof fetch = async (path, options) => {
    calls.push([path, options]);
    return reply('takeover');
  };
  const identity = { workspaceId: 'space', userId: 'actor', agentId: 'bot' };
  const scope = createComputerScope({ ...identity, identity: () => identity, fetch: transport });
  await scope.privateScreenshot('temporary-proof', new AbortController().signal);
  const [path, options] = calls[0];
  const headers = new Headers(options?.headers);
  assert.equal(path, '/api/workspaces/space/computer/bots/bot/takeover/screenshot');
  assert.equal(options?.method, 'POST');
  assert.equal(options?.cache, 'no-store');
  assert.equal(options?.redirect, 'error');
  assert.equal(options?.body, '{}');
  assert.equal(headers.get('X-OpenBot-Computer-Lease'), 'temporary-proof');
  assert.equal(headers.get('X-OpenBot-Expected-User'), 'actor');
  identity.agentId = 'other-bot';
  await assert.rejects(scope.privateScreenshot('temporary-proof', new AbortController().signal), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 1);
});
