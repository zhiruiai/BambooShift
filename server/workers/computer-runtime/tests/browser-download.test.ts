import test from 'node:test';

import assert from 'node:assert/strict';

import { createServer } from 'node:http';

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { LocalComputer, validateComputerAction } from '../../computer-worker/index.js';

import { MAX_FILE_TRANSFER_BYTES } from '../../../../shared/computer-files.js';

const csv = Buffer.from('label,value\nfixture,42\n');

const optedIn = process.env.OPENBOT_BROWSER_TEST === '1';

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture condition timed out');
    await tick();
  }
}

async function exportFixture() {
  const transfers: Array<{ route: string; sent: number; closed: boolean }> = [];
  let privateHits = 0;
  let hangingReads = 0;
  const privateServer = createServer((_req, res) => {
    privateHits++;
    res.end('Forbidden');
  });
  privateServer.listen(0, '127.0.0.1');
  await new Promise<void>((r) => privateServer.once('listening', r));
  const privateUrl = `http://127.0.0.1:${(privateServer.address() as any).port}`;
  const server = createServer((req, res) => {
    const route = req.url!;
    if (route === '/blob-read-started') {
      hangingReads++;
      res.writeHead(204);
      res.end();
      return;
    }
    if (route === '/redirect') {
      res.writeHead(302, { Location: privateUrl });
      res.end();
      return;
    }
    if (['/csv', '/link.csv', '/large', '/declared-large', '/slow'].includes(route)) {
      res.setHeader('Content-Type', 'text/csv');
      if (route !== '/link.csv')
        res.setHeader('Content-Disposition', 'attachment; filename="untrusted-name.csv"');
      if (route === '/csv' || route === '/link.csv') {
        res.end(csv);
        return;
      }
      const transfer = { route, sent: 0, closed: false };
      transfers.push(transfer);
      if (route === '/declared-large') res.setHeader('Content-Length', MAX_FILE_TRANSFER_BYTES * 8);
      const chunk = Buffer.alloc(route === '/slow' ? 4096 : 64 * 1024, 97);
      const send = () => {
        transfer.sent += chunk.length;
        res.write(chunk);
        if (transfer.sent >= MAX_FILE_TRANSFER_BYTES * 8) res.end();
      };
      send();
      const interval = setInterval(send, route === '/slow' ? 100 : 3);
      res.on('close', () => {
        transfer.closed = true;
        clearInterval(interval);
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Owned export fixture</title>
      <a id="csv" href="/csv">Export CSV</a>
      <a id="link" download href="/link.csv">Explicit anchor download</a>
      <a id="large" href="/large">Large export</a>
      <a id="declared-large" href="/declared-large">Declared large export</a>
      <a id="slow" href="/slow">Slow export</a>
      <a id="redirect" href="/redirect">Blocked export</a>
      <a id="html" href="/html">Ordinary HTML</a>
      <a id="data" download="data.csv" href="data:text/csv;base64,${csv.toString('base64')}">Data CSV</a>
      <button id="blob" onclick="exportBlob(false)">Blob CSV</button>
      <button id="large-blob" onclick="exportBlob(true)">Large Blob</button>
      <button id="hanging-blob" onclick="const nativeFetch=window.fetch; window.fetch=()=>{ nativeFetch('/blob-read-started'); return new Promise(()=>{}); }; exportBlob(false)">Stalled Blob</button>
      <script>function exportBlob(large) { const a=document.createElement('a');
        a.href=URL.createObjectURL(new Blob([large?new Uint8Array(${MAX_FILE_TRANSFER_BYTES + 1}):'label,value\\nfixture,42\\n'],{type:'text/csv'}));
        a.download='blob.csv'; a.click(); }
      </script>`);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const previous = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
  process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = origin;
  return {
    origin,
    transfers,
    get privateHits() {
      return privateHits;
    },
    get hangingReads() {
      return hangingReads;
    },
    async close() {
      if (previous === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = previous;
      server.closeAllConnections();
      privateServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => privateServer.close(() => r())),
      ]);
    },
  };
}

test('browser download requires an explicit selector and safe destination', () => {
  assert.throws(
    () => validateComputerAction({ type: 'browser_download', selector: '#export' }),
    /相对路径/,
  );
  assert.throws(
    () => validateComputerAction({ type: 'browser_download', path: 'result.csv' }),
    /selector/,
  );
  for (const path of ['../result.csv', '/tmp/result.csv', 'C:\\result.csv'])
    assert.throws(
      () => validateComputerAction({ type: 'browser_download', selector: '#export', path }),
      /相对路径/,
    );
  assert.deepEqual(
    validateComputerAction({
      type: 'browser_download',
      selector: '#export',
      path: 'reports/a.csv',
      content: 'ignored',
    }),
    {
      type: 'browser_download',
      selector: '#export',
      path: 'reports/a.csv',
    },
  );
});

test(
  'owned Chrome exports attachment, blob and data files while ordinary downloads remain denied',
  { skip: !optedIn, timeout: 120_000 },
  async (t) => {
    const fixture = await exportFixture();
    const dir = await mkdtemp(join(tmpdir(), 'openbot-browser-download-'));
    const workspace = join(dir, 'workspace');
    const computer = new LocalComputer(workspace, join(dir, 'profile'), {
      downloadTimeoutMs: 2500,
    });
    try {
      await computer.execute({ type: 'browser_navigate', url: fixture.origin });
      await computer.execute({ type: 'browser_click', selector: '#csv' });
      assert.deepEqual(await readdir(workspace), [], 'An ordinary click must not create a file');
      for (const selector of ['#csv', '#link', '#blob', '#data']) {
        t.diagnostic(`Capturing ${selector}`);
        const path = `reports/${selector.slice(1)}.csv`;
        const result = await computer.execute({ type: 'browser_download', selector, path });
        assert.deepEqual(result, { path, name: `${selector.slice(1)}.csv`, size: csv.length });
        assert.deepEqual(await readFile(join(workspace, path)), csv);
      }
      await assert.rejects(
        computer.execute({ type: 'browser_download', selector: '#csv', path: 'reports/csv.csv' }),
        /同名文件/,
      );
      assert.deepEqual(await readFile(join(workspace, 'reports/csv.csv')), csv);
      for (const selector of ['#declared-large', '#large', '#large-blob']) {
        t.diagnostic(`Rejecting ${selector}`);
        await assert.rejects(
          computer.execute({ type: 'browser_download', selector, path: 'rejected.csv' }),
          /10 MiB/,
        );
        await assert.rejects(readFile(join(workspace, 'rejected.csv')), { code: 'ENOENT' });
      }
      await until(() => fixture.transfers.every((item) => item.closed));
      assert.ok(
        fixture.transfers.every((item) => item.sent < MAX_FILE_TRANSFER_BYTES * 2),
        'Reject while receiving, not after the 80 MiB response finishes',
      );
      await assert.rejects(
        computer.execute({ type: 'browser_download', selector: '#redirect', path: 'private.csv' }),
        /超时|取消/,
      );
      assert.equal(fixture.privateHits, 0);
      await computer.execute({ type: 'browser_navigate', url: fixture.origin });
      await assert.rejects(
        computer.execute({ type: 'browser_download', selector: '#html', path: 'html.csv' }),
        /超时|取消/,
      );
      await assert.rejects(readFile(join(workspace, 'html.csv')), { code: 'ENOENT' });
      assert.deepEqual((await readdir(workspace)).sort(), ['reports']);
    } finally {
      await computer.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'owned Chrome interrupts slow exports on abort, timeout and human takeover without partial files',
  { skip: !optedIn, timeout: 120_000 },
  async (t) => {
    const fixture = await exportFixture();
    const dir = await mkdtemp(join(tmpdir(), 'openbot-export-cancel-'));
    const workspace = join(dir, 'workspace');
    const computer = new LocalComputer(workspace, join(dir, 'profile'), {
      // Leave enough time for Chrome to deliver the fixture click and start its
      // stalled reader. Cancellation must still finish within the 5s assertion.
      downloadTimeoutMs: 3000,
    });
    try {
      await computer.execute({ type: 'browser_navigate', url: fixture.origin });
      for (const reason of ['abort', 'timeout', 'takeover', 'close']) {
        const started = Date.now();
        t.diagnostic(`Starting ${reason} export`);
        const abort = new AbortController();
        const before = fixture.transfers.length;
        const operation = computer.execute(
          { type: 'browser_download', selector: '#slow', path: `${reason}.csv` },
          { signal: abort.signal },
        );
        void operation.then(
          () => t.diagnostic(`${reason} unexpectedly completed after ${Date.now() - started} ms`),
          (error) =>
            t.diagnostic(`${reason} ended after ${Date.now() - started} ms: ${error.message}`),
        );
        const rejected = assert.rejects(operation, /取消|超时|关闭|接管/);
        await until(() => fixture.transfers.length > before).catch((error) => {
          throw new Error(`${reason}: download never reached the owned fixture`, { cause: error });
        });
        t.diagnostic(`${reason} fixture started after ${Date.now() - started} ms`);
        if (reason === 'abort') abort.abort();
        if (reason === 'takeover') {
          const lease = await computer.startTakeover();
          await computer.endTakeover(lease.leaseId);
        }
        if (reason === 'close') await computer.close();
        await rejected;
        await until(() => fixture.transfers[before].closed);
        await assert.rejects(readFile(join(workspace, `${reason}.csv`)), { code: 'ENOENT' });
      }
      for (const reason of ['blob-abort', 'blob-timeout']) {
        t.diagnostic(`Starting ${reason} export`);
        await computer.execute({ type: 'browser_navigate', url: fixture.origin });
        const abort = new AbortController();
        const before = fixture.hangingReads;
        const started = Date.now();
        const operation = computer.execute(
          { type: 'browser_download', selector: '#hanging-blob', path: `${reason}.csv` },
          { signal: abort.signal },
        );
        const rejected = assert.rejects(operation, /取消|超时/);
        await until(() => fixture.hangingReads > before);
        t.diagnostic(`${reason} reader started after ${Date.now() - started} ms`);
        if (reason === 'blob-abort') abort.abort();
        await rejected;
        assert.ok(
          Date.now() - started < 5000,
          'A stalled page reader must not keep cancellation pending',
        );
        await assert.rejects(readFile(join(workspace, `${reason}.csv`)), { code: 'ENOENT' });
      }
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      await computer.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
