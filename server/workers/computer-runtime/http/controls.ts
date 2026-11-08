import { pngDimensions } from '../../computer-worker/index.js';

import type { WorkerRoutes } from './types.js';
export const PRIVATE_TAKEOVER_FRAMES_CAPABILITY = 'private-takeover-frames-v1';

export function registerControlsRoutes(context: WorkerRoutes) {
  const {
    app,
    options,
    computer,
    shell,
    runtime,
    operations,
    shellJobs,
    seenShellIds,
    reserveShell,
    cancelShells,
    workerCapabilities,
    assertConnection,
    assertDesktopSession,
    enqueue,
    transfer,
  } = context;
  app.get('/screenshot', async (req, res) => {
    try {
      const leaseId = req.get('X-OpenBot-Computer-Lease');
      // The same queue owns takeover start, input, end, and the frame checks.
      const png = await transfer(req, res, (signal) => computer.screenshot({ signal, leaseId }));
      const size = pngDimensions(png);
      res
        .set('X-Captured-At', new Date().toISOString())
        .set('X-Frame-Width', String(size.width))
        .set('X-Frame-Height', String(size.height))
        .set('X-Computer-Surface', computer.status().surface)
        .type('png')
        .send(png);
    } catch (error: any) {
      res.status(error.status ?? 503).json({ error: error.message, code: error.code });
    }
  });
  app.post('/surface', async (req, res) => {
    if (
      !['browser', 'desktop'].includes(req.body.surface) ||
      (req.body.surface === 'desktop' && req.body.confirm !== true)
    )
      return res.status(400).json({ error: '请明确确认开启整机桌面。' });
    runtime.surfaceChanging++;
    try {
      await assertDesktopSession(req);
      assertConnection(req);
      runtime.generation++;
      computer.cancelTakeover();
      await computer.cancelBrowserDownload('电脑界面已切换，网页导出已取消。');
      await cancelShells();
      const state = await transfer(req, res, (signal) =>
        computer.setSurface(req.body.surface, req.body.confirm === true, { signal }),
      );
      res.json({ ...state, capabilities: await workerCapabilities(state.capabilities) });
    } catch (error: any) {
      res.status(409).json({ error: error.message, code: error.code });
    } finally {
      runtime.surfaceChanging--;
    }
  });
  app.get('/takeover/status', (_req, res) => res.json(computer.takeoverStatus()));
  app.post('/takeover/start', async (req, res) => {
    if (runtime.takeoverPending) return res.status(409).json({ error: '正在准备接管，请稍候。' });
    runtime.takeoverPending = true;
    try {
      await assertDesktopSession(req);
      assertConnection(req);
      await computer.cancelBrowserDownload('用户正在接管电脑，网页导出已取消。');
      await cancelShells();
      const lease = await enqueue(() => computer.startTakeover(), req);
      if (res.destroyed) {
        await computer.endTakeover(lease.leaseId);
        return;
      }
      res.json(lease);
    } catch (error: any) {
      res.status(409).json({ error: error.message, code: error.code });
    } finally {
      runtime.takeoverPending = false;
    }
  });
  app.post('/takeover/input', async (req, res) => {
    try {
      res.json(await transfer(req, res, (signal) => computer.takeoverInput(req.body, { signal })));
    } catch (error: any) {
      res.status(409).json({ error: error.message, code: error.code });
    }
  });
  app.post('/takeover/end', async (req, res) => {
    try {
      res.json(await enqueue(() => computer.endTakeover(req.body.leaseId), req));
    } catch (error: any) {
      res.status(409).json({ error: error.message, code: error.code });
    }
  });
}
