import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operationCleanupUnknown } from '../computer-operations.js';
import { validateComputerAction } from '../../computer-worker/index.js';
import {
  MAX_COMPUTER_FRAME_INPUT_BYTES,
  framedComputerActionTypes,
} from '../../../../shared/computer-frames.js';

import type { ShellJob, WorkerRoutes } from './types.js';
export function registerExecutionRoutes(context: WorkerRoutes) {
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
  app.post('/shell/cancel', async (req, res) => {
    try {
      const id = req.body?.id;
      let job = shellJobs.get(id);
      if (!job) {
        if (seenShellIds.has(id)) {
          if (!seenShellIds.get(id)) throw new Error('无法确认远程命令已停止，请维护远程电脑。');
          return res.json({ stopped: true });
        }
        // Cancellation may arrive before a delayed execute request. Keep a tombstone.
        job = reserveShell(id);
        job.settled = true;
        seenShellIds.set(id, true);
        job.finish();
      }
      job.abort.abort();
      await job.done;
      if (!job.provenStopped) throw new Error('无法确认远程命令已停止，请维护远程电脑。');
      res.json({ stopped: true, ...(job.result ? { result: job.result } : {}) });
    } catch (error: any) {
      res.status(409).json({ error: error.message });
    }
  });
  app.post('/execute', async (req, res) => {
    if (req.body?.type === 'remote_shell') {
      let job: ShellJob | undefined;
      try {
        const action = validateComputerAction(req.body);
        job = reserveShell(req.get('X-OpenBot-Action-Id'));
        const reserved = job;
        const result = await transfer(
          req,
          res,
          async (signal) => {
            const combined = AbortSignal.any([signal, reserved.abort.signal]);
            combined.throwIfAborted();
            if (runtime.takeoverPending || computer.takeoverStatus().active)
              throw new Error('用户正在接管电脑，远程命令已取消。');
            if (!(await shell.available())) throw new Error('远程命令隔离环境不可用。');
            combined.throwIfAborted();
            reserved.provenStopped = false;
            const result = await shell.run(action.command, action.path, combined);
            reserved.result = result;
            reserved.provenStopped = true;
            return result;
          },
          false,
        );
        res.json(result);
      } catch (error: any) {
        if (!res.destroyed) res.status(400).json({ error: error.message });
      } finally {
        if (job) {
          if (!job.provenStopped) runtime.shellCleanupUnknown = true;
          seenShellIds.set(req.get('X-OpenBot-Action-Id')!, job.provenStopped);
          job.settled = true;
          job.finish();
        }
      }
      return;
    }
    // The control plane already obtained approval. Bearer token possession grants execution.
    const operation = transfer(req, res, async (signal) => {
      signal.throwIfAborted();
      const { content: _content, text: _text, ...summary } = req.body;
      const dir = resolve(options.workspaceDir, '../audit');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(
        resolve(dir, 'computer.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), action: summary }) + '\n',
        { mode: 0o600 },
      );
      if (req.body.type === 'browser_download' && runtime.takeoverPending)
        throw new Error('用户正在接管电脑，网页导出已取消。');
      return computer.execute(req.body, { signal });
    });
    try {
      res.json(await operation);
    } catch (error: any) {
      res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    }
  });
  app.post('/execute-with-frame', async (req, res) => {
    try {
      const action = validateComputerAction(req.body);
      if (!framedComputerActionTypes.has(action.type))
        return res.status(400).json({ error: '此操作不保存历史画面。' });
      const result = await transfer(req, res, async (signal) => {
        signal.throwIfAborted();
        if (runtime.takeoverPending) throw new Error('用户正在接管电脑，请稍后再执行。');
        const version = runtime.generation;
        const { content: _content, text: _text, ...summary } = action;
        const dir = resolve(options.workspaceDir, '../audit');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await appendFile(
          resolve(dir, 'computer.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), action: summary }) + '\n',
          { mode: 0o600 },
        );
        signal.throwIfAborted();
        const result = await computer.execute(action, { signal });
        // This entire operation owns the same Worker queue slot. No other
        // controller can insert a manual input or action between work and image.
        const assertFrameCurrent = () => {
          assertConnection(req);
          if (
            runtime.closed ||
            signal.aborted ||
            runtime.generation !== version ||
            runtime.takeoverPending ||
            computer.takeoverStatus().active
          )
            throw new Error('操作画面已取消。');
        };
        try {
          assertFrameCurrent();
          const png = await computer.screenshot({ forAgent: true, signal });
          assertFrameCurrent();
          if (png.length > MAX_COMPUTER_FRAME_INPUT_BYTES) throw new Error('操作画面过大。');
          return {
            result,
            frame: {
              mimeType: 'image/png',
              data: png.toString('base64'),
              capturedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          if (operationCleanupUnknown(error)) operations.poison();
          return { result, frameUnavailable: '操作已完成，但当时画面未能保存。' };
        }
      });
      res.json(result);
    } catch (error: any) {
      res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    }
  });
}
