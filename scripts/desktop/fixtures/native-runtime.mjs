import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNativeNotices, verifyNativeDistribution } from '../native-runtime-distribution.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const legal = 'legal/third-party/sharp-libvips-1.3.4';

export async function nativeNoticeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    archives = join(root, 'archives');
  await mkdir(join(source, 'upstream/nested'), { recursive: true });
  await mkdir(archives);
  await mkdir(join(root, legal), { recursive: true });
  const originals = [
    ['COPYING', Buffer.from('Synthetic upstream copyright\r\nComplete permission text\r\n')],
    ['nested/README.ijg', Buffer.from('Synthetic nonstandard filename notice\n')],
  ];
  for (const [path, bytes] of originals) await writeFile(join(source, 'upstream', path), bytes);
  const archivePath = join(archives, 'synthetic.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', source, 'upstream']);
  const archive = await readFile(archivePath);
  const input = {
    component: 'synthetic',
    filename: 'synthetic.tar.gz',
    url: 'https://example.test/synthetic-1.0.tar.gz',
    bytes: archive.length,
    sha256: digest(archive),
  };
  const inputs = { schemaVersion: 1, inputs: [input] };
  const catalog = {
    schemaVersion: 1,
    components: [
      {
        ...input,
        files: originals.map(([path, bytes]) => ({
          path,
          archivePath: `upstream/${path}`,
          bytes: bytes.length,
          sha256: digest(bytes),
        })),
      },
    ],
  };
  const save = async () => {
    await writeFile(join(root, legal, 'SOURCE-INPUTS-CANDIDATE.json'), JSON.stringify(inputs));
    await writeFile(join(root, legal, 'NATIVE-NOTICES.json'), JSON.stringify(catalog));
  };
  await save();
  const output = join(root, 'notices');
  const collect = () =>
    collectNativeNotices({ sourceRoot: root, archivesDirectory: archives, output });
  return { root, output, originals, input, inputs, catalog, archivePath, collect, save };
}

export async function nativeDistributionFixture(t) {
  const f = await nativeNoticeFixture(t);
  const files = [
    'LICENSE',
    'scripts/desktop/native-codecs/build.mjs',
    'scripts/desktop/native-codecs/run.sh',
    'scripts/desktop/native-codecs/archive.py',
    'scripts/desktop/archive-cache.mjs',
    'scripts/desktop/native-runtime-distribution.mjs',
    'scripts/dependency-notice-files.mjs',
    ...['candidate-recipe.patch', 'REBUILD.md', 'BUILD-TOOLS.txt', 'DISTRIBUTING-CUSTOM.md'].map(
      (name) => `${legal}/${name}`,
    ),
  ];
  for (const path of files) {
    await mkdir(join(f.root, path, '..'), { recursive: true });
    await writeFile(join(f.root, path), `Synthetic public support file: ${path}\n`);
  }
  f.inputs.upstreamRevision = 'f'.repeat(40);
  f.inputs.recipePatchSha256 = digest(
    await readFile(join(f.root, legal, 'candidate-recipe.patch')),
  );
  const wrapper = Buffer.from('Synthetic complete Apache wrapper license');
  f.inputs.buildInputs = [
    {
      filename: 'sharp-libvips-LICENSE',
      bytes: wrapper.length,
      sha256: digest(wrapper),
      component: 'sharp-libvips-build',
    },
  ];
  await f.save();
  await f.collect();
  const artifacts = join(f.root, 'artifacts'),
    binary = join(f.root, 'binary'),
    source = join(f.root, 'source-package');
  await mkdir(artifacts);
  await mkdir(join(binary, 'lib'), { recursive: true });
  await mkdir(source);
  await cp(f.output, join(binary, 'LICENSES'), { recursive: true });
  await writeFile(
    join(binary, 'lib/libvips-cpp.8.18.7.dylib'),
    'Synthetic library; never loaded or executed',
  );
  await writeFile(join(binary, 'versions.json'), JSON.stringify({ vips: '8.18.7' }));
  await cp(join(f.root, legal, 'DISTRIBUTING-CUSTOM.md'), join(binary, 'THIRD-PARTY-NOTICES.md'));
  const sourceCatalogSha256 = digest(
    await readFile(join(f.root, legal, 'SOURCE-INPUTS-CANDIDATE.json')),
  );
  const noticeCatalogSha256 = digest(await readFile(join(f.root, legal, 'NATIVE-NOTICES.json')));
  const buildInfo = {
    identity: 'bambooshift-native-image-codecs',
    target: { platform: 'darwin', arch: 'arm64' },
    buildRecipeSha256: 'a'.repeat(64),
    recipePatchSha256: f.inputs.recipePatchSha256,
    sourceCatalogSha256,
    originalNpmArtifact: false,
    svgLoading: false,
  };
  await writeFile(join(binary, 'BUILD-INFO.json'), JSON.stringify(buildInfo));
  for (const path of [
    ...files,
    `${legal}/SOURCE-INPUTS-CANDIDATE.json`,
    `${legal}/NATIVE-NOTICES.json`,
  ]) {
    await mkdir(join(source, path, '..'), { recursive: true });
    await cp(join(f.root, path), join(source, path));
  }
  await mkdir(join(source, 'source-cache'));
  await cp(f.archivePath, join(source, 'source-cache', f.input.filename));
  await writeFile(join(source, 'source-cache/sharp-libvips-LICENSE'), wrapper);
  await cp(f.output, join(source, 'LICENSES'), { recursive: true });
  const manifestPath = join(artifacts, 'distribution.json');
  let pin;
  const seal = async () => {
    const inventory = [];
    async function walk(path = '') {
      for (const name of (await readdir(join(source, path))).sort()) {
        const member = path ? `${path}/${name}` : name;
        if (member === 'SOURCE-MANIFEST.json') continue;
        const stat = await lstat(join(source, member));
        if (stat.isDirectory()) await walk(member);
        else if (stat.isFile()) {
          const bytes = await readFile(join(source, member));
          inventory.push({ path: member, bytes: bytes.length, sha256: digest(bytes) });
        }
      }
    }
    await walk();
    const inventoryBytes = Buffer.from(JSON.stringify({ version: 1, files: inventory }));
    await writeFile(join(source, 'SOURCE-MANIFEST.json'), inventoryBytes);
    async function archive(directory, filename) {
      execFileSync('tar', [
        '-czf',
        join(artifacts, filename),
        '-C',
        directory,
        ...(await readdir(directory)).sort(),
      ]);
      const bytes = await readFile(join(artifacts, filename));
      return { filename, bytes: bytes.length, sha256: digest(bytes) };
    }
    const manifest = {
      schemaVersion: 1,
      identity: buildInfo.identity,
      target: buildInfo.target,
      upstreamRevision: f.inputs.upstreamRevision,
      buildRecipeSha256: buildInfo.buildRecipeSha256,
      recipePatchSha256: f.inputs.recipePatchSha256,
      binary: {
        ...(await archive(binary, 'binary.tar.gz')),
        library: {
          path: 'lib/libvips-cpp.8.18.7.dylib',
          sha256: digest(await readFile(join(binary, 'lib/libvips-cpp.8.18.7.dylib'))),
        },
        versions: {
          path: 'versions.json',
          sha256: digest(await readFile(join(binary, 'versions.json'))),
        },
      },
      source: {
        ...(await archive(source, 'source.tar.gz')),
        inventorySha256: digest(inventoryBytes),
      },
      notices: {
        path: 'LICENSES/index.json',
        sha256: digest(await readFile(join(binary, 'LICENSES/index.json'))),
        sourceCatalogSha256,
        noticeCatalogSha256,
      },
      releaseApproval: false,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, bytes);
    pin = digest(bytes);
  };
  await seal();
  return {
    ...f,
    binary,
    source,
    artifacts,
    seal,
    pin: () => pin,
    verify: (expectedManifestSha256 = pin) =>
      verifyNativeDistribution({
        manifestPath,
        artifactsDirectory: artifacts,
        expectedManifestSha256,
        sourceRoot: f.root,
      }),
  };
}
