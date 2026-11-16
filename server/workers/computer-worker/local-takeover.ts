import { appendFile, mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { resolveBrowserTarget } from './network.js';
import type { TakeoverInput } from './protocol.js';

export async function appendTakeoverAudit(
  workspace: string,
  now: () => number,
  event: string,
  detail: Record<string, unknown>,
) {
  const dir = resolve(workspace, '../computer');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(
    resolve(dir, 'takeover.jsonl'),
    JSON.stringify({ at: new Date(now()).toISOString(), actor: 'human', event, ...detail }) + '\n',
    { mode: 0o600 },
  );
}

export async function executeBrowserTakeoverInput(page: Page, input: TakeoverInput) {
  if (input.type === 'click')
    await page.mouse.click(input.x!, input.y!, {
      button: input.button,
      clickCount: input.clickCount,
    });
  if (input.type === 'type') await page.keyboard.insertText(input.text!);
  if (input.type === 'key')
    await page.keyboard.press(
      input.key === 'ControlOrMeta+A'
        ? platform() === 'darwin'
          ? 'Meta+A'
          : 'Control+A'
        : input.key!,
    );
  if (input.type === 'scroll') await page.mouse.wheel(input.deltaX ?? 0, input.deltaY!);
  if (input.type === 'navigate') {
    const url = new URL(input.url!);
    await resolveBrowserTarget(url);
    const response = await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (response && response.status() >= 400)
      throw new Error(`网页请求失败 (${response.status()})。`);
  }
}
