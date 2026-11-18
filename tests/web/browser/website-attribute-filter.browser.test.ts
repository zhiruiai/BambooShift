import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const html = `<!doctype html><html><head><style>.hidden { display: none }</style></head><body>
  <button id="all" class="filter active" data-filter="all">All routes</button>
  <button id="sunset" class="filter" data-filter="sunset" data-empty="" aria-label="Sunset routes"
    title="Evening trails" onclick="fetch('https://example.test/inline')"
    data-ob-project-private="must not cross">Sunset</button>
  <article class="route" data-tags="forest"><h2>Forest trail</h2></article>
  <article class="route" data-tags="forest sunset"><h2>Sunset meadow</h2></article>
  <p id="status">Waiting</p><script src="app.js"></script></body></html>`;
const script = `
  const status = document.getElementById('status');
  const sunset = document.getElementById('sunset');
  if (sunset.getAttribute('DATA-FILTER') !== 'sunset' || sunset.getAttribute('title') !== 'Evening trails' ||
      sunset.getAttribute('aria-label') !== 'Sunset routes' || sunset.getAttribute('id') !== 'sunset' ||
      sunset.getAttribute('data-empty') !== '' || !sunset.hasAttribute('data-empty')) throw Error('Attribute read failed');
  for (const name of ['onclick', 'src', 'missing', '__proto__', 'constructor', 'data-ob-project-node', 'data-ob-project-private']) {
    if (sunset.getAttribute(name) !== null || sunset.hasAttribute(name)) throw Error('Unexpected attribute exposed');
  }
  if (typeof sunset.setAttribute !== 'undefined' || typeof fetch !== 'undefined' || typeof parent !== 'undefined')
    throw Error('Unexpected capability exposed');
  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    const filter = button.getAttribute('data-filter');
    document.querySelectorAll('.filter').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    if (!button.getAttribute('class').includes('active')) throw Error('Class read is stale');
    document.querySelectorAll('.route').forEach(card => {
      const show = filter === 'all' || card.getAttribute('data-tags').includes(filter);
      card.classList.toggle('hidden', !show);
    });
    status.textContent = 'Selected: ' + filter;
  }));
  status.textContent = 'Ready';`;

test(
  'website preview filters real cards using read-only attributes without exposing frame or network access',
  { timeout: 30_000 },
  async () => {
    const bundled = await build({
      stdin: {
        contents: `import { createRoot } from 'react-dom/client';
        import { WebsiteProjectPreview } from './web/src/components/WebsiteProjectPreview';
        const files = ${JSON.stringify([
          ['index.html', 'text/html', html],
          ['app.js', 'text/javascript', script],
        ])}
          .map(([path, mime, content]) => ({ path, mime, bytes: new TextEncoder().encode(content) }));
        createRoot(document.getElementById('root')).render(<WebsiteProjectPreview files={files} entryPath="index.html" onNavigate={() => {}} />);`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      write: false,
      bundle: true,
      outdir: 'output',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'import.meta.hot': 'undefined', 'process.env.NODE_ENV': '"production"' },
    });
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage({ serviceWorkers: 'block' });
      const requests: string[] = [];
      await page.context().route('**/*', (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({
        content: bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
      });
      const frame = page.frameLocator('iframe');
      await frame.getByText('Ready', { exact: true }).waitFor();
      assert.equal(await frame.getByRole('heading').count(), 2);
      await frame.getByRole('button', { name: 'Sunset routes' }).click();
      await frame.getByText('Selected: sunset', { exact: true }).waitFor();
      assert.equal(
        await frame
          .getByRole('heading')
          .allTextContents()
          .then((rows) => rows.join('|')),
        'Sunset meadow',
      );
      assert.equal(await frame.getByRole('heading', { name: 'Forest trail' }).isVisible(), false);
      await frame.getByRole('button', { name: 'All routes' }).click();
      await frame.getByText('Selected: all', { exact: true }).waitFor();
      assert.equal(await frame.getByRole('heading').count(), 2);
      assert.equal(
        await page
          .locator('iframe')
          .evaluate((element: HTMLIFrameElement) => element.contentDocument),
        null,
      );
      assert.deepEqual(requests, []);
    } finally {
      await browser.close();
    }
  },
);
