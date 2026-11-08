import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalComputer } from '../../computer-worker/index.js';
import { createComputerWorker } from '../../../../scripts/computer-worker.js';

// Opt in because this launches the product's real Chrome execution engine.
test(
  'managed computer operates an owned fixture and blocks redirect to private network',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 180_000 },
  async (t) => {
    let privateHits = 0;
    const privateServer = createServer((_req, res) => {
      privateHits++;
      res.end('PRIVATE CONTROL PLANE');
    }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => privateServer.once('listening', r));
    const privateUrl = `http://127.0.0.1:${(privateServer.address() as any).port}`;
    const fixture = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: privateUrl });
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>OpenBot fixture</title><h1>Owned test page</h1><input id="note" style="position:absolute;left:40px;top:120px;width:300px;height:40px"><button id="save" style="position:absolute;left:360px;top:120px;width:80px;height:40px" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output style="position:absolute;left:40px;top:190px">Waiting</output>',
      );
    }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => fixture.once('listening', r));
    const origin = `http://127.0.0.1:${(fixture.address() as any).port}`;
    const dir = await mkdtemp(join(tmpdir(), 'openbot-browser-'));
    const prior = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = origin;
    let clock = Date.now();
    const computer = new LocalComputer(join(dir, 'workspace'), join(dir, 'profile'), {
      now: () => clock,
    });
    try {
      t.diagnostic('Opening owned browser fixture');
      const navigation: any = await computer.execute({ type: 'browser_navigate', url: origin });
      assert.equal(navigation.title, 'OpenBot fixture');
      t.diagnostic('Fixture opened; testing input and click');
      await computer.execute({
        type: 'browser_type',
        selector: '#note',
        text: 'OpenBot real browser test',
      });
      const clicked: any = await computer.execute({ type: 'browser_click', selector: '#save' });
      assert.match(clicked.text, /OpenBot real browser test/);
      const png = await computer.screenshot();
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      t.diagnostic('Testing manual takeover, credential privacy, expiry and agent resume');
      const lease = await computer.startTakeover();
      assert.equal(computer.takeoverStatus().active, true);
      assert.ok(!JSON.stringify(computer.takeoverStatus()).includes(lease.leaseId));
      await assert.rejects(
        computer.execute({ type: 'browser_click', selector: '#save' }),
        /人工接管/,
      );
      await assert.rejects(computer.screenshot({ forAgent: true }), /人工接管/);
      await assert.rejects(computer.execute({ type: 'browser_screenshot' }), /人工接管/);
      await computer.takeoverInput({ leaseId: lease.leaseId, type: 'click', x: 100, y: 140 });
      await computer.takeoverInput({ leaseId: lease.leaseId, type: 'key', key: 'ControlOrMeta+A' });
      await computer.takeoverInput({
        leaseId: lease.leaseId,
        type: 'type',
        text: 'manual-only-secret',
      });
      await computer.takeoverInput({ leaseId: lease.leaseId, type: 'click', x: 400, y: 140 });
      assert.equal(
        (await computer.screenshot({ leaseId: lease.leaseId })).subarray(1, 4).toString(),
        'PNG',
      );
      const audit = await readFile(join(dir, 'computer/takeover.jsonl'), 'utf8');
      assert.ok(!audit.includes('manual-only-secret'));
      assert.ok(!audit.includes(lease.leaseId));
      await computer.endTakeover(lease.leaseId);
      const afterTakeover: any = await computer.execute({
        type: 'browser_click',
        selector: '#save',
      });
      assert.match(afterTakeover.text, /manual-only-secret/);
      const expired = await computer.startTakeover();
      clock += 300_001;
      await assert.rejects(
        computer.takeoverInput({ leaseId: expired.leaseId, type: 'click', x: 100, y: 140 }),
        /过期/,
      );
      assert.equal(computer.takeoverStatus().active, false);
      assert.equal(
        ((await computer.execute({ type: 'browser_screenshot' })) as any).mimeType,
        'image/png',
      );
      t.diagnostic('Screenshot verified; testing blocked redirect');
      try {
        await computer.execute({ type: 'browser_navigate', url: `${origin}/redirect` });
      } catch {
        /* Chromium may surface the blocked proxy response as a navigation error. */
      }
      assert.equal(privateHits, 0, 'Redirect must not contact the forbidden local server');
      const lastLease = await computer.startTakeover();
      await computer.close();
      await assert.rejects(
        computer.takeoverInput({ leaseId: lastLease.leaseId, type: 'key', key: 'Enter' }),
        /失效/,
      );
    } finally {
      t.diagnostic('Closing test-owned browser');
      await computer.close();
      if (prior === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = prior;
      await Promise.all([
        new Promise<void>((r) => fixture.close(() => r())),
        new Promise<void>((r) => privateServer.close(() => r())),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'remote worker takeover requires bearer and isolates manual input from agent observation',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 180_000 },
  async () => {
    const fixture = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>Worker fixture</title><input style="position:absolute;left:40px;top:40px;width:200px;height:40px"><button style="position:absolute;left:260px;top:40px;width:80px;height:40px" onclick="document.body.dataset.saved=document.querySelector(\'input\').value">Save</button>',
      );
    }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => fixture.once('listening', r));
    const origin = `http://127.0.0.1:${(fixture.address() as any).port}`;
    const prior = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = origin;
    const dir = await mkdtemp(join(tmpdir(), 'openbot-takeover-worker-'));
    const token = 'test-worker-takeover-secret-123456';
    const worker = createComputerWorker({ token, workspaceDir: join(dir, 'workspace') });
    const server = worker.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const health: any = await (
      await fetch(base + '/health', { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-OpenBot-Worker-Instance': health.instanceId,
      'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
    };
    const post = (path: string, body: unknown = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(base + '/takeover/start', { method: 'POST' })).status, 401);
      const started = await post('/takeover/start');
      assert.equal(started.status, 200);
      const lease: any = await started.json();
      assert.equal((await post('/execute', { type: 'browser_navigate', url: origin })).status, 400);
      assert.equal((await post('/execute', { type: 'browser_screenshot' })).status, 400);
      const status = await (await fetch(base + '/takeover/status', { headers })).json();
      assert.ok(!JSON.stringify(status).includes(lease.leaseId));
      assert.equal(
        (await post('/takeover/input', { leaseId: lease.leaseId, type: 'navigate', url: origin }))
          .status,
        200,
      );
      assert.equal(
        (await post('/takeover/input', { leaseId: lease.leaseId, type: 'click', x: 100, y: 60 }))
          .status,
        200,
      );
      assert.equal(
        (
          await post('/takeover/input', {
            leaseId: lease.leaseId,
            type: 'type',
            text: 'private-input',
          })
        ).status,
        200,
      );
      assert.equal(
        (await post('/takeover/input', { leaseId: lease.leaseId, type: 'click', x: 300, y: 60 }))
          .status,
        200,
      );
      assert.equal((await fetch(base + '/screenshot', { headers })).status, 409);
      assert.equal(
        (
          await fetch(base + '/screenshot', {
            headers: { ...headers, 'X-OpenBot-Computer-Lease': lease.leaseId },
          })
        ).status,
        200,
      );
      assert.equal((await post('/takeover/end', { leaseId: lease.leaseId })).status, 200);
      const observed = await post('/execute', { type: 'browser_screenshot' });
      assert.equal(observed.status, 200);
      assert.equal(((await observed.json()) as any).mimeType, 'image/png');
      assert.equal(
        (await post('/takeover/input', { leaseId: lease.leaseId, type: 'key', key: 'Enter' }))
          .status,
        409,
      );
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => fixture.close(() => r()));
      if (prior === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = prior;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
