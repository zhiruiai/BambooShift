import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const fixture = [
  [
    'index.html',
    'text/html',
    `<!doctype html><html lang="en"><head>
    <link rel="stylesheet" href="./styles/site.css"><meta http-equiv="refresh" content="0; url=https://example.test/refresh">
    </head><body><h1>Local website</h1><p id="result">Waiting</p><img alt="Local image" src="./assets/mark.svg">
    <a href="./pages/about.html">Local details</a><a href="https://example.test/link">External</a>
    <button id="enter">Enter scene</button>
    <input type="image" src="https://example.test/input"><iframe src="https://example.test/frame"></iframe>
    <canvas id="scene" width="128" height="96"></canvas><script type="module" src="./src/scene.mjs"></script></body></html>`,
  ],
  ['pages/about.html', 'text/html', '<h1>Local details page</h1>'],
  [
    'styles/site.css',
    'text/css',
    '@import "./colors.css"; h1 { background-image: url(../assets/mark.svg); }',
  ],
  ['styles/colors.css', 'text/css', 'h1 { color: rgb(41, 81, 121); }'],
  [
    'assets/mark.svg',
    'image/svg+xml',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#239879"/></svg>',
  ],
  [
    'src/vertices.mjs',
    'text/javascript',
    'export const points = [-0.9,-0.9,0, 0.9,-0.9,0, 0,0.9,0];',
  ],
  [
    'src/scene.mjs',
    'text/javascript',
    `import { points } from './vertices.mjs';
    const text = document.getElementById('result');
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl');
    function shader(type, code) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, code); gl.compileShader(shader); return shader;
    }
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec3 point;void main(){gl_Position=vec4(point,1.0);}'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float;void main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}'));
    gl.linkProgram(program); gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
    const point = gl.getAttribLocation(program, 'point');
    gl.enableVertexAttribArray(point); gl.vertexAttribPointer(point, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = new Uint8Array(4); gl.readPixels(64, 48, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (pixel[0] !== 255 || pixel[1] !== 0) throw Error('Wrong triangle color');
    if (typeof fetch !== 'undefined' || typeof WebSocket !== 'undefined' || typeof Worker !== 'undefined') throw Error('Network API exposed');
    try { window.location.href = 'https://example.test/script-navigation'; } catch {}
    const external = 'https://example.test/blocked-module';
    try { await import(external); } catch {}
    document.body.requestPointerLock();
    document.getElementById('enter').addEventListener('click', () => canvas.requestPointerLock());
    text.textContent = 'Local 3D triangle rendered';`,
  ],
] as const;

test(
  'website preview opens a nested local module, renders WebGL and routes only a real local link',
  { timeout: 40_000 },
  async () => {
    const bundled = await build({
      stdin: {
        contents: `export {websitePreviewDocument} from './web/src/websitePreviewDocument'; export {websiteFiles} from './web/src/websitePreviewFiles';`,
        resolveDir: process.cwd(),
      },
      write: false,
      bundle: true,
      format: 'iife',
      globalName: 'fixturePreview',
      platform: 'browser',
    });
    const browser = await chromium.launch({
      headless: true,
      timeout: 10_000,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage({ serviceWorkers: 'block' });
      await page.addInitScript({
        content: `HTMLElement.prototype.requestPointerLock = function () {
        if (navigator.userActivation.isActive && this instanceof HTMLCanvasElement) {
          document.documentElement.dataset.pointerCalls = String(Number(document.documentElement.dataset.pointerCalls || '0') + 1);
        }
        return Promise.resolve();
      };`,
      });
      const requests: string[] = [];
      await page.context().route('**/*', (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      await page.setContent(
        '<iframe sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer"></iframe>',
      );
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      await page.addScriptTag({
        content: `(() => {
        const iframe = document.querySelector('iframe');
        const index = fixturePreview.websiteFiles(${JSON.stringify(fixture)}.map(([path,mime,value]) =>
          ({path,mime,bytes:new TextEncoder().encode(value)})));
        const open = entryPath => { iframe.srcdoc = fixturePreview.websitePreviewDocument(index, entryPath,
          {channel:'synthetic-channel',scriptError:'Script failed',partial:'Partial preview'}); };
        addEventListener('message', event => {
          if (event.source === iframe.contentWindow && event.origin === 'null' &&
            event.data.channel === 'synthetic-channel' && event.data.kind === 'navigate') open(event.data.value);
        });
        open('index.html');
      })()`,
      });
      const frame = page.frameLocator('iframe');
      await frame.getByText('Local 3D triangle rendered').waitFor({ timeout: 10_000 });
      assert.equal(
        await frame
          .getByRole('heading', { name: 'Local website' })
          .evaluate((node) => getComputedStyle(node).color),
        'rgb(41, 81, 121)',
      );
      assert.equal(
        await frame
          .getByAltText('Local image')
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
        24,
      );
      assert.equal(
        await page.locator('iframe').evaluate((node: HTMLIFrameElement) => node.contentDocument),
        null,
      );
      assert.equal(await frame.getByText('External', { exact: true }).getAttribute('href'), null);
      assert.equal(await frame.locator('html').getAttribute('data-pointer-calls'), null);
      await frame.getByRole('button', { name: 'Enter scene' }).click();
      await frame.locator('html[data-pointer-calls="1"]').waitFor();
      await frame.getByRole('link', { name: 'Local details' }).click();
      await frame.getByRole('heading', { name: 'Local details page' }).waitFor();
      assert.deepEqual(requests, []);
    } finally {
      await browser.close();
    }
  },
);
