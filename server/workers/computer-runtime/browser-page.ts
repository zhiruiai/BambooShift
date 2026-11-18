import type { Page } from 'playwright-core';
import type { ComputerActionInput } from '../computer-worker/protocol.js';
import { resolveBrowserTarget } from '../computer-worker/network.js';

// The rendered page summary may include status text, but editable form contents stay on the page.
const editorSelector =
  'input,textarea,[role="textbox"],[contenteditable]:not([contenteditable="false" i])';

async function visiblePageText(page: Page, limit: number) {
  return page.locator('body').evaluate(
    (body, { selector, limit }) => {
      const editors = new Set(body.querySelectorAll(selector));
      if (editors.has(body) || body.matches(selector)) return '';
      if (!editors.size) return (body as HTMLBodyElement).innerText.slice(0, limit);
      const ancestors = new Set<Element>();
      for (const editor of editors) {
        for (
          let parent = editor.parentElement;
          parent && !ancestors.has(parent);
          parent = parent.parentElement
        ) {
          ancestors.add(parent);
        }
      }
      let text = '';
      const pending: (Node | null)[] = [body];
      while (pending.length && text.length < limit) {
        const node = pending.pop();
        if (!node) {
          if (text && !text.endsWith('\n')) text += '\n';
          continue;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          text += (node.textContent || '').slice(0, limit - text.length);
          continue;
        }
        if (
          !(node instanceof HTMLElement) ||
          editors.has(node) ||
          node.matches('script,style,noscript,template')
        )
          continue;
        const style = getComputedStyle(node);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden'
        )
          continue;
        if (!style.display.startsWith('inline')) pending.push(null);
        if (!ancestors.has(node)) {
          text += node.innerText.slice(0, limit - text.length);
        } else {
          for (let child = node.lastChild; child; child = child.previousSibling)
            pending.push(child);
        }
      }
      return text.trim().slice(0, limit);
    },
    { selector: editorSelector, limit },
    { timeout: 10_000 },
  );
}

/** Executes an already authorized action on the selected, owned Playwright page. */
export async function executeBrowserPage(page: Page, action: ComputerActionInput) {
  let inputMatched: boolean | undefined;
  if (action.type === 'browser_navigate') {
    await resolveBrowserTarget(new URL(action.url!));
    const response = await page.goto(action.url!, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (response && response.status() >= 400)
      throw new Error(`网页请求失败 (${response.status()})：${await visiblePageText(page, 300)}`);
  }
  if (action.type === 'browser_click')
    await page.locator(action.selector!).first().click({ timeout: 10_000 });
  if (action.type === 'browser_type') {
    const field = page.locator(action.selector!).first();
    await field.fill(action.text!, { timeout: 10_000 });
    inputMatched = await field
      .evaluateAll(([el], expected) => {
        if (!el) return false;
        if (el instanceof HTMLInputElement && el.type === 'password') return undefined;
        const wanted = expected.replace(/\r\n?/g, '\n');
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : (el as HTMLElement).innerText;
        if (value.replace(/\r\n?/g, '\n') === wanted) return true;
        if (!(el instanceof HTMLElement && el.isContentEditable)) return false;
        // Chrome's innerText counts an empty editable paragraph twice. Its selected plain text
        // preserves the actual paragraph breaks. Restore the user's caret and selection direction.
        const selection = el.ownerDocument.getSelection();
        if (!selection) return false;
        const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
        try {
          selection.selectAllChildren(el);
          return selection.toString().replace(/\r\n?/g, '\n') === wanted;
        } finally {
          if (anchorNode && focusNode)
            selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
          else selection.removeAllRanges();
        }
      }, action.text!)
      .catch(() => undefined);
  }
  if (action.type === 'browser_scroll')
    await page.mouse.wheel(0, action.direction === 'up' ? -650 : 650);
  if (action.type === 'browser_back')
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  // Only a bounded, structured summary of the selected page reaches the agent.
  const text = await visiblePageText(page, 16_000);
  const controls = await page
    .locator(
      'a,button,input,textarea,select,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]',
    )
    .evaluateAll(
      (elements, selector) =>
        elements
          .filter((el) => !el.parentElement?.closest(selector))
          .slice(0, 100)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: el.matches(selector) ? '' : (el.textContent ?? '').trim().slice(0, 100),
            id: el.id || undefined,
            name: el.getAttribute('name') ?? undefined,
            placeholder: el.getAttribute('placeholder') ?? undefined,
            href: el.getAttribute('href') ?? undefined,
            role: el.getAttribute('role') ?? undefined,
            ariaLabel: el.getAttribute('aria-label')?.slice(0, 160) || undefined,
            contentEditable: el instanceof HTMLElement && el.isContentEditable ? true : undefined,
          })),
      editorSelector,
    );
  return {
    url: page.url(),
    title: await page.title(),
    text,
    controls,
    ...(inputMatched !== undefined && { inputMatched }),
  };
}
