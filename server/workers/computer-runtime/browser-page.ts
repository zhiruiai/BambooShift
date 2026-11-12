import type { Page } from 'playwright-core';
import type { ComputerActionInput } from '../computer-worker/protocol.js';
import { resolveBrowserTarget } from '../computer-worker/network.js';

/** Executes an already authorized action on the selected, owned Playwright page. */
export async function executeBrowserPage(page: Page, action: ComputerActionInput) {
  if (action.type === 'browser_navigate') {
    await resolveBrowserTarget(new URL(action.url!));
    const response = await page.goto(action.url!, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (response && response.status() >= 400)
      throw new Error(
        `网页请求失败 (${response.status()})：${(await page.locator('body').innerText()).slice(0, 300)}`,
      );
  }
  if (action.type === 'browser_click')
    await page.locator(action.selector!).first().click({ timeout: 10_000 });
  if (action.type === 'browser_type')
    await page.locator(action.selector!).first().fill(action.text!, { timeout: 10_000 });
  if (action.type === 'browser_scroll')
    await page.mouse.wheel(0, action.direction === 'up' ? -650 : 650);
  if (action.type === 'browser_back')
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  // Only a bounded, structured summary of the selected page reaches the agent.
  const text = (await page.locator('body').innerText({ timeout: 10_000 })).slice(0, 16_000);
  const controls = await page
    .locator('a,button,input,textarea,select')
    .evaluateAll((elements) =>
      elements.slice(0, 100).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 100),
        id: el.id || undefined,
        name: el.getAttribute('name') ?? undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        href: el.getAttribute('href') ?? undefined,
      })),
    );
  return { url: page.url(), title: await page.title(), text, controls };
}
