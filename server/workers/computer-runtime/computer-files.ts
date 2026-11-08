import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { MAX_FILE_TRANSFER_BYTES, type ComputerFileListing } from '../../../shared/computer-files.js';

export function computerFileErrorMessage(error: any): string {
  if (error?.code === 'EEXIST') return '目标位置已有同名文件，请换一个文件名。';
  if (error?.code === 'ENOENT') return '文件或目录不存在，请刷新后重试。';
  return error instanceof Error ? error.message : String(error);
}

export function validateComputerPath(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split(/[\\/]/).includes('..')
  )
    throw new Error('只能访问工作区内的相对路径。');
  return value.replaceAll('\\', '/');
}

/** Compatibility/preflight only: a returned path is not permission to subsequently open it.
 * File operations below keep Linux directory descriptors open through the entire operation.
 * Other platforms retain best-effort path validation, not an OS isolation boundary.
 */
export async function resolveWorkspacePath(
  workspace: string,
  value = '.',
  writing = false,
): Promise<string> {
  value = validateComputerPath(value);
  workspace = resolve(workspace);
  await mkdir(workspace, { recursive: true });
  if ((await lstat(workspace)).isSymbolicLink()) throw new Error('不允许通过符号链接访问文件。');
  const root = await realpath(workspace);
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径超出工作区。');
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('不允许通过符号链接访问文件。');
    } catch (error: any) {
      if (error.code !== 'ENOENT' || !writing) throw error;
    }
  }
  return target;
}

const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('文件传输已取消。');
};

const TEXT_FILE_BYTES = 200_000;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const pathParts = (value: string) => value.split('/').filter((part) => part && part !== '.');

function fileSystemError(error: any): Error {
  if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR')
    return new Error('不允许通过符号链接或非目录路径访问文件。');
  if (error?.code === 'ENOENT')
    return Object.assign(new Error('ENOENT：文件或目录不存在。'), { code: 'ENOENT' });
  if (error?.code === 'EEXIST')
    return Object.assign(new Error('EEXIST：目标位置已有同名文件。'), { code: 'EEXIST' });
  if (error?.code) return new Error('工作区文件操作未完成，请检查文件权限后重试。');
  return error instanceof Error ? error : new Error('工作区文件操作未完成。');
}

interface DirectoryScope {
  directory: string;
  createdOwner?: { uid: number; gid: number };
}

/** The configured workspace's ancestors must be trusted. In Linux each component
 * is opened relative to an already held directory FD: replacing an earlier path
 * with a symlink cannot redirect later operations. No caller can select a proc FD.
 * A GUI may rename its own entries within the workspace; a selected inode remains
 * pinned. This is not a claim of mount/network/process isolation on macOS.
 */
async function withWorkspaceDirectory<T>(
  workspace: string,
  value: string,
  create: boolean,
  signal: AbortSignal | undefined,
  use: (scope: DirectoryScope) => Promise<T>,
): Promise<T> {
  const path = validateComputerPath(value);
  const handles: FileHandle[] = [];
  try {
    checkCancelled(signal);
    if (process.platform !== 'linux') {
      const directory = await resolveWorkspacePath(workspace, path, create);
      if (create) await mkdir(directory, { recursive: true });
      await resolveWorkspacePath(workspace, path);
      if (!(await lstat(directory)).isDirectory()) throw new Error('请选择工作区内的目录。');
      return await use({ directory });
    }
    // Only this configured root may be created with a path. Its ancestors are
    // deployment-owned; the root itself is always opened with O_NOFOLLOW.
    let root: FileHandle;
    try {
      root = await open(resolve(workspace), directoryFlags);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(workspace, { recursive: true });
      root = await open(resolve(workspace), directoryFlags);
    }
    handles.push(root);
    const rootStat = await root.stat();
    if (!rootStat.isDirectory()) throw new Error('请选择工作区内的目录。');
    const createdOwner =
      process.getuid?.() === 0 && rootStat.uid === 65532 ? { uid: 65532, gid: 65532 } : undefined;
    let parent = root;
    for (const part of pathParts(path)) {
      checkCancelled(signal);
      const nextPath = `/proc/self/fd/${parent.fd}/${part}`;
      let next: FileHandle;
      let created = false;
      try {
        next = await open(nextPath, directoryFlags);
      } catch (error: any) {
        if (error?.code !== 'ENOENT' || !create) throw error;
        try {
          await mkdir(nextPath, { mode: createdOwner ? 0o700 : 0o777 });
          created = true;
        } catch (mkdirError: any) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        next = await open(nextPath, directoryFlags);
      }
      handles.push(next);
      const stat = await next.stat();
      if (!stat.isDirectory()) throw new Error('请选择工作区内的目录。');
      if (created && createdOwner) await next.chown(createdOwner.uid, createdOwner.gid);
      parent = next;
    }
    checkCancelled(signal);
    return await use({ directory: `/proc/self/fd/${parent.fd}`, createdOwner });
  } catch (error) {
    throw fileSystemError(error);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

async function withWorkspaceFile<T>(
  workspace: string,
  value: string,
  createParents: boolean,
  signal: AbortSignal | undefined,
  use: (scope: DirectoryScope & { target: string }) => Promise<T>,
): Promise<T> {
  const parts = pathParts(validateComputerPath(value));
  const name = parts.pop();
  if (!name) throw new Error('请选择工作区内的普通文件。');
  return withWorkspaceDirectory(workspace, parts.join('/') || '.', createParents, signal, (scope) =>
    use({ ...scope, target: `${scope.directory}/${name}` }),
  );
}

function assertOrdinaryFile(stat: Stats) {
  if (!stat.isFile()) throw new Error('只能传输普通文件。');
  if (stat.nlink !== 1) throw new Error('不允许通过硬链接访问文件。');
}

export async function listComputerFiles(
  workspace: string,
  value = '.',
  signal?: AbortSignal,
): Promise<ComputerFileListing> {
  const path = validateComputerPath(value);
  return withWorkspaceDirectory(workspace, path, false, signal, async ({ directory }) => {
    const entries: ComputerFileListing['entries'] = [];
    let truncated = false,
      scanned = 0;
    for await (const entry of await opendir(directory)) {
      checkCancelled(signal);
      if (++scanned > 1000) {
        truncated = true;
        break;
      }
      const stat = await lstat(`${directory}/${entry.name}`).catch((error: any) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
        continue;
      if (entries.length === 200) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        path: (path === '.' ? '' : path.replace(/\/$/, '') + '/') + entry.name,
        kind: stat.isDirectory() ? 'directory' : 'file',
        ...(stat.isFile() ? { size: stat.size } : {}),
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    checkCancelled(signal);
    return { path, entries, truncated };
  });
}

/** The agent's historical listing schema: links are named, never traversed. */
export async function listComputerEntries(
  workspace: string,
  value = '.',
  signal?: AbortSignal,
): Promise<Array<{ name: string; type: 'directory' | 'file' | 'link' }>> {
  return withWorkspaceDirectory(
    workspace,
    validateComputerPath(value),
    false,
    signal,
    async ({ directory }) => {
      const entries: Array<{ name: string; type: 'directory' | 'file' | 'link' }> = [];
      let scanned = 0;
      for await (const entry of await opendir(directory)) {
        checkCancelled(signal);
        if (++scanned > 1000 || entries.length >= 500) break;
        const stat = await lstat(`${directory}/${entry.name}`).catch((error: any) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!stat) continue;
        if (stat.isSymbolicLink()) entries.push({ name: entry.name, type: 'link' });
        else if (stat.isDirectory()) entries.push({ name: entry.name, type: 'directory' });
        else if (stat.isFile() && stat.nlink === 1)
          entries.push({ name: entry.name, type: 'file' });
      }
      checkCancelled(signal);
      return entries;
    },
  );
}

async function readWorkspaceBytes(
  workspace: string,
  value: string,
  maximum: number,
  limitMessage: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return withWorkspaceFile(workspace, value, false, signal, async ({ target }) => {
    const handle = await open(target, constants.O_RDONLY | fileFlags);
    try {
      const stat = await handle.stat();
      assertOrdinaryFile(stat);
      if (stat.size > maximum) throw new Error(limitMessage);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        checkCancelled(signal);
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maximum) throw new Error(limitMessage);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      checkCancelled(signal);
      const after = await handle.stat();
      assertOrdinaryFile(after);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        total !== stat.size
      )
        throw new Error('文件在读取期间发生变化，请重试。');
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  });
}

export async function readComputerFile(
  workspace: string,
  value: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return readWorkspaceBytes(
    workspace,
    value,
    MAX_FILE_TRANSFER_BYTES,
    '文件不能超过 10 MiB。',
    signal,
  );
}

export async function readComputerText(
  workspace: string,
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await readWorkspaceBytes(
      workspace,
      value,
      TEXT_FILE_BYTES,
      '文本文件超过 200 KB，请在资料库下载。',
      signal,
    )
  ).toString('utf8');
}

async function writeWorkspaceBytes(
  workspace: string,
  value: string,
  bytes: Buffer,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  checkCancelled(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_TRANSFER_BYTES)
    throw new Error('文件不能超过 10 MiB。');
  return withWorkspaceFile(workspace, value, true, signal, async ({ target, createdOwner }) => {
    checkCancelled(signal);
    let handle: FileHandle;
    let created = false;
    try {
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | fileFlags,
        0o600,
      );
      created = true;
    } catch (error: any) {
      if (error.code !== 'EEXIST' || !overwrite) throw error;
      // Crucially, never O_TRUNC until the opened inode is verified. Symlinks,
      // FIFOs/devices and hard links must not be modified even briefly.
      handle = await open(target, constants.O_WRONLY | fileFlags);
    }
    let opened: Stats | undefined;
    let complete = false;
    try {
      opened = await handle.stat();
      assertOrdinaryFile(opened);
      checkCancelled(signal);
      if (!created) await handle.truncate(0);
      for (let offset = 0; offset < bytes.length;) {
        checkCancelled(signal);
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
        );
        if (!bytesWritten) throw new Error('文件写入未完成。');
        offset += bytesWritten;
      }
      checkCancelled(signal);
      assertOrdinaryFile(await handle.stat());
      if (created && createdOwner) await handle.chown(createdOwner.uid, createdOwner.gid);
      await handle.sync();
      checkCancelled(signal);
      complete = true;
    } finally {
      // Keep the parent directory and file descriptors alive until cleanup ends.
      // Never remove an existing file after an interrupted explicit overwrite.
      if (!complete && created && opened) {
        const current = await lstat(target).catch(() => undefined);
        if (current?.dev === opened.dev && current.ino === opened.ino)
          await unlink(target).catch(() => {});
      }
      await handle.close();
    }
  });
}

/** Uploads remain exclusive creations, preserving the no-overwrite contract. */
export async function writeComputerFile(
  workspace: string,
  value: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  return writeWorkspaceBytes(workspace, value, bytes, false, signal);
}

/** A separately approved text action may overwrite an ordinary workspace file. */
export async function writeComputerText(
  workspace: string,
  value: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof content !== 'string') throw new Error('请输入要写入的文本。');
  return writeWorkspaceBytes(workspace, value, Buffer.from(content, 'utf8'), true, signal);
}

/** Fetch bodies are bounded incrementally; Content-Length is only an early rejection hint. */
export async function readTransferResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_FILE_TRANSFER_BYTES) {
    await response.body?.cancel();
    throw new Error('文件不能超过 10 MiB。');
  }
  if (!response.body) throw new Error('远程电脑未返回文件内容。');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      checkCancelled(signal);
      const next = await reader.read();
      checkCancelled(signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FILE_TRANSFER_BYTES) throw new Error('文件不能超过 10 MiB。');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
