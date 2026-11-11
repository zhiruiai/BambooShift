import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { interactiveHtmlFixture } from './htmlPreviewFixture';

const unsafeMarkup =
  'a[href],link,base,meta[http-equiv="refresh"],iframe,object,form,input,template,' +
  'svg a,svg use,svg image,svg foreignObject';

test(
  'real Chromium renders static reports without network or active markup; scope and mobile actions remain isolated',
  { timeout: 60000 },
  async (t) => {
    const started = Date.now();
    let phase = 'fixture';
    const stage = (next: string) => {
      phase = next;
      console.info(`[file-preview] ${next} +${Date.now() - started}ms`);
    };
    const directory = await mkdtemp(join(tmpdir(), 'openbot-file-preview-'));
    const root = process.cwd();
    const wid = '11111111-1111-4111-8111-111111111111';
    const routePath = `/w/${wid}`;
    const downloadPath = `/api/workspaces/${wid}/files/synthetic/download`;
    const external = 'https://untrusted.example.test/blocked';
    const html = `<!doctype html><html><head><title>DOCUMENT_METADATA_ONLY</title>
    <meta http-equiv="refresh" content="0;url=${external}"><base href="${external}">
    <link rel="stylesheet" href="${external}"><style>
    @import url('${external}'); @font-face{font-family:Remote;src:url('${external}')}
    body{font-family:Arial;color:#282232;font-size:9px}.report{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .metric{background:#f2edf8;padding:16px;border-radius:12px;background-image:url('${external}')}
    .tiny{font:8px Arial} @media(min-width:300px){h1{color:#76558d;font-size:24px}}
    [data-x="\\3c /style\\3e "]{font-family:"\\3c /style\\3e <a href=&#104;ttps:&#47;&#47;untrusted.example.test>Open</a><style>"}
    </style></head><body onload="window.__previewAttack=1">
    <h1>Synthetic report</h1><div class="report"><section class="metric"><strong>42</strong><p>Delivered items</p></section>
    <section class="metric"><strong>98%</strong><p>Completed</p></section></div>
    <p class="tiny">Small original text</p><p style="font-size:5px">Tiny inline text</p><small>Footnote</small>
    <a href="${external}" target="_top">External link</a><form action="${external}"><input autofocus><button>Send</button></form>
    <script>window.__previewAttack=1;fetch('${external}')</script>
    <img src="${external}" onerror="window.__previewAttack=1"><iframe src="${external}"></iframe>
    <object data="${external}"></object><svg viewBox="0 0 20 20" width="20" height="20">
      <circle cx="10" cy="10" r="8" fill="#76558d"/><a href="${external}">SVG</a>
    </svg>
    <div style='font-family:"&lt;/style&gt;&lt;a href=&#104;ttps:&#47;&#47;untrusted.example.test&gt;Escape&lt;/a&gt;&lt;style&gt;"'>Serialized CSS</div>
    </body></html>`;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let fixture: Server | undefined;
    const pageErrors: string[] = [];
    const cancelled = () => {
      void browser?.close().catch(() => {});
    };
    t.signal.addEventListener('abort', cancelled, { once: true });
    try {
      stage('bundle');
      const entry = `import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
      import{FileCard}from'./web/src/components/FileCard';import{AccountContext}from'./web/src/AccountContext';
      import{Dialog}from'./web/src/components/UI';
      import{staticHtmlPreview}from'./web/src/staticHtmlPreview';
      window.fixture={sanitize:staticHtmlPreview,ready:false};
      function App(){const[user,setUser]=useState('owner-a');const[name,setName]=useState('report.html');
        const[library,setLibrary]=useState(false);
        useEffect(()=>{window.fixture.ready=true;return()=>{window.fixture.ready=false}},[]);
        window.fixture.switchActor=()=>setUser('member-b');window.fixture.setName=setName;
        return <AccountContext.Provider value={{session:{user:{id:user}},workspace:{id:'${wid}'}}}>
        <main data-actor={user}><FileCard name={name} size={1024} href="${downloadPath}"/>
          <button onClick={()=>setLibrary(true)}>Open fixture library</button>
          {library&&<Dialog title="Fixture library" onClose={()=>setLibrary(false)}>
            <FileCard name="library.md" size={1024} href="${downloadPath}"/>
          </Dialog>}
        </main></AccountContext.Provider>}
      createRoot(document.getElementById('root')).render(<App/>);`;
      const bundle = await build({
        stdin: {
          contents: entry,
          resolveDir: root,
          sourcefile: 'preview-fixture.tsx',
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        outdir: directory,
        format: 'iife',
        platform: 'browser',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent',
      });
      t.signal.throwIfAborted();
      const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
      const style = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text || '';
      const base = (
        await Promise.all(
          [
            'web/src/styles-sections/01-base.css',
            'web/src/theme.css',
            'web/src/styles-sections/04-preview-overlay.css',
            'web/src/styles-sections/05-work-preview-rail.css',
            'web/src/styles-sections/08-media.css',
          ].map((file) => readFile(resolve(file), 'utf8')),
        )
      ).join('\n');
      const unexpected: string[] = [];
      const actors: string[] = [];
      let reply = html;
      let status = 200;
      let mime = 'text/html';
      fixture = createServer((request, response) => {
        if (request.url === routePath) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(
            `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${base}\n${style}\nbody{font-family:Arial;font-size:14px}main{padding:20px;max-width:650px}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
          );
        } else if (request.url === '/fixture.js') {
          response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
        } else if (request.url === downloadPath) {
          actors.push(String(request.headers['x-openbot-expected-user'] || ''));
          response
            .writeHead(status, {
              'Content-Type': mime,
              'Content-Disposition': 'attachment; filename="synthetic"',
            })
            .end(reply);
        } else {
          unexpected.push(request.url || '');
          response.writeHead(404).end();
        }
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const address = fixture.address();
      assert.ok(address && typeof address === 'object');
      const origin = `http://127.0.0.1:${address.port}`;
      stage('launch');
      browser = await chromium.launch({
        headless: true,
        timeout: 10000,
        executablePath:
          process.env.CHROME_EXECUTABLE ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      t.signal.throwIfAborted();
      page = await browser.newPage({
        viewport: { width: 1050, height: 850 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(10000);
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.context().route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        unexpected.push(url.origin + url.pathname);
        return route.abort();
      });
      stage('navigate');
      await page.goto(origin + routePath, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).fixture?.ready === true);
      stage('open HTML');
      await page.getByRole('button', { name: '预览 report.html' }).click();
      const iframe = page.locator('iframe');
      await iframe.waitFor();
      assert.equal(await iframe.getAttribute('sandbox'), '');
      assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
      const frame = await (await iframe.elementHandle())!.contentFrame();
      assert.ok(frame);
      await frame.getByRole('heading', { name: 'Synthetic report' }).waitFor();
      stage('inspect static document');
      const inspected = await frame.evaluate(
        (forbidden) => ({
          policy: document.head.firstElementChild?.getAttribute('content'),
          forbidden: document.querySelectorAll('script,button,' + forbidden).length,
          shapes: document.querySelectorAll('svg circle').length,
          handlers: [...document.querySelectorAll('*')]
            .flatMap((node) => [...node.attributes])
            .filter((attr) => attr.name.startsWith('on')).length,
          attack: (window as any).__previewAttack || 0,
          grid: getComputedStyle(document.querySelector('.report')!).display,
          background: getComputedStyle(document.querySelector('.metric')!).backgroundColor,
          minimum: Math.min(
            ...[...document.querySelectorAll('body *')]
              .filter((node) =>
                [...node.childNodes].some(
                  (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
                ),
              )
              .map((node) => parseFloat(getComputedStyle(node).fontSize)),
          ),
        }),
        unsafeMarkup,
      );
      assert.match(inspected.policy!, /default-src 'none'/);
      assert.match(inspected.policy!, /form-action 'none'/);
      assert.equal(inspected.forbidden, 0);
      assert.equal(inspected.shapes, 1);
      assert.equal(inspected.handlers, 0);
      assert.equal(inspected.attack, 0);
      assert.equal(
        await frame
          .locator('body')
          .textContent()
          .then((text) => text?.includes('DOCUMENT_METADATA_ONLY')),
        false,
      );
      assert.equal(inspected.grid, 'grid');
      assert.equal(inspected.background, 'rgb(242, 237, 248)');
      assert.ok(inspected.minimum >= 12, String(inspected.minimum));
      assert.deepEqual(unexpected, []);
      assert.deepEqual(actors, ['owner-a']);
      stage('source and mobile');
      await page.getByRole('tab', { name: '源码' }).click();
      await iframe.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('pre').textContent(), html);
      assert.equal(await page.locator('.file-preview-body script').count(), 0);
      await page.getByRole('tab', { name: '预览', exact: true }).click();
      await page.setViewportSize({ width: 375, height: 720 });
      const box = await page.getByRole('dialog').boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 375);
      const minimum = await page
        .getByRole('dialog')
        .evaluate((node) =>
          Math.min(
            ...[...node.querySelectorAll('*')]
              .filter(
                (element) =>
                  element.getClientRects().length &&
                  [...element.childNodes].some(
                    (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
                  ),
              )
              .map((element) => parseFloat(getComputedStyle(element).fontSize)),
          ),
        );
      assert.ok(minimum >= 12);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: '预览 report.html' })
          .evaluate((node) => document.activeElement === node),
        true,
      );

      stage('interactive plain-MIME lesson');
      await page.setViewportSize({ width: 1050, height: 850 });
      await page.evaluate(() => (window as any).fixture.setName('lesson.html'));
      mime = 'text/plain; charset=utf-8';
      reply = interactiveHtmlFixture(external);
      await page.getByRole('button', { name: '预览 lesson.html' }).click();
      await iframe.waitFor();
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
      assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
      assert.equal(await iframe.evaluate((node: HTMLIFrameElement) => node.contentDocument), null);
      const lesson = await (await iframe.elementHandle())!.contentFrame();
      assert.ok(lesson);
      await lesson.getByRole('heading', { name: 'Interactive learning fixture' }).waitFor();
      const policy = await lesson.evaluate((forbidden) => {
        const scripts = [...document.scripts];
        return {
          policy: document.head.firstElementChild?.getAttribute('content'),
          nonces: scripts.map((script) => script.nonce),
          injectedScript: scripts.some((script) => script.textContent.includes('__previewAttack')),
          scriptsWithSrc: scripts.filter((script) => script.hasAttribute('src')).length,
          forbidden: document.querySelectorAll(forbidden).length,
          handlers: [...document.querySelectorAll('*')].flatMap((node) =>
            [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)),
          ).length,
          attack: (window as any).__previewAttack || 0,
          background: getComputedStyle(document.querySelector('.synthetic-hero')!).backgroundImage,
        };
      }, unsafeMarkup);
      assert.match(policy.policy!, /default-src 'none'/);
      assert.match(policy.policy!, /connect-src 'none'/);
      assert.match(policy.policy!, /form-action 'none'/);
      assert.equal(policy.nonces.length, 1);
      assert.match(policy.nonces[0]!, /^[a-f0-9]+$/);
      assert.ok(policy.policy!.includes(`script-src 'nonce-${policy.nonces[0]}'`));
      assert.equal(policy.injectedScript, false);
      assert.equal(policy.scriptsWithSrc, 0);
      assert.equal(policy.forbidden, 0);
      assert.equal(policy.handlers, 0);
      assert.equal(policy.attack, 0);
      assert.match(policy.background, /^linear-gradient\(/);
      assert.ok(await lesson.getByRole('button', { name: 'Unsafe compound' }).isDisabled());
      const forged = lesson.getByRole('button', { name: 'Forged action' });
      assert.ok(await forged.isDisabled());
      assert.equal(await forged.getAttribute('data-ob-action'), null);

      stage('lesson cards and diagram');
      const card = lesson.locator('.synthetic-card');
      const detail = lesson.getByText('Synthetic card details');
      assert.equal(await card.getAttribute('aria-expanded'), 'false');
      await detail.waitFor({ state: 'hidden' });
      await card.press('Enter');
      await detail.waitFor();
      assert.equal(await card.getAttribute('aria-expanded'), 'true');
      await card.press('Space');
      await detail.waitFor({ state: 'hidden' });
      await lesson.getByRole('button', { name: 'Diagram', exact: true }).click();
      await lesson.locator('#lesson').waitFor({ state: 'hidden' });
      await lesson.locator('#diagram').waitFor();
      assert.equal(await lesson.locator('#diagram svg circle').count(), 1);
      await lesson.getByRole('button', { name: 'Cell diagram' }).click();
      assert.equal(await lesson.locator('#info-box p').textContent(), `<img src=${external}>`);
      assert.equal(await lesson.locator('#info-box img').count(), 0);
      await lesson.locator('#step1').waitFor();
      await lesson.getByRole('button', { name: 'Next stage' }).click();
      await lesson.locator('#step2').waitFor();
      await lesson.locator('#step1').waitFor({ state: 'hidden' });
      await lesson.getByRole('button', { name: 'Reset stages' }).click();
      await lesson.locator('#step1').waitFor();
      await lesson.locator('#step2').waitFor({ state: 'hidden' });
      assert.ok(
        (await lesson
          .locator('#step1 text')
          .evaluate((node) => parseFloat(getComputedStyle(node).fontSize))) >= 12,
      );

      stage('Unicode quiz and short viewport toolbar');
      await lesson.getByRole('button', { name: 'Practice', exact: true }).click();
      const right = lesson.getByRole('button', { name: '甲' });
      const wrong = lesson.getByRole('button', { name: '乙' });
      await wrong.click();
      assert.match((await right.getAttribute('class')) || '', /\bcorrect\b/);
      assert.match((await wrong.getAttribute('class')) || '', /\bwrong\b/);
      assert.match((await lesson.locator('#progress').textContent()) || '', /1 \/ 1/);
      await lesson.getByRole('button', { name: 'Reset quiz' }).click();
      assert.doesNotMatch((await right.getAttribute('class')) || '', /\bcorrect\b/);
      assert.equal(await wrong.getAttribute('aria-disabled'), null);
      assert.match((await lesson.locator('#progress').textContent()) || '', /0 \/ 1/);
      await right.click();
      assert.equal(await right.getAttribute('aria-pressed'), 'true');
      assert.equal(await lesson.locator('[data-ob-status]').textContent(), '回答正确');
      assert.equal(await lesson.evaluate(() => (window as any).__previewAttack), undefined);
      await page.setViewportSize({ width: 375, height: 480 });
      const dialog = page.getByRole('dialog');
      const source = dialog.getByRole('tab', { name: '源码' });
      await source.click();
      await dialog.locator('pre').waitFor();
      assert.equal(await dialog.locator('pre').textContent(), reply);
      await dialog.locator('.file-preview-body').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      assert.ok(await dialog.locator('.file-preview-body').evaluate((node) => node.scrollTop > 0));
      for (const control of [source, dialog.getByRole('link', { name: '下载' })]) {
        const bounds = await control.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 480);
      }
      await dialog.getByRole('tab', { name: '预览', exact: true }).click();
      const reopened = await (await iframe.elementHandle())?.contentFrame();
      assert.ok(
        reopened === lesson,
        'Switching to source should keep the same interactive preview',
      );
      assert.equal(await right.getAttribute('aria-pressed'), 'true');
      assert.equal(await lesson.locator('[data-ob-status]').textContent(), '回答正确');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(unexpected, []);

      stage('access failure');
      await page.setViewportSize({ width: 375, height: 720 });
      await page.evaluate(() => (window as any).fixture.setName('report.html'));
      status = 403;
      reply = '<html>PRIVATE_ACCESS_ERROR</html>';
      await page.getByRole('button', { name: '预览 report.html' }).click();
      await page.getByRole('alert').waitFor();
      assert.equal(
        await page
          .locator('body')
          .textContent()
          .then((text) => text!.includes('PRIVATE_ACCESS_ERROR')),
        false,
      );
      stage('retry and account switch');
      status = 200;
      reply = html;
      await page.getByRole('button', { name: '重新加载' }).click();
      await page.locator('iframe').waitFor();
      await page.evaluate(() => (window as any).fixture.switchActor());
      await page.locator('main[data-actor="member-b"]').waitFor();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('dialog').count(), 0);
      stage('new actor Markdown preview and source');
      await page.evaluate(() => (window as any).fixture.setName('notes.md'));
      mime = 'text/plain';
      reply = `# Synthetic notes\n\n- First item\n\n| Name | Count |\n| --- | --- |\n| Book | 2 |\n\n[Link](${external}) ![Image](${external})\n\n<script>window.__previewAttack=1</script>`;
      await page.getByRole('button', { name: '预览 notes.md' }).click();
      const notes = page.getByRole('dialog', { name: 'notes.md' });
      const previewTab = notes.getByRole('tab', { name: '预览', exact: true });
      const sourceTab = notes.getByRole('tab', { name: '源码' });
      const panel = notes.getByRole('tabpanel');
      await panel.getByRole('heading', { name: 'Synthetic notes', level: 1 }).waitFor();
      assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
      assert.equal(await panel.getByRole('listitem').textContent(), 'First item');
      assert.equal(await panel.getByRole('cell', { name: 'Book' }).count(), 1);
      assert.equal(await panel.locator('a[href],img,script').count(), 0);
      await previewTab.press('ArrowRight');
      assert.equal(await sourceTab.getAttribute('aria-selected'), 'true');
      assert.equal(await panel.locator('pre').textContent(), reply);
      assert.equal(actors.at(-1), 'member-b');
      await page.keyboard.press('Escape');
      await notes.waitFor({ state: 'detached' });

      stage('file preview stacked over library');
      await page.setViewportSize({ width: 1050, height: 850 });
      await page.getByRole('button', { name: 'Open fixture library' }).click();
      const library = page.getByRole('dialog', { name: 'Fixture library' });
      const openNested = library.getByRole('button', { name: '预览 library.md' });
      await openNested.click();
      const nested = page.getByRole('dialog', { name: 'library.md' });
      await nested.getByRole('heading', { name: 'Synthetic notes' }).waitFor();
      assert.equal(
        await nested.evaluate((node) => node.parentElement?.parentElement === document.body),
        true,
      );
      await page.keyboard.press('Escape');
      await nested.waitFor({ state: 'detached' });
      assert.ok(await library.isVisible());
      assert.equal(await openNested.evaluate((node) => document.activeElement === node), true);
      await page.keyboard.press('Escape');
      await library.waitFor({ state: 'detached' });
      assert.deepEqual(unexpected, []);
      assert.deepEqual(pageErrors, []);
      stage('complete');
    } catch (error) {
      const body = await page
        ?.locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => 'unavailable');
      console.error(
        `[file-preview] failed at ${phase}; errors=${JSON.stringify(pageErrors)}; fixture=${body?.slice(0, 800)}`,
      );
      throw error;
    } finally {
      t.signal.removeEventListener('abort', cancelled);
      await browser?.close();
      if (fixture?.listening) {
        const closed = once(fixture, 'close');
        fixture.close();
        fixture.closeAllConnections();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
