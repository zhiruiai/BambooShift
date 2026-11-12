import assert from 'node:assert/strict';
import { access, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { clientEnvironment } from './run-client.mjs';
import { desktopProductName } from './publishing/package-names.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'release', 'client');

async function verifyWindowsExecutable(path) {
  const file = await open(path);
  try {
    const dos = Buffer.alloc(64);
    assert.equal((await file.read(dos, 0, dos.length, 0)).bytesRead, dos.length);
    assert.equal(dos.toString('ascii', 0, 2), 'MZ');
    const position = dos.readUInt32LE(60);
    assert.ok(position >= dos.length && position < 1024 * 1024, 'Invalid PE header offset');
    const pe = Buffer.alloc(94);
    assert.equal((await file.read(pe, 0, pe.length, position)).bytesRead, pe.length);
    assert.equal(pe.readUInt32LE(0), 0x4550, 'Missing PE signature');
    assert.equal(pe.readUInt16LE(4), 0x8664, 'Windows executable must be x64');
    assert.equal(pe.readUInt16LE(24), 0x20b, 'Windows executable must be PE32+');
    assert.equal(pe.readUInt16LE(92), 2, 'Windows executable must use the GUI subsystem');
  } finally {
    await file.close();
  }
}

export async function verifyPackagedStartup(executablePath, expectedVersion, expectedName) {
  const profile = await mkdtemp(join(tmpdir(), 'pandamate-client-smoke-'));
  let visits = 0;
  let probes = 0;
  let health = 'operations';
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/health') {
      probes++;
      if (health === 'redirect') {
        response.writeHead(302, { Location: '/unexpected' }).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          architecture: 'platform',
          backend: 'rust',
          ...(health === 'product' ? { runtime: 'pi' } : { surface: 'operations' }),
        }),
      );
    } else if (request.method === 'GET' && request.url === '/') {
      visits++;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Fixture workspace</title><h1>Fixture workspace</h1>');
    } else if (request.url === '/unexpected') {
      visits++;
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({ ok: true, runtime: 'pi', architecture: 'platform', backend: 'rust' }),
        );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  let application;
  try {
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', ready);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    application = await _electron.launch({
      executablePath,
      timeout: 30_000,
      env: {
        ...clientEnvironment(process.env),
        OPENBOT_CLIENT_DATA_DIR: profile,
        OPENBOT_CLIENT_URL: origin,
      },
    });
    const setup = await application.firstWindow({ timeout: 15_000 });
    setup.setDefaultTimeout(15_000);
    await setup.waitForURL('openbot-app://setup/');
    await setup.locator('#workspace-url:enabled').waitFor();
    assert.equal(await setup.locator('#workspace-url').inputValue(), origin);
    assert.equal(visits, 0, 'A new profile must wait for explicit connection');
    assert.equal(probes, 0, 'A new profile must wait before probing the suggested address');
    const language = setup.locator('#client-language');
    await language.selectOption('zh-CN');
    await setup.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await language.selectOption('en');
    await setup.waitForFunction(() => document.documentElement.lang === 'en');
    await setup.locator('#connect-button').click();
    await setup
      .getByText('This address did not respond as a BambooShift workspace.', { exact: false })
      .waitFor();
    assert.equal(visits, 0, 'The operations listener must not open in the product window');
    assert.equal(probes, 1);
    health = 'redirect';
    await setup.locator('#connect-button').click();
    await setup.getByText('This workspace could not be reached.', { exact: false }).waitFor();
    assert.equal(visits, 0, 'The health probe must not follow redirects');
    assert.equal(probes, 2);
    health = 'product';
    await setup.locator('#connect-button').click();
    await setup.waitForFunction(() => document.body.hidden);
    const connected = await application.evaluate(async ({ app, webContents }, origin) => {
      const view = webContents.getAllWebContents().find((item) => item.getURL() === origin + '/');
      return {
        name: app.getName(),
        packaged: app.isPackaged && app.getAppPath().endsWith('app.asar'),
        platform: process.platform,
        arch: process.arch,
        workspace: await view?.executeJavaScript('document.querySelector("h1")?.textContent'),
        version: await view?.executeJavaScript('window.openbotVersion?.getVersion()'),
      };
    }, origin);
    assert.deepEqual(connected, {
      name: expectedName,
      packaged: true,
      platform: process.platform,
      arch: process.arch,
      workspace: 'Fixture workspace',
      version: expectedVersion,
    });
    assert.equal(visits, 1, 'Only the explicitly requested workspace should be loaded');
    assert.equal(probes, 3, 'Retry must verify the service again');
  } finally {
    try {
      await application?.close();
    } finally {
      if (server.listening) {
        const closed = new Promise((done) => server.close(done));
        server.closeAllConnections();
        await closed;
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Run this smoke test on native Windows');
  assert.equal(process.arch, 'x64', 'Run this smoke test using x64 Node');
  const source = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'));
  const product = desktopProductName(source);
  const bundleName = product + '-win32-x64';
  const bundle = join(output, bundleName);
  const executable = join(bundle, product + '.exe');
  const manifest = JSON.parse(await readFile(join(output, 'manifest-win32-x64.json'), 'utf8'));
  assert.equal(manifest.name, product);
  assert.equal(manifest.bundleId, 'com.openbot.client');
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.version, process.env.RELEASE_VERSION || source.version);
  assert.equal(manifest.serviceIncluded, false);
  assert.deepEqual(manifest.bundles, [bundleName]);
  // Electron owns its native dependency layout. The startup check verifies that
  // the executable can load those dependencies and open this packaged app.
  await access(join(bundle, 'resources', 'app.asar'));
  await verifyWindowsExecutable(executable);
  await verifyPackagedStartup(executable, manifest.version, product);
  console.log(
    'Windows x64 package opened, changed language, and connected to a fixture workspace.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
