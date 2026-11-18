import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('Flutter website preview opens multiple bundled pages in an opaque sandbox', async () => {
  const host = await readFile('mobile/assets/website_preview/renderer.html', 'utf8');
  const payload = JSON.stringify({
    entry: 'index.html',
    documentTitle: 'Website preview',
    homeLabel: 'Home page',
    scriptError: 'Script stopped',
    partial: 'Some files were unavailable',
    loadFailed: 'Preview could not load',
    files: [
      [
        'index.html',
        'text/html',
        '<link rel="stylesheet" href="site.css"><h1>First page</h1><button id="run">Run</button><p id="result">Ready</p><script src="site.js"></script><a href="notes/index.html">Next page</a><img src="https://external.example.test/collect">',
      ],
      ['notes/index.html', 'text/html', '<h1>Second page</h1>'],
      ['site.css', 'text/css', 'h1 { color: rgb(10, 20, 30) }'],
      [
        'site.js',
        'text/javascript',
        'document.querySelector("#run").addEventListener("click", () => { document.querySelector("#result").textContent = "Bundled script ran"; });',
      ],
    ].map(([path, mime, text]) => ({ path, mime, base64: Buffer.from(text).toString('base64') })),
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    const requests: string[] = [];
    await page.route('https://**/*', async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    await page.evaluate(
      ({ host, payload }) => {
        const frame = document.createElement('iframe');
        frame.title = 'Preview shell';
        frame.sandbox.add('allow-scripts', 'allow-pointer-lock');
        frame.style.cssText = 'width:100%;height:90vh;border:0';
        const commands = `openbotAppendProjectPreview(${JSON.stringify(payload).replaceAll('<', '\\u003c')});openbotRenderProjectPreview();`;
        frame.srcdoc = host.replace(
          /<\/body><\/html>\s*$/,
          `<script>${commands}</script></body></html>`,
        );
        document.body.append(frame);
      },
      { host, payload },
    );
    const shell = page.frameLocator('[title="Preview shell"]');
    const content = shell.frameLocator('#preview');
    await content.getByRole('heading', { name: 'First page' }).waitFor();
    assert.equal(
      await content.getByRole('heading').evaluate((h) => getComputedStyle(h).color),
      'rgb(10, 20, 30)',
    );
    await content.getByRole('button', { name: 'Run' }).click();
    await content.getByText('Bundled script ran').waitFor();
    await content.getByRole('link', { name: 'Next page' }).click();
    await content.getByRole('heading', { name: 'Second page' }).waitFor();
    await shell.getByRole('button', { name: 'Home page' }).click();
    await content.getByRole('heading', { name: 'First page' }).waitFor();
    assert.equal(
      await shell.locator('#preview').getAttribute('sandbox'),
      'allow-scripts allow-pointer-lock',
    );
    assert.deepEqual(requests, []);
  } finally {
    await browser.close();
  }
});
