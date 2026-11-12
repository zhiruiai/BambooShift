import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSkillFile,
  readSkillFile,
  SKILL_FILE_MAX_BYTES,
  SkillFileError,
  type SkillFileProblem,
} from './skillFileImport';

const encode = (text: string) => new TextEncoder().encode(text);
const source = (
  name = 'Review changes',
  description = 'Check the result',
  body = 'Read and verify.',
) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
function rejects(text: string | Uint8Array, problem: SkillFileProblem) {
  assert.throws(
    () => parseSkillFile(typeof text === 'string' ? encode(text) : text),
    (error) => error instanceof SkillFileError && error.problem === problem,
  );
}

test('standard YAML scalars, BOM and CRLF produce only an editable instruction draft', () => {
  const input =
    '\ufeff---\r\nname: "  Review: #1  "\r\ndescription: >\r\n  Read the changes\r\n  and verify them.\r\npermissions: [all]\r\ndependencies:\r\n  command: never-run-this\r\n---\r\n\r\n# Steps\r\n\r\nCheck the result.\r\n';
  assert.deepEqual(parseSkillFile(encode(input)), {
    name: 'Review: #1',
    description: 'Read the changes and verify them.',
    content: '# Steps\n\nCheck the result.',
  });
  assert.deepEqual(parseSkillFile(encode(source('Test', ' first\nsecond ', ' body '))), {
    name: 'Test',
    description: 'first\nsecond',
    content: 'body',
  });
});

test('frontmatter must be delimited on separate lines and contain string fields', () => {
  for (const text of [
    '# Skill',
    source().replace(/^---/, ' ---'),
    source().replace('\n---\n', '\n--- body\n'),
    '---\n[name, description]\n---\nbody',
    '---\nnull\n---\nbody',
  ])
    rejects(text, 'format');
  for (const value of ['null', '123', 'true', '[one]', '{key: value}']) {
    rejects(`---\nname: ${value}\ndescription: text\n---\nbody`, 'name');
    rejects(`---\nname: text\ndescription: ${value}\n---\nbody`, 'description');
  }
  rejects('---\ndescription: text\n---\nbody', 'name');
  rejects('---\nname: text\n---\nbody', 'description');
  rejects(source('  '), 'name');
  rejects(source('Name', '  '), 'description');
  rejects(source('Name', 'Description', ' \n '), 'content');
});

test('duplicate keys and aliases cannot become instructions or expand metadata', () => {
  for (const header of [
    'name: First\nname: Second\ndescription: text',
    'name: First\ndescription: text\nmetadata: {x: 1, x: 2}',
    'name: &name First\ndescription: *name',
    'name: First\ndescription: text\npermissions: &loop [*loop]',
    'name: First\ndescription: text\nmetadata: !unsupported tag',
  ])
    rejects(`---\n${header}\n---\nbody`, 'format');
});

test('UTF-8 decoding is strict and limits use bytes for the file and UTF-16 units for fields', () => {
  rejects(new Uint8Array([...encode(source()), 0xc0, 0xaf]), 'encoding');
  rejects(new Uint8Array([...encode(source()), 0xe4, 0xb8]), 'encoding');
  assert.equal(
    parseSkillFile(encode(source('😀'.repeat(50), 'd'.repeat(1000), 'b'.repeat(16000)))).name
      .length,
    100,
  );
  rejects(source('😀'.repeat(51)), 'name');
  rejects(source('a'.repeat(101)), 'name');
  rejects(source('Name', 'd'.repeat(1001)), 'description');
  rejects(source('Name', 'Description', 'b'.repeat(16001)), 'content');
  for (const control of ['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'])
    rejects(source(`a${control}b`), 'name');
  const prefix = '---\nname: Text\ndescription: Text\nunused: ';
  const suffix = '\n---\nbody';
  const boundary =
    prefix + 'x'.repeat(SKILL_FILE_MAX_BYTES - encode(prefix + suffix).byteLength) + suffix;
  assert.equal(encode(boundary).byteLength, SKILL_FILE_MAX_BYTES);
  assert.equal(parseSkillFile(encode(boundary)).content, 'body');
  rejects(encode(boundary + 'x'), 'size');
});

test('the file reader checks extension and size before reading and checks actual bytes afterward', async () => {
  let reads = 0;
  const arrayBuffer = async () => {
    reads++;
    return encode(source()).buffer;
  };
  await assert.rejects(readSkillFile({ name: 'SKILL.zip', size: 1, arrayBuffer }), {
    problem: 'file',
  });
  await assert.rejects(
    readSkillFile({ name: 'SKILL.md', size: SKILL_FILE_MAX_BYTES + 1, arrayBuffer }),
    { problem: 'size' },
  );
  assert.equal(reads, 0);
  assert.equal(
    (await readSkillFile({ name: 'SKILL.MD', size: 1, arrayBuffer })).name,
    'Review changes',
  );
  await assert.rejects(
    readSkillFile({
      name: 'SKILL.md',
      size: 1,
      arrayBuffer: async () => new ArrayBuffer(SKILL_FILE_MAX_BYTES + 1),
    }),
    { problem: 'size' },
  );
  await assert.rejects(
    readSkillFile({
      name: 'SKILL.md',
      size: 1,
      arrayBuffer: async () => {
        throw new Error('unreadable');
      },
    }),
    /unreadable/,
  );
});
