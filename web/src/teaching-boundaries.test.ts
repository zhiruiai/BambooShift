import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, session, wid, user, profile } from './testSupport/teachingFixture';
import { json, storage, harness, all, deferred } from './testSupport/creationFlowFixture';

test('effect cleanup and resume discard an old read and permit a fresh initial check', async () => {
  const gate = deferred<Response>();
  let reads = 0;
  const f = fixture((path, init, fallback) => {
    if (path.endsWith('/teaching') && init.method === 'GET' && ++reads === 1) return gate.promise;
    return fallback();
  });
  const old = f.client.check();
  assert.equal(f.client.state.busy, true);
  f.client.close();
  f.client.resume();
  assert.equal(await f.client.check(), true);
  assert.equal(f.client.state.ready, true);
  assert.equal(f.client.state.inputBlocked, false);
  gate.resolve(json([]));
  assert.equal(await old, false);
  assert.equal(f.client.state.busy, false);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
  f.client.close();
});

test('a changed live screen or lease immediately blocks recording input and writes a cancel fence', async () => {
  let binding: string | undefined = 'original-lease-and-screen';
  const f = fixture(undefined, storage(), () => binding);
  await f.client.check();
  await f.client.start('original-lease');
  assert.equal(f.client.state.inputBlocked, false);
  binding = undefined;
  assert.equal(f.client.state.inputBlocked, true);
  f.client.bindingChanged();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
  f.client.close();
});

test('closing a view persists its cancellation uncertainty before sending cleanup', async () => {
  const memory = storage();
  const record = session();
  const f = fixture((path, _init, fallback) => {
    if (path.endsWith('/cancel')) throw new TypeError('lost cleanup');
    return fallback();
  }, memory);
  f.setSaved({ ...record, status: 'generating' });
  await f.client.check();
  f.client.close();
  const marker = JSON.parse([...memory.values.values()][0]);
  assert.equal(marker.kind, 'cancel');
  const recovered = fixture(undefined, memory);
  recovered.setSaved(record);
  await recovered.client.check();
  assert.equal(recovered.client.state.uncertain, true);
  assert.ok(recovered.calls.every((c) => c.method === 'GET'));
  recovered.client.close();
});

test('pending metadata rejects private fields and malformed operation receipts before dispatch', async () => {
  const key = `openbot-teaching:${JSON.stringify([wid, user, 'bot-a', 'chat-a'])}`;
  for (const patch of [
    { leaseId: 'private' },
    { steps: [] },
    { kind: 'generate' },
    { kind: 'review' },
    { operationId: 'invalid' },
  ]) {
    const memory = storage();
    memory.setItem(
      key,
      JSON.stringify({
        version: 2,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        kind: 'start',
        ...patch,
      }),
    );
    const f = fixture(undefined, memory);
    assert.equal(await f.client.check(), false);
    assert.equal(f.client.state.inputBlocked, true);
    assert.equal(await f.client.start('lease'), false);
    assert.equal(f.calls.length, 0);
    f.client.close();
  }
});

test('a foreign generation receipt cannot clear the original operation', async () => {
  const record = session();
  const f = fixture((path, _init, fallback) =>
    path.endsWith('/generate')
      ? json({ ...record, status: 'generating', generationRequestId: crypto.randomUUID() })
      : fallback(),
  );
  f.setSaved(record);
  await f.client.check();
  assert.equal(await f.client.generate(profile, false), false);
  assert.equal(f.client.state.uncertain, true);
  assert.equal(await f.client.generate(profile, false), false);
  f.client.close();
});

test('saved records reject invented actions, duplicate steps and private input details', async () => {
  for (const mutate of [
    (r: ReturnType<typeof session>) => {
      r.steps[0].action = 'shell' as any;
    },
    (r: ReturnType<typeof session>) => {
      r.steps[0].details = { text: 'Private input' };
    },
    (r: ReturnType<typeof session>) => {
      r.steps.push(r.steps[0]);
    },
  ]) {
    const record = session();
    mutate(record);
    const f = fixture();
    f.setSaved(record);
    assert.equal(await f.client.check(), false);
    assert.equal(f.client.state.inputBlocked, true);
    assert.equal(f.client.state.session, undefined);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    f.client.close();
  }
});

test('a review editor freezes the selected model configuration until explicitly reselected', async () => {
  const record = session();
  const props = {
    session: record,
    models: [{ id: profile, name: 'Synthetic model', configured: true, fingerprint: 'original' }],
    busy: false,
    onSave: async () => undefined,
    onGenerate: async () => true,
  };
  const ui = await harness('web/src/components/TeachingReview.tsx', 'TeachingReview', props, {});
  try {
    await ui.flush();
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({ target: { value: profile } });
    await ui.flush();
    assert.equal(ui.button('生成技能草稿').props.disabled, false);
    ui.setProps({ ...props, models: [{ ...props.models[0], fingerprint: 'replacement' }] });
    await ui.flush();
    assert.equal(ui.button('生成技能草稿').props.disabled, true);
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({ target: { value: profile } });
    await ui.flush();
    assert.equal(ui.button('生成技能草稿').props.disabled, false);
  } finally {
    ui.dispose();
  }
});
