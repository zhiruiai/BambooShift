import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMacSigningIdentity } from '../../../scripts/desktop/create-macos-signing-identity.mjs';
import { macSigningDirectory } from '../../../scripts/desktop/macos-signing-profile.mjs';

const profile = {
  version: 1,
  kind: 'local',
  identity: 'A'.repeat(40),
  certificateSha256: 'b'.repeat(64),
  commonName: 'BambooShift Local synthetic-test',
  bundleId: 'com.openbot.client',
};
const verification = { buildsDiffer: true, requirementsMatch: true, unrelatedSignerRejected: true };
const options = { skip: process.platform !== 'darwin' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bambooshift-provision-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const sourceRoot = join(root, 'checkout');
  const directory = macSigningDirectory({ home });
  const calls = { prepare: 0, import: 0, verify: 0 };
  const dependencies = {
    home,
    sourceRoot,
    command: async () => {
      throw Error('No operating-system command is allowed in this test');
    },
    inspectExisting: async () => false,
    prepare: async (temporary) => {
      calls.prepare++;
      await writeFile(join(temporary, 'synthetic-private-key.pem'), 'synthetic fixture', {
        mode: 0o600,
      });
      return {
        profile,
        importIdentity: async () => {
          calls.import++;
        },
      };
    },
    verify: async (value) => {
      calls.verify++;
      assert.deepEqual(value, profile);
      return verification;
    },
  };
  const save = async (name, value, target = directory) => {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const path = join(target, name);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  return { home, sourceRoot, directory, calls, dependencies, save };
}

test(
  'falsy JSON profiles are corrupt state, never permission to generate another identity',
  options,
  async (t) => {
    for (const name of ['identity.json', 'pending.json']) {
      for (const value of [null, false, 0, '']) {
        await t.test(`${name}: ${JSON.stringify(value)}`, async (t) => {
          const f = await fixture(t);
          const path = await f.save(name, value);
          await assert.rejects(createMacSigningIdentity(f.dependencies), /配置无效/);
          assert.deepEqual(f.calls, { prepare: 0, import: 0, verify: 0 });
          assert.equal(await readFile(path, 'utf8'), JSON.stringify(value));
          assert.deepEqual(await readdir(f.directory), [name]);
        });
      }
    }
  },
);

test(
  'only one setup can provision a user identity, even from different checkouts',
  options,
  async (t) => {
    const f = await fixture(t);
    let signalEntered;
    const entered = new Promise((resolve) => {
      signalEntered = resolve;
    });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const prepare = f.dependencies.prepare;
    const first = createMacSigningIdentity({
      ...f.dependencies,
      prepare: async (...args) => {
        const result = await prepare(...args);
        signalEntered();
        await blocked;
        return result;
      },
    });
    try {
      await entered;
      await assert.rejects(
        createMacSigningIdentity({
          ...f.dependencies,
          sourceRoot: join(f.sourceRoot, 'another-checkout'),
        }),
        /Another signing setup/,
      );
      assert.equal(f.calls.prepare, 1);
    } finally {
      release();
    }
    const result = await first;
    assert.equal(result.identity, profile.identity);
    assert.deepEqual(f.calls, { prepare: 1, import: 1, verify: 1 });
    assert.deepEqual(await readdir(f.directory), ['identity.json']);
    const again = await createMacSigningIdentity(f.dependencies);
    assert.equal(again.created, false);
    assert.equal(f.calls.prepare, 1);
  },
);

test(
  'journal exists before import; a completed import with lost acknowledgement resumes the same identity',
  options,
  async (t) => {
    const f = await fixture(t);
    let temporary;
    await assert.rejects(
      createMacSigningIdentity({
        ...f.dependencies,
        prepare: async (path) => {
          temporary = path;
          const prepared = await f.dependencies.prepare(path);
          return {
            ...prepared,
            importIdentity: async () => {
              const journal = join(f.directory, 'pending.json');
              assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), profile);
              assert.equal((await lstat(journal)).mode & 0o777, 0o600);
              f.calls.import++;
              throw Error('import completed but caller lost its acknowledgement');
            },
          };
        },
      }),
      /lost its acknowledgement/,
    );
    await assert.rejects(lstat(temporary), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.directory), ['pending.json']);
    assert.deepEqual(f.calls, { prepare: 1, import: 1, verify: 0 });
    const recovered = await createMacSigningIdentity(f.dependencies);
    assert.equal(recovered.identity, profile.identity);
    assert.deepEqual(f.calls, { prepare: 1, import: 1, verify: 1 });
    assert.deepEqual(await readdir(f.directory), ['identity.json']);
  },
);

test(
  'partial import without a usable private key fails closed on every retry',
  options,
  async (t) => {
    const f = await fixture(t);
    await f.save('pending.json', profile);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        createMacSigningIdentity({
          ...f.dependencies,
          verify: async (saved) => {
            assert.equal(saved.identity, profile.identity);
            throw Error('saved private key unavailable');
          },
        }),
        /saved private key unavailable/,
      );
    }
    assert.deepEqual(f.calls, { prepare: 0, import: 0, verify: 0 });
    assert.deepEqual(
      JSON.parse(await readFile(join(f.directory, 'pending.json'), 'utf8')),
      profile,
    );
    assert.deepEqual(await readdir(f.directory), ['pending.json']);
  },
);

test(
  'legacy completed or pending identities migrate only after verification and remain recoverable',
  options,
  async (t) => {
    for (const name of ['identity.json', 'pending.json']) {
      await t.test(name, async (t) => {
        const f = await fixture(t);
        const legacyDirectory = join(f.sourceRoot, '.local/macos-signing');
        const legacy = await f.save(name, profile, legacyDirectory);
        await assert.rejects(
          createMacSigningIdentity({
            ...f.dependencies,
            verify: async () => {
              throw Error('keychain consent still pending');
            },
          }),
          /consent still pending/,
        );
        assert.deepEqual(await readdir(f.directory), []);
        assert.equal(await readFile(legacy, 'utf8'), JSON.stringify(profile));
        const migrated = await createMacSigningIdentity(f.dependencies);
        assert.equal(migrated.migrated, true);
        assert.equal(migrated.created, false);
        assert.deepEqual(f.calls, { prepare: 0, import: 0, verify: 1 });
        assert.equal(await readFile(legacy, 'utf8'), JSON.stringify(profile));
        assert.deepEqual(JSON.parse(await readFile(migrated.profilePath, 'utf8')), profile);
      });
    }
  },
);

test(
  'an existing keychain identity without metadata must be restored, not regenerated',
  options,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      createMacSigningIdentity({
        ...f.dependencies,
        inspectExisting: async () => true,
      }),
      /already exists in the keychain/,
    );
    assert.deepEqual(f.calls, { prepare: 0, import: 0, verify: 0 });
    assert.deepEqual(await readdir(f.directory), []);
  },
);

test(
  'conflicting ready and pending fingerprints cannot overwrite a saved identity',
  options,
  async (t) => {
    const f = await fixture(t);
    await f.save('identity.json', profile);
    await f.save('pending.json', { ...profile, identity: 'C'.repeat(40) });
    await assert.rejects(createMacSigningIdentity(f.dependencies), /Conflicting saved/);
    assert.deepEqual(f.calls, { prepare: 0, import: 0, verify: 0 });
    assert.deepEqual(
      JSON.parse(await readFile(join(f.directory, 'identity.json'), 'utf8')),
      profile,
    );
  },
);
