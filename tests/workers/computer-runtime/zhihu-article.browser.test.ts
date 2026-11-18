import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { executeBrowserPage } from '../../../server/workers/computer-runtime/browser-page.js';

const run = promisify(execFile);
const site = 'https://zhuanlan.zhihu.com';
const articleTitle = 'Measuring CSV validation';
const articleBody = 'A reproducible check\n\nThree rows were read.';

test('the packaged Zhihu link checker accepts only observed article routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bamboo-article-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = JSON.parse(
    await readFile(
      new URL('../../../shared/skill-workflow-resources.json', import.meta.url),
      'utf8',
    ),
  );
  const script = join(directory, 'article_link.mjs');
  await writeFile(script, assets['zhihu-article-publishing'].files['scripts/article_link.mjs']);
  const valid = await run(process.execPath, [script, site + '/p/427?utm_source=fixture']);
  assert.equal(valid.stdout.trim(), site + '/p/427');
  for (const url of [
    site + '/write',
    site + '/p/427/edit',
    site + '/p/0',
    site + '/p/4abc',
    'https://sample.invalid/p/427',
    'https://fake@zhuanlan.zhihu.com/p/427',
  ]) {
    await assert.rejects(run(process.execPath, [script, url]), { code: 1 });
  }
});

test(
  'the browser fills a technical article draft and distinguishes published, pending and failed submissions',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 120_000,
  },
  async (t) => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE,
    });
    t.after(() => browser.close());
    for (const outcome of ['published', 'pending', 'failed']) {
      const context = await browser.newContext({
        serviceWorkers: 'block',
        proxy: { server: 'http://127.0.0.1:9' },
      });
      try {
        let submissions = 0;
        await context.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          assert.equal(url.origin, site);
          const html = (body: string) =>
            route.fulfill({ contentType: 'text/html; charset=utf-8', body });
          if (url.pathname === '/write') {
            return html(`<form method="post" action="/fixture-submit">
            <input aria-label="文章标题" name="title" oninput="this.value=this.value.trimStart()">
            <div contenteditable="true" role="textbox" aria-label="文章正文"></div>
            <input type="password" id="test-password" value="never-render-this-value">
            <textarea hidden>never-render-private-draft</textarea>
            <aside contenteditable="true">never-render-rich-draft<a href="/private-editor-destination">editor-only</a></aside>
            <aside hidden>never-render-hidden-node</aside>
            <input type="hidden" name="raw"><button type="button" id="draft">保存草稿</button>
            <button type="submit">发布文章</button><output></output>
            </form><script>
              const body = document.querySelector('[contenteditable]');
              document.querySelector('form').onsubmit = () => {
                const lines = Array.from(body.childNodes, row => row.textContent);
                document.querySelector('[name=raw]').value = lines.join('\\n');
              };
              document.querySelector('#draft').onclick = () => document.querySelector('output').textContent = '草稿已保存';
            </script>`);
          }
          if (url.pathname === '/fixture-submit') {
            submissions++;
            const posted = new URLSearchParams(request.postData() || '');
            assert.equal(posted.get('title'), articleTitle);
            assert.equal(posted.get('raw')?.replace(/\r\n/g, '\n'), articleBody);
            if (outcome === 'published') return html('<p>已发布</p><a href="/p/427">查看文章</a>');
            return html(outcome === 'pending' ? '审核中' : '提交失败，请检查表单');
          }
          assert.equal(url.pathname, '/p/427');
          return html(
            '<title>Measuring CSV validation</title><h1>Measuring CSV validation</h1><p>发布者：示例作者</p>',
          );
        });
        const page = await context.newPage();
        // Every request is fulfilled locally, including the official-looking URLs used to exercise the receipt check.
        await page.goto(site + '/write');
        const draft = await executeBrowserPage(page, {
          type: 'browser_click',
          selector: '[aria-label="文章标题"]',
        });
        assert.equal(draft.controls.find((c) => c.ariaLabel === '文章正文')?.contentEditable, true);
        for (const secret of [
          'never-render-this-value',
          'never-render-private-draft',
          'never-render-rich-draft',
          'private-editor-destination',
          'never-render-hidden-node',
        ])
          assert.ok(!JSON.stringify(draft).includes(secret), secret);
        if (outcome === 'published') {
          const changed = await executeBrowserPage(page, {
            type: 'browser_type',
            selector: '[name=title]',
            text: '  changed by the editor',
          });
          assert.equal(changed.inputMatched, false);
          const privateField = await executeBrowserPage(page, {
            type: 'browser_type',
            selector: '#test-password',
            text: 'synthetic-private-input',
          });
          assert.equal(privateField.inputMatched, undefined);
          assert.ok(!JSON.stringify(privateField).includes('synthetic-private-input'));
        }
        const title = await executeBrowserPage(page, {
          type: 'browser_type',
          selector: '[aria-label="文章标题"]',
          text: articleTitle,
        });
        assert.equal(title.inputMatched, true);
        const body = await executeBrowserPage(page, {
          type: 'browser_type',
          selector: '[contenteditable][aria-label="文章正文"]',
          text: articleBody,
        });
        assert.equal(body.inputMatched, true);
        const saved = await executeBrowserPage(page, { type: 'browser_click', selector: '#draft' });
        assert.match(saved.text, /草稿已保存/);
        assert.equal(saved.url, site + '/write');
        assert.equal(submissions, 0);
        const submitted = await executeBrowserPage(page, {
          type: 'browser_click',
          selector: 'button[type=submit]',
        });
        assert.equal(submissions, 1);
        if (outcome === 'published') {
          assert.match(submitted.text, /已发布/);
          const link = submitted.controls.find((control) => control.text === '查看文章');
          assert.equal(link?.href, '/p/427');
          const published = await executeBrowserPage(page, {
            type: 'browser_click',
            selector: 'a[href="/p/427"]',
          });
          assert.equal(published.url, site + '/p/427');
          assert.equal(published.title, articleTitle);
          assert.match(published.text, /示例作者/);
        } else {
          assert.equal(submitted.url, site + '/fixture-submit');
          assert.equal(submitted.text, outcome === 'pending' ? '审核中' : '提交失败，请检查表单');
        }
      } finally {
        await context.close();
      }
    }
  },
);
