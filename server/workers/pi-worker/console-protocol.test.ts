import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

for (const bundled of [false, true])
  for (const cancelled of [false, true]) {
    test(`plugin diagnostics preserve real worker frames: bundled=${bundled}, cancelled=${cancelled}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bambooshift-console-'));
      const fixture = fileURLToPath(new URL('./console-protocol.fixture.ts', import.meta.url));
      try {
        if (bundled) {
          await symlink(
            fileURLToPath(new URL('../../../node_modules', import.meta.url)),
            join(directory, 'node_modules'),
            'dir',
          );
          await build({
            entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
            outdir: directory,
            entryNames: 'index',
            chunkNames: '[name]-[hash]',
            outExtension: { '.js': '.mjs' },
            splitting: true,
            bundle: true,
            packages: 'external',
            platform: 'node',
            format: 'esm',
            target: 'node22',
            logLevel: 'silent',
            plugins: [
              {
                name: 'synthetic-static-registry',
                setup(builder) {
                  builder.onLoad({ filter: /plugin-runtime[/\\]bundled\.ts$/ }, () => ({
                    contents: `export { trustedBundledPlugins } from ${JSON.stringify(fixture)};`,
                    loader: 'ts',
                  }));
                },
              },
            ],
          });
        }
        const cordis = new URL(
          '../../../node_modules/@cordisjs/core/lib/index.mjs',
          import.meta.url,
        ).href;
        const external =
          'data:text/javascript,' +
          encodeURIComponent(
            `export * from ${JSON.stringify(cordis)}; console.info('synthetic-console-external');`,
          );
        const launcher = join(directory, 'probe.mjs');
        await writeFile(
          launcher,
          `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@cordisjs/core') return { url: ${JSON.stringify(external)}, shortCircuit: true };
  const result = next(specifier, context);
  return result.url === ${JSON.stringify(new URL('../plugin-runtime/bundled.ts', import.meta.url).href)}
    ? { ...result, url: ${JSON.stringify(new URL('./console-protocol.fixture.ts', import.meta.url).href)} } : result;
}});
await import(${JSON.stringify(bundled ? './index.mjs' : new URL('./index.ts', import.meta.url).href)});
`,
        );
        const child = spawn(
          process.execPath,
          bundled ? [launcher] : ['--import', 'tsx', launcher],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        const runId = 'synthetic-console-run';
        const secret = 'SYNTHETIC_PLUGIN_SECRET_NOT_REAL';
        let stdout = '',
          stderr = '',
          pending = '';
        const frames: Record<string, unknown>[] = [];
        const invalid: string[] = [];
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          pending += chunk;
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const frame = JSON.parse(line);
              frames.push(frame);
              if (cancelled && frame.type === 'started') {
                child.stdin.write(JSON.stringify({ type: 'abort', runId }) + '\n');
              }
            } catch {
              invalid.push(line);
            }
          }
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
          const exited = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
          });
          child.stdin.write(
            JSON.stringify({
              type: 'start',
              version: 1,
              runId,
              cwd: directory,
              systemPrompt: 'Synthetic local contract check.',
              prompt: cancelled ? 'Wait for cancellation.' : 'Complete the synthetic turn.',
              engine: 'synthetic',
              profile: { provider: 'synthetic', model: 'fixture', apiKey: secret },
              tools: [],
            }) + '\n',
          );
          assert.equal(await exited, 0);
        } finally {
          clearTimeout(timer);
          child.kill();
        }
        assert.deepEqual(invalid, [], 'Every stdout line must remain a JSON frame');
        assert.equal(pending, '');
        assert.equal(
          stdout.includes(secret),
          false,
          'Raw diagnostics and unredacted secrets must not reach the protocol',
        );
        assert.equal(frames.filter((frame) => frame.type === 'started').length, 1);
        assert.deepEqual(
          frames.filter((frame) => frame.type === 'settled').map((frame) => frame.status),
          [cancelled ? 'cancelled' : 'completed'],
        );
        for (const stage of ['external', 'import', 'apply', 'cleanup']) {
          assert.equal(stdout.includes(`synthetic-console-${stage}`), false);
          assert.equal(stderr.split(`synthetic-console-${stage}`).length - 1, 1);
        }
        // Production Rust discards this stream. Capturing it here proves routing, not redaction.
        assert.ok(stderr.includes(secret));
        if (!cancelled) assert.ok(stdout.includes('[redacted]'));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
