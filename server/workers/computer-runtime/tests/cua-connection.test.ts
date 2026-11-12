import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, chmod, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCuaConnection } from '../cua-connection.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cua-mcp-'));
  const socketPath = join(directory, 'd.sock');
  const executablePath = join(directory, 'driver.cjs');
  const logPath = join(directory, 'events.jsonl');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await writeFile(
    executablePath,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = value => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\n');
log({pid:process.pid, args:process.argv.slice(2), embedded:process.env.CUA_DRIVER_EMBEDDED,
  leaked:!!process.env.BAMBOOSHIFT_CUA_TEST_SECRET});
const tools = ['check_permissions','get_screen_size','get_desktop_state','click','drag','scroll','type_text','press_key'];
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  log({method:request.method, params:request.params});
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion:'2025-11-25', capabilities:{tools:{}}, serverInfo:{name:'owned-test-driver',version:'1'}
  };
  else if (request.method === 'tools/list') result = {tools:tools.map(name=>({name,inputSchema:{type:'object'}}))};
  else if (request.method === 'tools/call') result = {
    structuredContent:{accessibility:false,screen_recording:false},content:[]
  };
  else throw Error('Unexpected method: '+request.method);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`,
    { mode: 0o700 },
  );
  return {
    executablePath,
    socketPath,
    directory,
    logPath,
    async cleanup() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Cua uses the existing MCP SDK with a fixed private proxy command and closes its child', async () => {
  const f = await fixture();
  const previous = process.env.BAMBOOSHIFT_CUA_TEST_SECRET;
  process.env.BAMBOOSHIFT_CUA_TEST_SECRET = 'owned-test-marker';
  let client;
  try {
    client = await openCuaConnection(f, AbortSignal.timeout(10_000));
    const result = await client.call(
      'check_permissions',
      { prompt: false, probe_direct_capture: false },
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(result.structuredContent, { accessibility: false, screen_recording: false });
    await client.close();
    const events = (await readFile(f.logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const event of events.filter((event) => event.pid)) {
      assert.deepEqual(event.args, ['mcp', '--embedded', '--socket', f.socketPath]);
      assert.equal(event.embedded, '1');
      assert.equal(event.leaked, false);
      assert.throws(
        () => process.kill(event.pid, 0),
        (error: any) => error.code === 'ESRCH',
      );
    }
    assert.equal(events.filter((event) => event.method === 'tools/call').length, 1);
    await assert.rejects(client.call('check_permissions', {}, AbortSignal.timeout(1000)), /已结束/);
  } finally {
    if (previous === undefined) delete process.env.BAMBOOSHIFT_CUA_TEST_SECRET;
    else process.env.BAMBOOSHIFT_CUA_TEST_SECRET = previous;
    await client?.close();
    await f.cleanup();
  }
});

test('Cua refuses missing, non-private and symlink sockets before starting a proxy', async () => {
  const f = await fixture();
  try {
    const signal = AbortSignal.timeout(5000);
    await assert.rejects(openCuaConnection({ ...f, socketPath: 'relative.sock' }, signal), /路径/);
    await assert.rejects(
      openCuaConnection({ ...f, socketPath: join(f.directory, 'missing') }, signal),
    );
    await chmod(f.socketPath, 0o666);
    await assert.rejects(openCuaConnection(f, signal), /私有/);
    await chmod(f.socketPath, 0o600);
    const link = join(f.directory, 'link.sock');
    await symlink(f.socketPath, link);
    await assert.rejects(openCuaConnection({ ...f, socketPath: link }, signal), /私有/);
    await assert.rejects(readFile(f.logPath), (error: any) => error.code === 'ENOENT');
  } finally {
    await f.cleanup();
  }
});
