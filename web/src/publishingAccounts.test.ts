import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerInput } from './components/computer/createComputerInput';
import type { ComputerInputContext } from './components/computer/createComputerInput.types';
import { publishingSites, validPublishingAddress } from './publishingAccounts';

test('creator addresses are public HTTPS pages and contain no login credentials', () => {
  for (const { url } of publishingSites) assert.equal(validPublishingAddress(url), true);
  for (const bad of [
    'https://127.0.0.1/editor',
    'https://2130706433/editor',
    'https://[::1]/',
    'https://printer.local./write',
    'https://container.internal/write',
    'https://user:pass@domain.com/',
    'https://domain.com/?token=value',
    'https://domain.com/#',
    'file:///tmp/editor',
    'http://domain.com/',
    'https://domain.com:444/editor',
    'https://domain.com/\neditor',
  ])
    assert.equal(validPublishingAddress(bad), false, bad);
});

test('publishing login navigation uses only the newly granted live browser lease', async () => {
  const site = publishingSites[0];
  async function run(surface: string, current = true, usable = true, blocked = false) {
    const steps: unknown[] = [];
    const lease = { leaseId: 'private-lease', surface };
    const noop = () => {};
    const action = createComputerInput(
      () =>
        ({
          screenReady: true,
          takeoverSupported: true,
          inputBusy: false,
          isDesktop: false,
          teachingBlocked: blocked,
          controlTransition: { current: false },
          statusSequence: { current: 0 },
          current: () => current,
          usableLease: () => usable,
          clearShot: noop,
          setInputBusy: noop,
          setControlError: noop,
          setTakeover: noop,
          setClock: noop,
          setAutoRefresh: noop,
          updateLease: (v: unknown) => {
            assert.equal(v, lease);
            steps.push('authorized');
          },
          screenshot: async () => {
            steps.push('screenshot');
          },
          scope: {
            ticket: () => 0,
            startLease: async () => {
              steps.push('start');
              return lease;
            },
            request: async (path: string, method: string, body: unknown) => {
              steps.push([path, method, body]);
            },
            endLease: async (id: string) => {
              assert.equal(id, lease.leaseId);
              steps.push('released');
            },
          },
        }) as unknown as ComputerInputContext,
    );
    await action.startTakeover(site);
    return steps;
  }
  assert.deepEqual(await run('browser'), [
    'start',
    'authorized',
    ['/takeover/input', 'POST', { leaseId: 'private-lease', type: 'navigate', url: site.url }],
    'screenshot',
  ]);
  assert.deepEqual(await run('desktop'), ['start', 'authorized', 'screenshot']);
  assert.deepEqual(await run('browser', false), ['start', 'released']);
  assert.deepEqual(await run('browser', true, false), ['start', 'authorized', 'screenshot']);
  assert.deepEqual(await run('browser', true, true, true), ['start', 'authorized', 'screenshot']);
});
