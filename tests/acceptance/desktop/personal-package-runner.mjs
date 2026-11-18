import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fixtures, startPersonalModel } from './personal-package-model.mjs';
import { digest, inspectPersonalPackage } from './personal-package-inputs.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

async function until(check, signal, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    signal.throwIfAborted();
    const result = await check();
    if (result) return result;
    await pause(50, undefined, { signal });
  }
  throw Error('Acceptance timed out.');
}

async function processTable() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 5000 });
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
      return { pid, parent, group };
    });
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** This runs packaged supervision code, not Electron UI or operating-system input. */
export async function checkPersonalProcesses(resources, temporary) {
  const input = await inspectPersonalPackage(resources);
  assert.equal(await realpath(process.execPath), await realpath(input.paths.node));
  const { createLocalRuntime, authenticateLocalSession } = require(
    join(temporary, 'local-runtime.cjs'),
  );
  const dataDir = join(temporary, 'profile');
  const controller = new AbortController();
  const signal = controller.signal;
  const interrupted = () => controller.abort(Error('Acceptance interrupted.'));
  process.on('SIGTERM', interrupted);
  process.on('SIGINT', interrupted);
  const deadline = setTimeout(interrupted, 150_000);
  const runtime = createLocalRuntime({ resourcesPath: input.resources, dataDir });
  let model,
    phase = 'package',
    launched,
    backendGroup,
    observed = [],
    cookie = '',
    user,
    workspace;
  const checks = {},
    artifacts = [];
  const fetchLocal = (path, options = {}) => {
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    return fetch(launched.origin + path, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  };
  const api = async (path, method = 'GET', body, expected = 200, extraHeaders = {}) => {
    const response = await fetchLocal(path, {
      method,
      headers: {
        Origin: launched.origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(user ? { 'X-OpenBot-Expected-User': user } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, expected, 'Unexpected synthetic API status.');
    return response.status === 204 ? null : response.json();
  };
  const path = (suffix) => `/api/workspaces/${workspace}${suffix}`;
  const snapshot = () => api(path('/bootstrap'));
  const start = async (oldToken) => {
    launched = await runtime.start({
      signal,
      hostControl: false,
      onExit: () => controller.abort(Error('Managed process exited unexpectedly.')),
    });
    const config = JSON.parse(
      await readFile(join(dataDir, 'local-workspace/service.json'), 'utf8'),
    );
    assert.equal(config.localDesktop.hostControl ?? false, false);
    assert.equal(config.localDesktop.desktopDriver, undefined);
    assert.equal(config.runtimeDir, join(input.runtime, 'runtime'));
    assert.equal(config.nodeBinary, input.paths.node);
    assert.equal(config.dataDir, join(dataDir, 'local-workspace/data'));
    const rows = await processTable();
    const children = rows.filter((item) => item.parent === process.pid && item.group === item.pid);
    assert.equal(children.length, 1, 'Exactly one managed backend must start.');
    backendGroup = children[0].pid;
    if (process.send)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          process.off('message', confirmed);
          reject(Error('Supervisor registration timed out.'));
        }, 5000);
        const confirmed = (message) => {
          if (message?.type !== 'managed-group-confirmed' || message.pid !== backendGroup) return;
          clearTimeout(timer);
          process.off('message', confirmed);
          resolve();
        };
        process.on('message', confirmed);
        process.send({ type: 'managed-group', pid: backendGroup });
      });
    if (oldToken) {
      assert.notEqual(launched.token, oldToken);
      await api('/api/account/local-session', 'POST', {}, 403, {
        'X-BambooShift-Local-Token': oldToken,
      });
    }
    await api('/api/account/local-session', 'POST', {}, 403);
    let opened;
    const session = {
      fetch: async (url, options) => {
        assert.equal(url, launched.origin + '/api/account/local-session');
        const response = await fetch(url, options);
        cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        opened = await response.clone().json();
        return response;
      },
    };
    const destination = await authenticateLocalSession(
      session,
      launched.origin,
      launched.token,
      signal,
    );
    assert.equal(opened.user.localOnly, true);
    assert.equal(opened.user.email, '');
    assert.ok(cookie);
    assert.equal(destination, '/w/' + opened.workspaceId);
    if (workspace) assert.equal(opened.workspaceId, workspace);
    if (user) assert.equal(opened.user.id, user);
    user = opened.user.id;
    workspace = opened.workspaceId;
    await api(path('/bootstrap'), 'GET', undefined, 403, {
      'X-OpenBot-Expected-User': randomUUID(),
    });
    checks.normalWorkspaceAuthorization = true;
    checks.hostControlDisabled = true;
    checks.packagedSupervisorAndNode = true;
  };
  const observeChildren = async () => {
    const rows = await processTable(),
      selected = new Set([backendGroup]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (selected.has(row.parent) && !selected.has(row.pid)) {
          selected.add(row.pid);
          changed = true;
        }
    }
    observed = [...new Set([...observed, ...selected])];
  };
  const stop = async () => {
    await observeChildren();
    await runtime.stop();
    await until(
      () => !exists(-backendGroup) && observed.every((pid) => !exists(pid)),
      signal,
      10_000,
    );
    // A closed listening socket independently verifies that the service is gone.
    await assert.rejects(
      fetch(launched.origin + '/api/health', {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      }),
    );
    backendGroup = undefined;
    observed = [];
    cookie = '';
  };
  const verifyFile = async (state, fixture) => {
    const card = state.messages.find(
      (message) => message.kind === 'file' && message.metadata?.name === fixture.path,
    );
    assert.ok(card?.metadata.fileId, 'A real delivered file card is required.');
    assert.equal(card.metadata.sha256, digest(fixture.content));
    const response = await fetchLocal(path(`/files/${card.metadata.fileId}/download`), {
      headers: { Cookie: cookie, 'X-OpenBot-Expected-User': user },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fixture.content);
    assert.equal(
      await readFile(
        join(dataDir, 'local-workspace/data/spaces', workspace, 'workspace', fixture.path),
        'utf8',
      ),
      fixture.content,
    );
    return { name: fixture.path, sha256: digest(fixture.content) };
  };
  const task = async (fixture) => {
    const initial = await snapshot();
    assert.equal(initial.settings.runtime, 'pi');
    const conversation = initial.conversations.find(
      (item) => !item.isGroup && item.agentIds?.length === 1,
    );
    assert.ok(conversation);
    await api(
      path(`/conversations/${conversation.id}/messages`),
      'POST',
      {
        content: fixture.prompt,
        agentId: conversation.agentIds[0],
        clientId: randomUUID(),
        mode: 'followUp',
      },
      202,
    );
    const final = await until(async () => {
      assert.equal(model.failures.length, 0, 'The synthetic model rejected an unexpected request.');
      await observeChildren();
      const state = await snapshot();
      const found = state.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'done' &&
          message.content === fixture.answer,
      );
      return found && state.runningRequests.length === 0 && state;
    }, signal);
    artifacts.push(await verifyFile(final, fixture));
    assert.ok(!JSON.stringify(final).includes(model.settings.apiKey));
  };
  try {
    assert.equal(runtime.available(), true);
    model = await startPersonalModel();
    phase = 'first-start';
    await start();
    checks.noSignupFirstStart = true;
    phase = 'configure-model';
    await api(path('/settings'), 'PUT', model.settings);
    phase = 'first-file';
    await task(fixtures[0]);
    checks.realPiFileDelivery = true;
    const firstToken = launched.token;
    phase = 'first-stop';
    await stop();
    checks.firstStopRemovedProcesses = true;
    phase = 'restart';
    await start(firstToken);
    checks.bootstrapProofRotated = true;
    await verifyFile(await snapshot(), fixtures[0]);
    checks.sameWorkspaceAndFileRestored = true;
    phase = 'restart-file';
    await task(fixtures[1]);
    checks.savedModelReusedAfterRestart = true;
    assert.deepEqual(
      model.events,
      fixtures.flatMap(({ stage }) =>
        ['write', 'deliver', 'done'].map((step) => ({ stage, step })),
      ),
    );
    phase = 'final-stop';
    await stop();
    checks.finalStopRemovedProcesses = true;
    return {
      schemaVersion: 1,
      passed: true,
      scope: 'Packaged supervisor and real backend/Node/Pi; no Electron UI automation.',
      platform: input.platform,
      architecture: input.architecture,
      hostControl: false,
      externalModelUsed: false,
      checks,
      files: artifacts,
      notVerified: [
        'Electron interface',
        'screen capture',
        'keyboard and mouse',
        'external model quality',
        'public release',
      ],
    };
  } catch {
    throw Error(`Personal package acceptance failed at ${phase}.`);
  } finally {
    clearTimeout(deadline);
    await runtime.stop();
    // Failures still clean up only the exact synthetic backend process group.
    if (backendGroup && exists(-backendGroup)) process.kill(-backendGroup, 'SIGKILL');
    await model?.close();
    process.off('SIGTERM', interrupted);
    process.off('SIGINT', interrupted);
  }
}

if (process.argv[1]?.endsWith('/personal-package-runner.mjs')) {
  try {
    assert.equal(process.argv.length, 4);
    const result = await checkPersonalProcesses(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(
      /^Personal package acceptance failed at [a-z-]+\.$/.test(error.message)
        ? error.message + '\n'
        : 'Personal package acceptance failed before execution.\n',
    );
    process.exitCode = 1;
  }
}
