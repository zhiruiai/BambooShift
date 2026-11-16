import assert from 'node:assert/strict';
import test from 'node:test';
import { readSkillPackage, skillPackageUpload, SkillPackageError } from './skillPackageImport';

function file(webkitRelativePath: string, content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    webkitRelativePath,
    size: bytes.byteLength,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

const root = 'skill-review';
const document = (header = '', body = '', name = root) =>
  `---\r\nname: ${name}\r\ndescription: " Check results. "\r\n${header}---\r\n${body}`;
const primary = (header?: string, body?: string, name?: string) =>
  file(`${root}/SKILL.md`, document(header, body, name));
const rejects = async (input: ReturnType<typeof file>[], problem: SkillPackageError['problem']) => {
  await assert.rejects(
    readSkillPackage(input),
    (cause) => cause instanceof SkillPackageError && cause.problem === problem,
  );
};

test('folder import preserves optional YAML fields, Markdown spacing and exact binary resources', async () => {
  const body = '\r\n# Check\r\n preserve spacing \r\n';
  const bytes = new Uint8Array([0, 1, 128, 255]);
  const draft = await readSkillPackage([
    primary(
      'license: Apache-2.0\r\ncompatibility: Requires Python 3\r\nmetadata: {author: "Team", version: "1.0"}\r\nallowed-tools: Read\r\n',
      body,
    ),
    file(`${root}/assets/example.bin`, bytes),
    file(`${root}/references/notes.md`, ''),
  ]);
  assert.equal(draft.content, body);
  assert.equal(draft.description, ' Check results. ');
  assert.deepEqual(skillPackageUpload(draft, draft.skillPackage), {
    root,
    frontmatter: {
      license: 'Apache-2.0',
      compatibility: 'Requires Python 3',
      metadata: { author: 'Team', version: '1.0' },
      'allowed-tools': 'Read',
    },
    files: [
      { path: 'assets/example.bin', base64: Buffer.from(bytes).toString('base64') },
      { path: 'references/notes.md', base64: '' },
    ],
  });
});

test('an empty Markdown body is valid and the folder name permits lowercase Unicode', async () => {
  const input = file('查验-步骤/SKILL.md', document('', '', '查验-步骤'));
  const draft = await readSkillPackage([input]);
  assert.equal(draft.name, '查验-步骤');
  assert.equal(draft.content, '');
  assert.deepEqual(skillPackageUpload(draft, draft.skillPackage).files, []);
});

test('folder import accepts a decomposed macOS folder name and keeps the resource paths', async () => {
  const folderName = 'résumé'.normalize('NFD');
  const draft = await readSkillPackage([
    file(`${folderName}/SKILL.md`, document('', '', 'résumé')),
    file(`${folderName}/assets/example.csv`, 'id,value\n'),
  ]);
  assert.equal(draft.name, 'résumé');
  assert.equal(draft.skillPackage.root, 'résumé');
  assert.equal(draft.skillPackage.files[0].path, 'assets/example.csv');
});

test('folder import rejects mismatched names, malformed YAML and unsafe relative paths', async () => {
  await rejects([file(`${root}/references/SKILL.md`, document())], 'folder');
  await rejects([primary('', '', 'different')], 'name');
  await rejects([primary('', '', 'skill--review')], 'name');
  await rejects([primary('metadata: {version: 7}\r\n')], 'frontmatter');
  await rejects([primary('permissions: ["all"]\r\n')], 'frontmatter');
  await rejects([primary('license: &license MIT\r\ncompatibility: *license\r\n')], 'frontmatter');
  for (const path of ['../outside', 'x//y', 'x/file.', 'x/file ', 'C:windows', 'x\\y'])
    await rejects([primary(), file(`${root}/${path}`, 'data')], 'paths');
  await rejects([primary(), file(`${root}/skill.md`, 'another entry')], 'paths');
  await rejects([primary(), file(`${root}/Assets`, ''), file(`${root}/assets/data`, '')], 'paths');
  await rejects([primary(), file('another-folder/file', '')], 'folder');
});

test('folder import and edited drafts enforce count, byte and text constraints', async () => {
  const tooMany = Array.from({ length: 64 }, (_, i) => file(`${root}/assets/${i}`, ''));
  await rejects([primary(), ...tooMany], 'size');
  await rejects([primary(), file(`${root}/file`, new Uint8Array(256 * 1024 + 1))], 'size');
  const boundary = Array.from({ length: 4 }, (_, i) =>
    file(`${root}/assets/${i}`, new Uint8Array(256 * 1024)),
  );
  await rejects([primary(), ...boundary], 'size');
  await rejects([primary('', '😊'.repeat(16385))], 'content');
  const draft = await readSkillPackage([primary()]);
  assert.throws(
    () => skillPackageUpload({ ...draft, description: '' }, draft.skillPackage),
    (cause) => cause instanceof SkillPackageError && cause.problem === 'description',
  );
});
