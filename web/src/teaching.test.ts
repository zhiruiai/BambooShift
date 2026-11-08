import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerInput } from './components/computer/createComputerInput';
import { createComputerObservation } from './components/computer/createComputerObservation';
import type { TeachingSession } from '../../shared/teaching';
import { json, storage, deferred, harness, all, text } from './testSupport/creationFlowFixture';
import { fixture, session, wid, user, profile } from './testSupport/teachingFixture';
test('start, successful stop, review and generation use only the fixed workspace and actor; recovery storage contains no notes', async () => {
  let saved = session();
  const f = fixture((path, init, fallback) => {
    if (path.endsWith('/stop')) {
      saved = { ...saved, id: f.client.state.pendingId! };
      return json(saved);
    }
    if (path.endsWith('/generate')) {
      const body = JSON.parse(init.body);
      saved = {
        ...saved,
        status: 'generating',
        generationRequestId: body.requestId,
        revision: crypto.randomUUID(),
      };
      return json(saved);
    }
    return fallback();
  });
  await f.client.check();
  assert.equal(await f.client.start('synthetic-lease'), true);
  assert.equal(await f.client.stop(), true);
  assert.equal(await f.client.generate(profile, false), true);
  assert.equal(f.client.state.session?.status, 'generating');
  const writes = f.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 3);
  for (const call of f.calls) {
    assert.ok(call.url.startsWith(`/api/workspaces/${wid}/`));
    assert.equal(new Headers(call.headers).get('X-OpenBot-Expected-User'), user);
  }
  assert.equal([...f.memory.values.values()].length, 1);
  assert.equal(JSON.parse([...f.memory.values.values()][0]).kind, 'idle');
  assert.ok(!JSON.stringify([...f.memory.values]).includes('Fill a form'));
  f.client.close();
});
test('unknown start is not repeated, and explicit cancellation fences it before a new intent can be created', async () => {
  const f = fixture((path, init, fallback) => {
    if (path.endsWith('/teaching') && init.method === 'POST') throw new TypeError('lost response');
    if (path.endsWith('/cancel')) return json({ id: f.client.state.pendingId, status: 'closed' });
    return fallback();
  });
  await f.client.check();
  await f.client.start('lease');
  const original = f.client.state.pendingId;
  assert.ok(original);
  assert.equal(await f.client.start('lease'), false);
  await f.client.check();
  assert.equal(f.client.state.pendingId, original);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/teaching') && c.method === 'POST').length, 1);
  await f.client.cancel();
  assert.equal(f.client.state.pendingId, undefined);
  f.client.close();
});
test('unknown generation freezes edits and generates no second request until its exact receipt is read', async () => {
  const saved = session();
  let requestId = '';
  const f = fixture((path, init, fallback) => {
    if (path.endsWith('/generate')) {
      requestId = JSON.parse(init.body).requestId;
      throw new TypeError('lost response');
    }
    return fallback();
  });
  f.setSaved(saved);
  await f.client.check();
  await f.client.generate(profile, false);
  assert.equal(f.client.state.uncertain, true);
  assert.equal(
    await f.client.save({ expectedRevision: saved.revision, goal: 'changed', steps: [] }),
    false,
  );
  assert.equal(await f.client.generate(profile, false), false);
  f.setSaved({
    ...saved,
    status: 'generating',
    generationRequestId: requestId,
    revision: crypto.randomUUID(),
  });
  await f.client.check();
  assert.equal(f.client.state.uncertain, false);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/generate')).length, 1);
  f.client.close();
});
test('late actor responses cannot update the view; close cleanup uses only the original identity', async () => {
  const gate = deferred<Response>();
  const f = fixture(async (path, init, fallback) =>
    path.endsWith('/teaching') && init.method === 'POST' ? gate.promise : fallback(),
  );
  await f.client.check();
  const running = f.client.start('lease');
  await Promise.resolve();
  const count = f.states.length;
  f.changeActor();
  gate.resolve(json(session({ status: 'recording' })));
  assert.equal(await running, false);
  assert.equal(f.states.length, count);
  f.client.close();
  const cleanup = f.calls.find((call) => call.url.endsWith('/cancel'));
  assert.ok(cleanup);
  assert.equal(new Headers(cleanup.headers).get('X-OpenBot-Expected-User'), user);
  assert.ok(cleanup.url.includes(wid));
});
test('remount retains unknown generation metadata and requires a server fence before another choice', async () => {
  const saved = session({
    goal: 'PRIVATE_REVIEW_GOAL',
    steps: session().steps.map((s) => ({ ...s, note: 'PRIVATE_NOTE' })),
  });
  const memory = storage();
  const first = fixture((path, _init, fallback) => {
    if (path.endsWith('/generate')) throw new TypeError('unconfirmed request');
    return fallback();
  }, memory);
  first.setSaved(saved);
  await first.client.check();
  await first.client.generate(profile, false);
  assert.equal(first.client.state.uncertain, true);
  const persisted = JSON.stringify([...memory.values]);
  assert.ok(!persisted.includes('PRIVATE_'));
  assert.ok(persisted.includes('expectedRevision'));
  const restored = fixture((path, _init, fallback) => {
    if (path.endsWith('/cancel')) return json({ ...saved, revision: crypto.randomUUID() });
    return fallback();
  }, memory);
  restored.setSaved(saved);
  await restored.client.check();
  assert.equal(restored.client.state.uncertain, true);
  assert.equal(await restored.client.generate(profile, false), false);
  assert.equal(await restored.client.select(saved.id), false);
  assert.equal(restored.calls.filter((c) => c.method === 'POST').length, 0);
  await restored.client.cancel();
  assert.equal(restored.client.state.uncertain, false);
  assert.notEqual(restored.client.state.session?.revision, saved.revision);
  restored.client.close();
});
test('actual review editor preserves changes, removes a real step, explicitly saves and then enables generation', async () => {
  const initial = session({ steps: [...session().steps, ...session().steps] });
  let generated = 0,
    saved: any,
    returned: TeachingSession;
  const props = {
    session: initial,
    models: [{ id: profile, name: 'Connected fixture', configured: true }],
    busy: false,
    onSave: async (body: any) => {
      saved = body;
      returned = {
        ...initial,
        revision: crypto.randomUUID(),
        goal: body.goal,
        steps: initial.steps.filter((s) => body.steps.some((b: any) => b.id === s.id)),
      };
      return returned;
    },
    onGenerate: async () => {
      generated++;
      return true;
    },
  };
  const ui = await harness('web/src/components/TeachingReview.tsx', 'TeachingReview', props, {});
  try {
    await ui.flush();
    const remove = all(ui.tree, (n) => n.type === 'button' && text(n).includes('移除步骤'))[0];
    remove.props.onClick();
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.type === 'li').length, 1);
    assert.equal(ui.button('生成技能草稿').props.disabled, true);
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({ target: { value: profile } });
    await ui.flush();
    ui.button('保存核对后的步骤').props.onClick();
    await ui.flush();
    assert.equal(saved.steps.length, 1);
    assert.equal(saved.expectedRevision, initial.revision);
    assert.equal(generated, 0);
    ui.setProps({ ...props, session: returned! });
    await ui.flush();
    assert.equal(ui.button('生成技能草稿').props.disabled, false);
    ui.button('生成技能草稿').props.onClick();
    await ui.flush();
    assert.equal(generated, 1);
  } finally {
    ui.dispose();
  }
});
test('a changed saved revision does not silently overwrite a dirty review or authorize it', async () => {
  const original = session();
  const props = {
    session: original,
    models: [],
    busy: false,
    onSave: async () => undefined,
    onGenerate: async () => false,
  };
  const ui = await harness('web/src/components/TeachingReview.tsx', 'TeachingReview', props, {});
  try {
    await ui.flush();
    all(ui.tree, (n) => n.type === 'textarea')[0].props.onChange({
      target: { value: 'Unsaved human goal' },
    });
    await ui.flush();
    ui.setProps({
      ...props,
      session: { ...original, revision: crypto.randomUUID(), goal: 'Changed elsewhere' },
    });
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.type === 'textarea')[0].props.value, 'Unsaved human goal');
    assert.equal(ui.button('保存核对后的步骤').props.disabled, true);
    ui.button('载入当前保存记录').props.onClick();
    await ui.flush();
    assert.equal(all(ui.tree, (n) => n.type === 'textarea')[0].props.value, 'Changed elsewhere');
  } finally {
    ui.dispose();
  }
});

test('initial read and an unknown start keep manual input blocked until a matching receipt', async () => {
  let started = '';
  const f = fixture((path, init, fallback) => {
    if (path.endsWith('/teaching') && init.method === 'POST') {
      started = JSON.parse(init.body).requestId;
      throw new TypeError('unconfirmed start');
    }
    return fallback();
  });
  assert.equal(f.client.state.inputBlocked, true);
  assert.equal(await f.client.start('lease'), false);
  await f.client.check();
  assert.equal(f.client.state.inputBlocked, false);
  await f.client.start('lease');
  assert.equal(f.client.state.uncertain, true);
  assert.equal(f.client.state.inputBlocked, true);
  assert.equal(JSON.parse([...f.memory.values.values()][0]).kind, 'start');
  await f.client.check();
  assert.equal(f.client.state.inputBlocked, true);
  f.setSaved(session({ id: started, status: 'recording' }));
  await f.client.check();
  assert.equal(f.client.state.uncertain, false);
  assert.equal(f.client.state.inputBlocked, false);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  f.client.close();
});

test('a lost cancellation stays blocked across remount and stale review reads', async () => {
  const record = session(),
    memory = storage();
  const first = fixture((path, _init, fallback) => {
    if (path.endsWith('/cancel')) throw new TypeError('unconfirmed cancellation');
    return fallback();
  }, memory);
  first.setSaved(record);
  await first.client.check();
  await first.client.cancel();
  assert.equal(first.client.state.uncertain, true);
  const restored = fixture(undefined, memory);
  restored.setSaved(record);
  await restored.client.check();
  assert.equal(restored.client.state.uncertain, true);
  assert.equal(restored.client.state.inputBlocked, true);
  assert.equal(await restored.client.generate(profile, false), false);
  assert.equal(
    await restored.client.save({ expectedRevision: record.revision, goal: 'edit', steps: [] }),
    false,
  );
  assert.equal(await restored.client.select(record.id), false);
  restored.client.newRecording();
  assert.equal(restored.client.state.pendingId, record.id);
  assert.ok(restored.calls.every((c) => c.method === 'GET'));
  restored.setSaved({ ...record, status: 'proposed', skillId: crypto.randomUUID() });
  await restored.client.check();
  assert.equal(restored.client.state.uncertain, false);
  restored.client.close();
});

test('only a matching closure tombstone or direct cancel response resolves cancellation', async () => {
  let mode = 'lost';
  const record = session();
  const f = fixture((path, _init, fallback) => {
    if (path.endsWith('/cancel')) {
      if (mode === 'lost') throw new TypeError('lost');
      return json({ id: mode === 'wrong' ? crypto.randomUUID() : record.id, status: 'closed' });
    }
    if (path.endsWith(`/teaching/${record.id}`) && mode === 'tombstone')
      return json({ code: 'TEACHING_CLOSED' }, 410);
    return fallback();
  });
  f.setSaved(record);
  await f.client.check();
  await f.client.cancel();
  mode = 'wrong';
  assert.equal(await f.client.cancel(), false);
  assert.equal(f.client.state.uncertain, true);
  mode = 'tombstone';
  // A closed ID is excluded from the server list in the real contract.
  f.setSaved(undefined as unknown as TeachingSession);
  await f.client.check();
  assert.equal(f.client.state.pendingId, undefined);
  assert.equal(f.client.state.inputBlocked, false);
  f.client.close();
});

test('legacy IDs and generation metadata migrate without bodies and never replay', async () => {
  const record = session();
  for (const legacy of [
    record.id,
    JSON.stringify({
      id: record.id,
      generation: {
        requestId: crypto.randomUUID(),
        expectedRevision: record.revision,
        profileId: profile,
        acceptInterrupted: false,
      },
    }),
  ]) {
    const memory = storage();
    const key = `openbot-teaching:${JSON.stringify([wid, user, 'bot-a', 'chat-a'])}`;
    memory.setItem(key, legacy);
    const f = fixture(undefined, memory);
    f.setSaved(record);
    await f.client.check();
    assert.equal(f.client.state.uncertain, true);
    const stored = memory.getItem(key)!;
    assert.equal(JSON.parse(stored).version, 2);
    assert.ok(!stored.includes('profileId') && !stored.includes('acceptInterrupted'));
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    f.client.close();
  }
});

test('a second mounted editor cannot replace an unconfirmed request in the same slot', async () => {
  const memory = storage();
  const first = fixture((path, init, fallback) => {
    if (path.endsWith('/teaching') && init.method === 'POST') throw new TypeError('lost');
    return fallback();
  }, memory);
  const second = fixture(undefined, memory);
  await first.client.check();
  await second.client.check();
  await first.client.start('original-lease');
  const id = first.client.state.pendingId;
  assert.equal(second.client.state.inputBlocked, true);
  assert.equal(await second.client.start('other-lease'), false);
  assert.equal(second.calls.filter((c) => c.method === 'POST').length, 0);
  await second.client.check();
  assert.equal(second.client.state.pendingId, id);
  assert.equal(second.client.state.uncertain, true);
  second.client.close();
});

test('recovered recordings cannot attach to a newly acquired control lease', async () => {
  const f = fixture();
  f.setSaved(session({ status: 'recording' }));
  await f.client.check();
  assert.equal(f.client.state.uncertain, false);
  assert.equal(f.client.state.inputBlocked, true);
  f.client.close();
});

test('model changes are checked again before submitting generation', async () => {
  let model = 'original';
  const f = fixture((path, _init, fallback) =>
    path.endsWith('/model-profiles')
      ? json({ profiles: [{ id: profile, name: 'Synthetic model', configured: true, model }] })
      : fallback(),
  );
  f.setSaved(session());
  await f.client.check();
  model = 'replacement';
  assert.equal(await f.client.generate(profile, false), false);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/generate')).length, 0);
  assert.equal(f.client.state.uncertain, false);
  f.client.close();
});

test('actual computer input dispatch respects the teaching gate for keyboard and pointer actions', async () => {
  let blocked = true,
    dispatched = 0;
  const leaseRef = {
    current: {
      leaseId: 'lease',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      width: 1440,
      height: 900,
    },
  };
  const privateFramesPaused = { current: false };
  const { usableLease } = createComputerObservation(
    () => ({ leaseRef, privateFramesPaused }) as any,
  );
  const ctx = {
    leaseRef,
    usableLease,
    inputBusy: false,
    shotAt: new Date().toISOString(),
    get teachingBlocked() {
      return blocked;
    },
    scope: {
      ticket: () => 0,
      request: async () => {
        dispatched++;
      },
    },
    setInputBusy() {},
    setControlError() {},
    setInputText() {},
    current: () => true,
    screenshot: async () => {},
    checkStatus: async () => {},
  };
  const input = createComputerInput(() => ctx as any);
  const click = {
    clientX: 100,
    clientY: 100,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 200 }) },
  } as unknown as Parameters<typeof input.clickScreen>[0];
  await input.manual({ type: 'type', text: 'Synthetic input' });
  input.clickScreen(click);
  assert.equal(dispatched, 0);
  blocked = false;
  await input.manual({ type: 'key', key: 'Enter' });
  input.clickScreen(click);
  assert.equal(dispatched, 2);
  privateFramesPaused.current = true;
  await input.manual({ type: 'key', key: 'Enter' });
  input.clickScreen(click);
  assert.equal(dispatched, 2);
});
