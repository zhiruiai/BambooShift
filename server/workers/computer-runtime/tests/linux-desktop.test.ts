import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinuxDesktopAdapter } from '../linux-desktop.js';
import type { DesktopAdapter } from '../desktop.js';
import { parseDesktopSession, sameDesktopSession } from '../../../../shared/linux-desktop.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function exists(path: string) {
  return readFile(path).then(
    () => true,
    () => false,
  );
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Fixture deadline exceeded');
    await delay(10);
  }
}
async function fixture(
  mode = 'normal',
  overrides: { timeoutMs?: number; cleanupWaitMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-linux-desktop-'));
  const helperPath = join(dir, 'helper.mjs');
  const manifestPath = join(dir, 'fixture.json');
  const session = { id: randomUUID(), generation: randomUUID() };
  let current = { mode, session };
  await writeFile(manifestPath, JSON.stringify(current), { mode: 0o600 });
  // Controlled protocol fixture only: no X server, capture tool or actual input is started.
  await writeFile(
    helperPath,
    `
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
const dir = ${JSON.stringify(dir)};
let input='';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input+=chunk);
process.stdin.on('end', () => {
 const config=JSON.parse(readFileSync(process.argv[3], 'utf8')), request=JSON.parse(input);
 appendFileSync(dir+'/requests.jsonl',JSON.stringify({request,env:process.env,argv:process.argv})+'\\n');
 const emit=(value,code=0) => process.stdout.write(JSON.stringify(value),()=>process.exit(code));
 const success=result=>emit({ok:true,result});
 const error=(code,cleanupConfirmed=true)=>emit({ok:false,error:{code,cleanupConfirmed,message:'/private/fixture/DO_NOT_EXPOSE'}},2);
 if (config.mode === 'malformed') { process.stderr.write('SECRET_ON_STDERR'); return emit({garbage:'/private/SECRET'}); }
 if (config.mode === 'status-unavailable') return error('DESKTOP_UNAVAILABLE');
 if (request.op==='status') return success({kind:config.mode==='host'?'host':'virtual',available:true,authorized:true,
   session:config.session,width:1,height:1,displayId:1,
   displays:[{id:1,x:0,y:0,logicalWidth:1,logicalHeight:1,pixelWidth:1,pixelHeight:1,privateDiagnostic:'DO_NOT_EXPOSE'}],
   permissions:{screenRecording:'granted',accessibility:'granted'}});
 if (config.mode==='stale-session') return error('STALE_SESSION');
 if (request.op==='capture') return success({png:${JSON.stringify(png)},width:config.mode==='wrong-png'?2:1,height:1,
   capturedAt:new Date().toISOString(),displayId:1,geometryToken:'fixed-geometry',session:config.session});
 if (config.mode==='safe-input-failure') return error('INPUT_FAILED');
 if (config.mode==='hold' || config.mode==='ignore-until-release' || config.mode==='cleanup-unknown' || config.mode==='cancel-stale') {
   writeFileSync(dir+'/started',String(process.pid)); let stopping=false;
   process.on('SIGTERM',()=>{
     writeFileSync(dir+'/term','TERM');
     if (config.mode==='ignore-until-release') return;
     if (stopping) return; stopping=true;
     setTimeout(()=>{writeFileSync(dir+'/released','yes');error(config.mode==='cancel-stale'?'STALE_SESSION':'CANCELLED',config.mode!=='cleanup-unknown');},180);
   });
   setInterval(()=>{if(config.mode==='ignore-until-release'&&existsSync(dir+'/release-now')) {writeFileSync(dir+'/released','yes');error('CANCELLED');}},20);
   return;
 }
 if (request.enabled!==true || request.frame?.geometryToken!=='fixed-geometry') return error('INVALID_REQUEST');
 return success({ok:true,session:config.session,geometryToken:'fixed-geometry'});
});
`,
  );
  const options = {
    interpreterPath: process.execPath,
    helperPath,
    manifestPath,
    platform: 'linux' as const,
    ...overrides,
  };
  const adapter = createLinuxDesktopAdapter(options);
  const logs = async () =>
    (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    dir,
    adapter,
    options,
    session,
    logs,
    async update(next: Partial<typeof current>) {
      current = { ...current, ...next };
      await writeFile(manifestPath, JSON.stringify(current), { mode: 0o600 });
    },
    async ready(instance: DesktopAdapter = adapter) {
      assert.equal((await instance.status()).authorized, true);
      instance.setEnabled(true);
      return instance.capture();
    },
    async close() {
      await writeFile(join(dir, 'release-now'), 'yes');
      await adapter.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('Linux adapter status is read-only, starts disabled, and requires a real bounded frame before input', async () => {
  const f = await fixture();
  try {
    const status = await f.adapter.status();
    assert.equal(status.kind, 'virtual');
    assert.equal(status.enabled, false);
    assert.deepEqual(status.session, f.session);
    assert.equal(JSON.stringify(status).includes('DO_NOT_EXPOSE'), false);
    assert.deepEqual(
      (await f.logs()).map((entry) => entry.request.op),
      ['status'],
    );
    await assert.rejects(f.adapter.capture(), /尚未/);
    f.adapter.setEnabled(true);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
    const frame = await f.adapter.capture();
    assert.deepEqual(frame.png, Buffer.from(png, 'base64'));
    assert.deepEqual(await f.adapter.execute({ type: 'click', x: 0.5, y: 0.5 }), { ok: true });
    await assert.rejects(f.adapter.execute({ type: 'click', x: 1, y: 0 }), /超出/);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Shell+L' }), /不支持/);
    const logs = await f.logs();
    assert.deepEqual(
      logs.map((entry) => entry.request.op),
      ['status', 'capture', 'input'],
    );
    assert.deepEqual(logs[2].request.session, f.session);
    assert.equal(logs[2].request.frame.geometryToken, 'fixed-geometry');
  } finally {
    await f.close();
  }
});

test('desktop session references are strict lowercase UUID pairs and never equate two invalid values', () => {
  const session = { id: randomUUID(), generation: randomUUID() };
  assert.deepEqual(parseDesktopSession({ ...session, privatePath: '/not-public' }), session);
  assert.equal(sameDesktopSession(session, { ...session }), true);
  assert.equal(sameDesktopSession(undefined, undefined), false);
  assert.equal(sameDesktopSession({}, {}), false);
  assert.equal(parseDesktopSession({ ...session, id: session.id.toUpperCase() }), undefined);
  assert.equal(
    parseDesktopSession({ ...session, generation: session.generation + '\n' }),
    undefined,
  );
  assert.equal(parseDesktopSession(Object.create(session)), undefined);
  assert.equal(sameDesktopSession(session, { ...session, generation: randomUUID() }), false);
});

test('invalid Unicode and duplicate Linux modifier aliases never start a helper or disable a good frame', async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const key of [
      'Control+ControlOrMeta+A',
      'Meta+Command+Space',
      'Alt+Option+Tab',
      'Shift+Shift+A',
    ])
      await assert.rejects(f.adapter.execute({ type: 'key', key }), /重复/);
    for (const text of ['\ud800', '\udfff', 'left\ud800right', '🙂\udfff'])
      await assert.rejects(f.adapter.execute({ type: 'type', text }), /不完整的 Unicode/);
    for (const text of ['中'.repeat(301), '🙂'.repeat(151)])
      await assert.rejects(f.adapter.execute({ type: 'type', text }), /最多粘贴 300/);
    assert.deepEqual(
      (await f.logs()).map((entry) => entry.request.op),
      ['status', 'capture'],
    );
    // No new screenshot is needed: rejected input cannot consume or invalidate it.
    await f.adapter.execute({ type: 'key', key: 'ControlOrMeta+Shift+A' });
    await f.adapter.execute({ type: 'type', text: '完整字符：你好🙂𠮷' });
    assert.equal((await f.adapter.status()).available, true);
    assert.deepEqual(
      (await f.logs()).map((entry) => entry.request.op),
      ['status', 'capture', 'input', 'input', 'status'],
    );
  } finally {
    await f.close();
  }
});

test('capture and input replies cannot silently switch a pinned Linux desktop generation', async () => {
  for (const operation of ['capture', 'input']) {
    const f = await fixture();
    try {
      await f.ready();
      await f.update({ session: { id: f.session.id, generation: randomUUID() } });
      if (operation === 'capture') await assert.rejects(f.adapter.capture(), /会话已变更/);
      else await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /会话已变更/);
      assert.equal((await f.adapter.status()).available, false);
    } finally {
      await f.close();
    }
  }
});

test('Linux helper receives only fixed configuration paths, a minimal environment, and bounded Unicode stdin', async () => {
  const f = await fixture();
  const keys = ['OPENBOT_WORKER_TOKEN', 'DISPLAY', 'XAUTHORITY', 'OPENAI_API_KEY'];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => {
    process.env[key] = 'SYNTHETIC_MUST_NOT_REACH_HELPER';
  });
  try {
    await f.ready();
    await f.adapter.execute({ type: 'type', text: '合成输入🙂\n--display :0' });
    await f.adapter.execute({ type: 'type', text: '\u0001'.repeat(300) });
    const logs = await f.logs();
    for (const entry of logs) {
      for (const key of keys) assert.equal(entry.env[key], undefined);
      assert.equal(entry.env.HOME, undefined);
      assert.deepEqual(entry.argv.slice(2), ['--manifest', f.options.manifestPath]);
    }
    assert.equal(logs[2].request.input.text, '合成输入🙂\n--display :0');
    assert.equal(logs[3].request.input.text.length, 300);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await f.close();
  }
});

test('Linux adapter pins the first verified session and cannot migrate old frames after desktop restart', async () => {
  const f = await fixture();
  try {
    await f.ready();
    await f.update({ session: { id: f.session.id, generation: randomUUID() } });
    const changed = await f.adapter.status();
    assert.equal(changed.available, false);
    assert.match(changed.reason!, /会话已变更/);
    assert.deepEqual(changed.session, f.session);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /会话已变更/);
    await f.update({ session: f.session });
    assert.equal(
      (await f.adapter.status()).available,
      false,
      'restoring a file cannot unpoison a pinned instance',
    );
    assert.throws(() => f.adapter.setEnabled(true), /会话已变更/);
    const newInstance = createLinuxDesktopAdapter(f.options);
    try {
      assert.equal((await newInstance.status()).available, true);
    } finally {
      await newInstance.close();
    }
  } finally {
    await f.close();
  }
});

test('Linux expected identity, host identity, malformed helpers and incorrect PNGs fail closed without private diagnostics', async () => {
  const f = await fixture();
  const expected = createLinuxDesktopAdapter({
    ...f.options,
    expectedSessionId: randomUUID(),
    expectedGeneration: f.session.generation,
  });
  try {
    assert.equal((await expected.status()).available, false);
    await f.update({ mode: 'host' });
    assert.equal((await f.adapter.status()).available, false);
    for (const mode of ['malformed', 'status-unavailable', 'wrong-png']) {
      await f.update({ mode });
      const adapter = createLinuxDesktopAdapter(f.options);
      try {
        if (mode === 'wrong-png') {
          assert.equal((await adapter.status()).available, true);
          adapter.setEnabled(true);
          await assert.rejects(adapter.capture());
        }
        const status = await adapter.status();
        assert.equal(status.available, false);
        assert.doesNotMatch(JSON.stringify(status), /SECRET|private|DO_NOT_EXPOSE/);
        assert.throws(() => adapter.setEnabled(true));
      } finally {
        await adapter.close();
      }
    }
    const invalid = createLinuxDesktopAdapter({ ...f.options, manifestPath: 'relative/manifest' });
    assert.equal((await invalid.status()).available, false);
  } finally {
    await expected.close();
    await f.close();
  }
});

test('Linux cancellation waits for explicit input-release acknowledgement and process exit before another input', async () => {
  const f = await fixture('hold');
  try {
    await f.ready();
    const abort = new AbortController();
    const operation = f.adapter.execute(
      { type: 'drag', x: 0, y: 0, toX: 0.5, toY: 0.5, durationMs: 100 },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(operation, /取消/);
    await until(() => exists(join(f.dir, 'started')));
    const pid = Number(await readFile(join(f.dir, 'started'), 'utf8'));
    abort.abort();
    await delay(40);
    assert.equal(await exists(join(f.dir, 'released')), false);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /尚未完成/);
    await rejected;
    assert.equal(await exists(join(f.dir, 'released')), true);
    assert.throws(
      () => process.kill(pid, 0),
      (error: any) => error.code === 'ESRCH',
    );
    assert.equal((await f.adapter.status()).available, true);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
    await f.update({ mode: 'normal' });
    await f.adapter.capture();
    assert.deepEqual(await f.adapter.execute({ type: 'key', key: 'Enter' }), { ok: true });
  } finally {
    await f.close();
  }
});

test('Linux cancellation with unknown cleanup or a stale-session reply permanently disables the adapter', async () => {
  for (const mode of ['cleanup-unknown', 'cancel-stale']) {
    const f = await fixture(mode);
    try {
      await f.ready();
      const abort = new AbortController();
      const operation = f.adapter.execute({ type: 'key', key: 'Enter' }, { signal: abort.signal });
      const rejected = assert.rejects(operation, /释放|会话已变更/);
      await until(() => exists(join(f.dir, 'started')));
      abort.abort();
      await rejected;
      assert.equal((await f.adapter.status()).available, false);
      assert.throws(() => f.adapter.setEnabled(true));
    } finally {
      await f.close();
    }
  }
});

test('Linux watchdog never kills an unresponsive supervisor or releases its input slot early', async () => {
  const f = await fixture('ignore-until-release', { timeoutMs: 500, cleanupWaitMs: 80 });
  try {
    await f.ready();
    const operation = f.adapter.execute({ type: 'key', key: 'Enter' });
    const rejected = assert.rejects(operation, /停用|超时|取消/);
    await until(() => exists(join(f.dir, 'term')));
    const pid = Number(await readFile(join(f.dir, 'started'), 'utf8'));
    await delay(130);
    process.kill(pid, 0);
    assert.equal((await f.adapter.status()).available, false);
    let ended = false;
    void operation.then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    await delay(20);
    assert.equal(ended, false);
    await writeFile(join(f.dir, 'release-now'), 'yes');
    await rejected;
    assert.throws(
      () => process.kill(pid, 0),
      (error: any) => error.code === 'ESRCH',
    );
  } finally {
    await f.close();
  }
});

test('Linux close waits for cleanup, clears the old frame, and adapters keep independent identity and enabled state', async () => {
  const a = await fixture('hold'),
    b = await fixture();
  try {
    await a.ready();
    await b.ready();
    const operation = a.adapter.execute({ type: 'key', key: 'Enter' });
    const rejected = assert.rejects(operation, /取消/);
    await until(() => exists(join(a.dir, 'started')));
    await a.adapter.close();
    await rejected;
    assert.equal(await exists(join(a.dir, 'released')), true);
    assert.equal((await a.adapter.status()).enabled, false);
    assert.equal((await b.adapter.status()).enabled, true);
    assert.deepEqual((await b.adapter.status()).session, b.session);
    assert.deepEqual(await b.adapter.execute({ type: 'key', key: 'Enter' }), { ok: true });
    a.adapter.setEnabled(true);
    await assert.rejects(a.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
  } finally {
    await a.close();
    await b.close();
  }
});

test('a controlled input failure preserves the verified session but demands a fresh frame', async () => {
  const f = await fixture('safe-input-failure');
  try {
    await f.ready();
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /未确认输入/);
    assert.equal((await f.adapter.status()).available, true);
    await assert.rejects(f.adapter.execute({ type: 'key', key: 'Enter' }), /截图/);
  } finally {
    await f.close();
  }
});
