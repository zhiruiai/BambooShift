import express from 'express';

import { createComputerWorker } from '../../../../scripts/computer-worker.js';

import type { DesktopAdapter } from '../desktop.js';

const token = 'binary-transfer-fixture-token-123456789';

const sample = Buffer.concat([
  Buffer.from('PRIVATE_BINARY_BYTES_DO_NOT_LOG'),
  Buffer.from([0, 255, 137, 80, 78, 71]),
]);

const desktop = (): DesktopAdapter => ({
  async status() {
    return {
      available: false,
      authorized: false,
      enabled: false,
      width: 0,
      height: 0,
      displays: [],
      permissions: { screenRecording: 'unknown', accessibility: 'unknown' },
    };
  },
  setEnabled() {},
  async close() {},
  async capture() {
    throw new Error('No real screen in this test');
  },
  async execute() {
    throw new Error('No real input in this test');
  },
});

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as any).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function workerAt(workspaceDir: string, intercept?: express.RequestHandler) {
  const worker = createComputerWorker({ token, workspaceDir, desktopAdapter: desktop() });
  const app = express();
  if (intercept) app.use(intercept);
  app.use(worker.app);
  const server = await listen(app);
  const health: any = await (
    await fetch(server.base + '/health', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-OpenBot-Worker-Instance': health.instanceId,
    'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
  };
  return {
    ...server,
    headers,
    async close() {
      await worker.close();
      await server.close();
    },
  };
}
export { workerAt, token, sample };
