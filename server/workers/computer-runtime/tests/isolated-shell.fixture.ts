import express from 'express';
import { createComputerWorker } from '../http/worker.js';

import { once } from 'node:events';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import type { DesktopAdapter } from '../desktop.js';

const token = 'synthetic-isolated-worker-token-1234567890';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Fixture deadline exceeded');
    await delay(15);
  }
}

async function exists(path: string) {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

function desktop(): DesktopAdapter {
  let enabled = false;
  return {
    async status() {
      return {
        available: true,
        authorized: true,
        enabled,
        width: 100,
        height: 100,
        displays: [],
        permissions: { screenRecording: 'granted', accessibility: 'granted' },
      };
    },
    setEnabled(value) {
      enabled = value;
    },
    async close() {},
    async capture() {
      throw new Error('No real desktop capture in this fixture');
    },
    async execute() {
      return { ok: true };
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-isolated-shell-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const script = join(dir, 'supervisor.mjs');
  // This is a protocol fixture, not an isolation implementation. It never runs user code.
  await writeFile(
    script,
    `
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
const workspace = ${JSON.stringify(workspace)};
const emit = (value) => { process.stdout.write(JSON.stringify(value), () => process.exit(0)); };
const output = (fields={}) => ({ version:1,stdout:'',stderr:'',exitCode:0,truncated:false,timedOut:false,cancelled:false,durationMs:1,...fields });
if (process.argv[2] === '--probe') {
  emit({version:1,available:!existsSync(workspace+'/fail-probe'),capability:'isolated-shell-v1',workspace});
} else {
  let input='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const request = JSON.parse(input);
    appendFileSync(workspace+'/runs.log', request.command+'\\n');
    if (request.command === 'wait') {
      writeFileSync(workspace+'/started','yes');
      let stopping=false;
      process.on('SIGTERM', () => {
        if (stopping) return;
        stopping=true;
        setTimeout(() => { writeFileSync(workspace+'/stopped','yes'); emit(output({cancelled:true,exitCode:null,signal:'SIGTERM',durationMs:180})); }, 180);
      });
      setInterval(() => {}, 1000);
    } else if (request.command === 'oversized') emit(output({stdout:'x'.repeat(262145)}));
    else if (request.command === 'broken') { process.stderr.write('/private/supervisor/SECRET'); emit({version:1,error:'ISOLATION_UNAVAILABLE',private:'SECRET'}); }
    else if (request.command === 'timeout') emit(output({timedOut:true,exitCode:null,signal:'SIGKILL'}));
    else if (request.command === 'memory') emit(output({resourceLimit:'memory',exitCode:null,signal:'SIGKILL'}));
    else emit(output({stdout:JSON.stringify({request,env:process.env}),stderr:'synthetic stderr',exitCode:7}));
  });
}
`,
  );
  const config = { interpreterPath: process.execPath, supervisorPath: script };
  return { dir, workspace, config, close: () => rm(dir, { recursive: true, force: true }) };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export { fixture, desktop, listen, until, exists, delay, token };

export async function connected() {
  const f = await fixture();
  const worker = createComputerWorker({
    token,
    workspaceDir: f.workspace,
    desktopAdapter: desktop(),
    isolatedShell: f.config,
  });
  const server = await listen(worker.app);
  const health = await (
    await fetch(server.base + '/health', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  return {
    ...f,
    worker,
    workerBase: server.base,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-OpenBot-Worker-Instance': health.instanceId,
      'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
      'Content-Type': 'application/json',
    },
    async close() {
      await worker.close();
      await server.close();
      await f.close();
    },
  };
}
