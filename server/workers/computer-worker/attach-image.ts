import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { BrowserTabs, BrowserTabOptions } from '../computer-runtime/browser-tabs.js';
import { readComputerFile } from '../computer-runtime/computer-files.js';
import type { ComputerActionInput } from './protocol.js';

function imageType(name: string, bytes: Buffer) {
  const extension = extname(name).toLowerCase();
  if (extension === '.png' && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && bytes.subarray(0, 3).toString('hex') === 'ffd8ff')
    return 'image/jpeg';
  if (
    extension === '.webp' &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new Error('请选择扩展名与内容一致的 PNG、JPEG 或 WebP 图片。');
}

/** Attach the reviewed bytes to one input in the selected page's main document. */
export async function attachBrowserImage(
  tabs: BrowserTabs,
  workspace: string,
  action: ComputerActionInput,
  { authorize, signal }: BrowserTabOptions,
) {
  const page = tabs.activePage(action.tabId!);
  const origin = new URL(action.url!).origin;
  const check = () => {
    signal?.throwIfAborted();
    authorize?.();
    if (tabs.activePage(action.tabId!) !== page || new URL(page.url()).origin !== origin)
      throw new Error('网页来源已变化，请重新核对目标网站。');
  };
  check();
  const buffer = await readComputerFile(workspace, action.path!, signal);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== action.sha256) throw new Error('图片内容已变化，请重新选择附件。');
  const name = basename(action.path!);
  const mimeType = imageType(name, buffer);
  const target = page.locator(action.selector!);
  if ((await target.count()) !== 1) throw new Error('请选择唯一的图片上传控件。');
  const input = await target.elementHandle({ timeout: 3000 });
  try {
    if (
      (await input.ownerFrame()) !== page.mainFrame() ||
      !(await input.evaluate(
        (el, site) =>
          location.origin === site &&
          el instanceof HTMLInputElement &&
          el.type === 'file' &&
          el.isConnected &&
          !el.disabled &&
          !el.webkitdirectory &&
          !el.files?.length,
        origin,
      ))
    )
      throw new Error('请选择主页面中尚未选择文件的图片上传控件。');
    check();
    try {
      await input.setInputFiles({ name, mimeType, buffer }, { timeout: 5000 });
    } catch {
      throw Object.assign(
        new Error('附图结果未确认。请先查看当前草稿的图片预览，再决定是否重试。'),
        {
          status: 502,
          code: 'BROWSER_IMAGE_ATTACHMENT_UNKNOWN',
        },
      );
    }
    return { name, size: buffer.length, sha256, origin, attached: true };
  } finally {
    await input.dispose().catch(() => {});
  }
}
