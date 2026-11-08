'use strict';
const { lstatSync, realpathSync, renameSync, linkSync, unlinkSync } = require('node:fs');
const { open } = require('node:fs/promises');
const { join, dirname, basename, isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');
const { sharedFileDownloadRequest } = require('./security.cjs');
function createSharedDownloadHandler({
  getConnection,
  getWindow,
  foregroundFrame,
  now,
  machine,
  dialog,
  t,
}) {
  async function downloadSharedFile(event, value) {
    const current = getConnection();
    const window = getWindow();
    const frame = current && foregroundFrame(event.sender, current.origin);
    const token = current?.sharedFileInput;
    if (current) current.sharedFileInput = undefined;
    const request = frame && sharedFileDownloadRequest(value, frame.url, current.origin);
    if (
      !request ||
      !token ||
      token.frame !== frame ||
      token.url !== frame.url ||
      now() >= token.expiresAt ||
      event.senderFrame !== frame ||
      current.sharedFileDownload
    )
      throw new Error('请在当前页面点击共享资料的下载按钮。');
    const abort = new AbortController();
    current.sharedFileDownload = abort;
    const contents = current.view.webContents;
    const ses = contents.session;
    const originalUrl = frame.url;
    const cancel = () => abort.abort();
    const changedCookie = (_event, cookie) => {
      if (cookie?.name === 'openbot_account' || cookie?.name === '__Host-openbot_account') cancel();
    };
    const invalidatingEvents = ['did-start-navigation', 'did-navigate-in-page', 'destroyed'];
    for (const name of invalidatingEvents) contents.on(name, cancel);
    ses.cookies?.on('changed', changedCookie);
    let temporary, handle, temporaryStat;
    let published = false;
    const check = (signal = abort.signal) => {
      // A native save sheet takes focus from the WebContents. It does not change
      // the captured frame/account; focus is required only for the original click.
      if (
        signal.aborted ||
        getConnection() !== current ||
        !current.attached ||
        machine.snapshot().status !== 'connected' ||
        !window ||
        window.isDestroyed() ||
        contents.isDestroyed() ||
        contents.isLoadingMainFrame() ||
        contents.mainFrame !== frame ||
        frame.isDestroyed() ||
        frame.detached ||
        frame.origin !== current.origin ||
        frame.url !== originalUrl ||
        contents.getURL() !== originalUrl
      )
        throw new Error('下载已取消，页面或账户已变化。');
    };
    const requestBytes = async (path, maximum, signal) => {
      check(signal);
      const response = await ses.fetch(current.origin + path, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'X-OpenBot-Expected-User': request.expectedUser, 'Cache-Control': 'no-store' },
        signal,
      });
      try {
        check(signal);
        if (
          !response.ok ||
          response.redirected ||
          !response.body ||
          (response.url && response.url !== current.origin + path)
        )
          throw new Error('共享资料或账户权限已变化，请刷新后重试。');
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
        await response.body.cancel().catch(() => {});
        throw new Error('下载内容超过允许大小。');
      }
      const reader = response.body.getReader(),
        chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          check(signal);
          if (done) break;
          length += chunk.byteLength;
          if (length > maximum) throw new Error('下载内容超过允许大小。');
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunks, length);
    };
    const verifyAccount = async (signal) => {
      const bytes = await requestBytes('/api/account/session', 1024 * 1024, signal);
      let state;
      try {
        state = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error('无法确认当前账户，请刷新后重试。');
      }
      if (state?.authenticated !== true || state.user?.id !== request.expectedUser)
        throw new Error('当前登录账户已变化，请刷新后重新下载。');
      check(signal);
    };
    const verifyFileVersion = async (length, signal) => {
      check(signal);
      // HEAD re-runs the exact grant/version checks without redownloading bytes.
      // A valid account alone does not prove that this file is still shared.
      const response = await ses.fetch(current.origin + request.path, {
        method: 'HEAD',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'X-OpenBot-Expected-User': request.expectedUser, 'Cache-Control': 'no-store' },
        signal,
      });
      try {
        check(signal);
        const declared = response.headers.get('content-length');
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== current.origin + request.path) ||
          declared === null ||
          !/^\d+$/.test(declared) ||
          Number(declared) !== length
        )
          throw new Error('共享资料或账户权限已变化，请刷新后重试。');
      } finally {
        await response.body?.cancel().catch(() => {});
      }
      check(signal);
    };
    try {
      await verifyAccount(AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]));
      const selected = await dialog.showSaveDialog(window, {
        title: t('saveShared'),
        defaultPath: request.name,
        buttonLabel: t('save'),
        // macOS/Windows use the native replacement confirmation; Linux requires
        // this explicit option. A cancelled confirmation cancels the save dialog.
        properties: ['createDirectory', 'dontAddToRecent', 'showOverwriteConfirmation'],
      });
      check();
      if (selected.canceled || !selected.filePath) return { status: 'cancelled' };
      const selectedPath = selected.filePath;
      if (typeof selectedPath !== 'string' || !isAbsolute(selectedPath))
        throw new Error('保存位置无效，请重新选择。');
      const directory = realpathSync(dirname(selectedPath));
      const parent = lstatSync(directory, { bigint: true });
      if (!parent.isDirectory()) throw new Error('保存位置不是文件夹。');
      const destination = join(directory, basename(selectedPath));
      const statTarget = () => {
        try {
          const stat = lstatSync(destination, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
            throw new Error('请选择普通文件作为保存位置。');
          return stat;
        } catch (error) {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      };
      const existing = statTarget();
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]);
      await verifyAccount(signal);
      const bytes = await requestBytes(request.path, 10 * 1024 * 1024, signal);
      await verifyAccount(signal);
      check(signal);
      temporary = join(directory, `.openbot-download-${randomUUID()}.tmp`);
      handle = await open(temporary, 'wx', 0o600);
      temporaryStat = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();
      // Keep the exact file open through verification/publication. Its parent can
      // be renamed while HEAD is in flight; a pathname alone cannot clean it up.
      // Recheck after local I/O too. No asynchronous work is permitted between
      // the final lifecycle/identity checks and the atomic publication below.
      await verifyAccount(signal);
      await verifyFileVersion(bytes.length, signal);
      check(signal);
      const currentParent = lstatSync(directory, { bigint: true });
      const currentTemporary = lstatSync(temporary, { bigint: true });
      if (
        realpathSync(dirname(selectedPath)) !== directory ||
        currentParent.dev !== parent.dev ||
        currentParent.ino !== parent.ino ||
        currentTemporary.dev !== temporaryStat.dev ||
        currentTemporary.ino !== temporaryStat.ino ||
        !currentTemporary.isFile() ||
        currentTemporary.nlink !== 1n
      )
        throw new Error('保存位置发生变化，请重新选择。');
      if (existing) {
        const currentTarget = statTarget();
        if (
          !currentTarget ||
          ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].some(
            (key) => currentTarget[key] !== existing[key],
          )
        )
          throw new Error('原文件已经变化，未覆盖；请重新选择保存位置。');
        // The user confirmed this exact target. The adjacent stat/rename narrows
        // races but is not a cross-platform compare-and-swap guarantee.
        renameSync(temporary, destination);
        published = true;
        temporary = undefined;
      } else {
        linkSync(temporary, destination); // Exclusive: never replace a late-created target.
        // This inode is now the user's saved file. A later unlink/close failure
        // must never send it through the unpublished-content cleanup path.
        published = true;
      }
      return { status: 'saved' };
    } catch (error) {
      if (abort.signal.aborted) return { status: 'cancelled' };
      const safe = [
        '保存位置',
        '原文件已经变化',
        '请选择普通文件',
        '当前登录账户已变化',
        '共享资料或账户权限',
        '下载内容超过',
        '无法确认当前账户',
      ];
      throw new Error(
        safe.some((prefix) => error?.message?.startsWith(prefix))
          ? error.message
          : '共享资料未保存，请检查账户、权限和保存位置后重试。',
      );
    } finally {
      let cleanupFailed = false;
      try {
        if (handle && !published) {
          try {
            // Clear the held inode even if its parent has moved or its old path
            // now names another file. Extreme renames may leave a zero-byte shell,
            // but must not leave the cancelled download's plaintext behind.
            await handle.truncate(0);
            await handle.sync();
          } catch {
            cleanupFailed = true;
          }
        }
        if (temporary && temporaryStat) {
          try {
            const candidate = lstatSync(temporary, { bigint: true });
            if (
              candidate.isFile() &&
              candidate.dev === temporaryStat.dev &&
              candidate.ino === temporaryStat.ino
            )
              unlinkSync(temporary);
          } catch {
            // Removal is best-effort after content clearing. Never unlink a
            // replacement inode or truncate a file that has already been saved.
          }
        }
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch {
            if (!published) cleanupFailed = true;
          }
        }
        for (const name of invalidatingEvents) contents.removeListener(name, cancel);
        ses.cookies?.removeListener('changed', changedCookie);
        if (current.sharedFileDownload === abort) current.sharedFileDownload = undefined;
      }
      if (cleanupFailed)
        throw new Error('下载未保存，但本机临时文件的清理未能确认，请检查保存位置后重试。');
    }
  }
  return downloadSharedFile;
}
module.exports = { createSharedDownloadHandler };
