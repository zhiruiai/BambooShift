import express from 'express';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  computerFileErrorMessage,
  listComputerFiles,
  readComputerFile,
  validateComputerPath,
  writeComputerFile,
} from '../computer-files.js';
import { MAX_FILE_TRANSFER_BYTES } from '../../../../shared/computer-files.js';

import type { WorkerRoutes } from './types.js';
export function registerFilesRoutes(context: WorkerRoutes) {
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
  const auditFile = async (type: string, path: string, size?: number) => {
    const dir = resolve(options.workspaceDir, '../audit');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(dir, 'computer.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), action: { type, path, size } }) + '\n',
      { mode: 0o600 },
    );
  };
  app.get('/files', async (req, res) => {
    try {
      const path = validateComputerPath(req.query.path, '.');
      res.json(
        await transfer(req, res, (signal) => listComputerFiles(options.workspaceDir, path, signal)),
      );
    } catch (error: any) {
      res
        .status(error.status ?? 400)
        .json({ error: computerFileErrorMessage(error), code: error.code });
    }
  });
  app.get('/files/content', async (req, res) => {
    try {
      const path = validateComputerPath(req.query.path);
      const bytes = await transfer(req, res, async (signal) => {
        const bytes = await readComputerFile(options.workspaceDir, path, signal);
        await auditFile('download_file', path, bytes.length);
        return bytes;
      });
      res.type('application/octet-stream').send(bytes);
    } catch (error: any) {
      res
        .status(error.status ?? 400)
        .json({ error: computerFileErrorMessage(error), code: error.code });
    }
  });
  app.put(
    '/files/content',
    express.raw({
      type: 'application/octet-stream',
      limit: MAX_FILE_TRANSFER_BYTES,
      inflate: false,
    }),
    async (req, res) => {
      try {
        const path = validateComputerPath(req.query.path);
        if (!Buffer.isBuffer(req.body))
          return res
            .status(415)
            .json({ error: '文件传输需要 application/octet-stream 原始字节。' });
        await transfer(req, res, async (signal) => {
          await auditFile('upload_file', path, req.body.length);
          await writeComputerFile(options.workspaceDir, path, req.body, signal);
        });
        res.status(201).json({ path, size: req.body.length });
      } catch (error: any) {
        res.status(error.status ?? (error.code === 'EEXIST' ? 409 : 400)).json({
          error: computerFileErrorMessage(error),
          code: error.code,
        });
      }
    },
  );
}
