import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createComputerWorkerPool } from '../../../../scripts/computer-worker.js';
import { COMPUTER_OPERATION_ID_HEADER } from '../../../../shared/computer-operations.js';
import {
  SCREEN_ID_HEADER,
  WORKSPACE_SCOPE_HEADER,
  type ComputerScreenPoolConfiguration,
} from '../../../../shared/computer-screens.js';
import type { DesktopAdapter, DesktopInput } from '../desktop.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface TestDesktop extends DesktopAdapter {
  inputs: DesktopInput[];
  beforeInput?: (signal?: AbortSignal) => Promise<void>;
  beforeCapture?: (signal?: AbortSignal) => Promise<void>;
  generation: string;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-screen-pool-'));
  const configuration: ComputerScreenPoolConfiguration = {
    version: 1,
    workspaceScopeId: randomUUID(),
    screens: [0, 1].map(() => {
      const id = randomUUID();
      return {
        id: randomUUID(),
        session: { id, generation: randomUUID() },
        manifestPath: `/opt/openbot/desktop/sessions/${id}/manifest.json`,
      };
    }),
  };
  const png = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#735cad' },
  })
    .png()
    .toBuffer();
  const adapters = configuration.screens.map((screen): TestDesktop => {
    let enabled = false;
    return {
      inputs: [],
      generation: screen.session.generation,
      async status() {
        return {
          kind: 'virtual',
          session: { id: screen.session.id, generation: this.generation },
          available: true,
          authorized: true,
          enabled,
          width: 120,
          height: 80,
          displays: [],
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        };
      },
      async capture({ signal } = {}) {
        await this.beforeCapture?.(signal);
        return { png, width: 120, height: 80, capturedAt: new Date().toISOString() };
      },
      async execute(input, { signal } = {}) {
        this.inputs.push(input);
        await this.beforeInput?.(signal);
        return { ok: true };
      },
      setEnabled(value) {
        enabled = value;
      },
      async close() {
        enabled = false;
      },
    };
  });
  const token = 'synthetic-screen-pool-worker-token-1234';
  const worker = createComputerWorkerPool({
    token,
    workspaceDir: join(directory, 'workspace'),
    configuration,
    interpreterPath: '/not-used/python',
    helperPath: '/not-used/helper',
    desktopAdapterFor: (screen) =>
      adapters[configuration.screens.findIndex((candidate) => candidate.id === screen.id)],
  });
  const server = worker.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = await (
    await fetch(base + '/health', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const machineHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-OpenBot-Worker-Instance': health.instanceId,
    'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
    [WORKSPACE_SCOPE_HEADER]: configuration.workspaceScopeId,
  };
  const headers = (index: number) => ({
    ...machineHeaders,
    [SCREEN_ID_HEADER]: configuration.screens[index].id,
    'X-OpenBot-Desktop-Session': configuration.screens[index].session.id,
    'X-OpenBot-Desktop-Generation': configuration.screens[index].session.generation,
  });
  const url = (index: number, path: string) =>
    base + '/screens/' + configuration.screens[index].id + path;
  const post = (
    index: number,
    path: string,
    body: unknown,
    operationId?: string,
    signal?: AbortSignal,
  ) =>
    fetch(url(index, path), {
      method: 'POST',
      headers: {
        ...headers(index),
        ...(operationId ? { [COMPUTER_OPERATION_ID_HEADER]: operationId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  for (const index of [0, 1])
    assert.equal(
      (await post(index, '/surface', { surface: 'desktop', confirm: true })).status,
      200,
    );
  return {
    configuration,
    adapters,
    base,
    headers,
    machineHeaders,
    health,
    url,
    post,
    async close() {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export { deferred, fixture, TestDesktop };
