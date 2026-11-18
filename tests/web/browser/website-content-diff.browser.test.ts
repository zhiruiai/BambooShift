import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const root = `/api/workspaces/${workspaceId}/website-projects/`;
const beforeId = 'a'.repeat(64),
  afterId = 'b'.repeat(64);
const source: Record<string, Record<string, string>> = {
  [beforeId]: {
    'index.html': 'one\nold heading\nfooter',
    'removed.txt': 'old only',
    'logo.png': 'old image',
    'big.js': 'x'.repeat(131073),
    'unchanged.css': 'body{}',
  },
  [afterId]: {
    'index.html': 'one\n<script>window.diffExecuted=true</script>\nfooter',
    'added.txt': 'new only',
    'logo.png': 'new image',
    'big.js': 'y'.repeat(131073),
    'unchanged.css': 'body{}',
  },
};
const manifest = (id: string) => {
  const files = Object.entries(source[id]).map(([path, content]) => ({
    path,
    mime: path.endsWith('.png')
      ? 'image/png'
      : path.endsWith('.js')
        ? 'text/javascript'
        : path.endsWith('.html')
          ? 'text/html'
          : 'text/plain',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  }));
  return {
    id,
    projectKey: 'c'.repeat(64),
    title: 'Comparison site',
    entry: 'index.html',
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
};

test(
  'website changes load only the expanded file, verify bytes, retry and safely render diffs',
  { timeout: 45000 },
  async (t) => {
    const built = await build({
      entryPoints: ['tests/web/fixtures/browser/websiteContentDiffFixture.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      write: false,
      outdir: 'fixture',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const script = built.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const style = built.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const { files: beforeFiles, ...before } = manifest(beforeId),
      { files: afterFiles, ...after } = manifest(afterId);
    const fixture = {
      workspaceId,
      after,
      before: {
        number: 1,
        project: before,
        message: {
          id: 'previous',
          conversationId: 'chat',
          role: 'assistant',
          kind: 'website_project',
          createdAt: '2026-11-16T10:00:00Z',
          content: '',
        },
      },
    };
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    page.setDefaultTimeout(8000);
    const reads: string[] = [],
      errors: string[] = [];
    let corrupt = true;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/w/' + workspaceId)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><style>${style}</style><div id="fixture"></div><script>globalThis.fixture=${JSON.stringify(fixture)};</script><script src="/fixture.js"></script>`,
        });
      if (path === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.startsWith(root)) {
        assert.equal(route.request().headers()['x-openbot-expected-user'], 'diff-owner');
        const relative = path.slice(root.length),
          [id, , ...parts] = relative.split('/');
        const file = parts.join('/');
        if (!file)
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(manifest(id)),
          });
        reads.push(id + '/' + file);
        let body = source[id][file];
        if (corrupt && id === afterId && file === 'index.html') {
          corrupt = false;
          body = body.replace('one', 'BAD');
        }
        return route.fulfill({
          contentType: 'application/octet-stream',
          headers: { 'Content-Disposition': 'attachment' },
          body,
        });
      }
      return route.abort();
    });
    await page.goto('https://content-diff.example.test/w/' + workspaceId);
    const open = (name: string) => page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name: 'Modified (3)' }).waitFor();
    assert.equal(reads.length, 0, 'manifest comparison must not fetch source files');
    await page.getByText('Version 1 → Version 2', { exact: true }).waitFor();
    await open('index.html');
    await page
      .getByRole('alert')
      .getByText('Could not load or verify this file. Try again.')
      .waitFor();
    await open('Reload');
    const table = page.getByRole('table', { name: 'File content changes' });
    await table.getByText('old heading', { exact: true }).waitFor();
    await table.getByText('<script>window.diffExecuted=true</script>', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => (window as unknown as { diffExecuted?: boolean }).diffExecuted),
      undefined,
    );
    assert.equal(
      await table.locator('.website-diff-removed .website-diff-number').first().innerText(),
      '2',
    );
    assert.ok(reads.every((path) => path.endsWith('/index.html')));
    await open('added.txt');
    await table.getByText('new only', { exact: true }).waitFor();
    assert.equal(reads.filter((path) => path.endsWith('/added.txt')).length, 1);
    assert.equal(reads.at(-1), afterId + '/added.txt');
    await open('removed.txt');
    await table.getByText('old only', { exact: true }).waitFor();
    assert.equal(reads.at(-1), beforeId + '/removed.txt');
    const count = reads.length;
    await open('logo.png');
    await page.getByText(/This file changed. Download each version/).waitFor();
    await open('big.js');
    await page.getByText(/This file is too large or complex/).waitFor();
    assert.equal(reads.length, count, 'binary and oversized metadata must avoid downloads');
    await open('index.html');
    await table.waitFor();
    await page.setViewportSize({ width: 320, height: 760 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await open('Toggle comparison');
    assert.equal(await table.count(), 0);
    assert.deepEqual(errors, []);
  },
);
