import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTACHMENT_LIMITS } from '../contract.ts';
import { parseAuthorizedBytes } from '../parse.ts';

test('authorized byte parsing preserves text contracts and rejects all caller file paths', async () => {
  const text = Buffer.from('中文的明确授权正文');
  const result = await parseAuthorizedBytes('selected.md', text);
  assert.equal(result.name, 'selected.md');
  assert.equal(result.kind, 'text');
  if (result.kind === 'text') assert.equal(result.text, text.toString('utf8'));
  for (const name of ['main.rs', 'main.go', 'icon.svg', 'Makefile', 'Dockerfile'])
    assert.equal(
      (await parseAuthorizedBytes(name, Buffer.from('engineering fixture'))).kind,
      'text',
      name,
    );
  for (const name of ['/missing/source/selected.md', '../outside.pdf', 'linked/anything.txt'])
    await assert.rejects(parseAuthorizedBytes(name, text), /名称/);
  for (const name of ['binary.txt', 'binary-no-extension'])
    await assert.rejects(parseAuthorizedBytes(name, Buffer.from([0, 255, 1, 2])), /UTF-8|二进制/);
  await assert.rejects(parseAuthorizedBytes('false.png', text), /PNG/);
  await assert.rejects(parseAuthorizedBytes('unknown.bin', text), /不支持/);
  await assert.rejects(
    parseAuthorizedBytes('large.txt', Buffer.alloc(ATTACHMENT_LIMITS.inputBytes + 1)),
    /10 MiB/,
  );
  const long = await parseAuthorizedBytes(
    'long.txt',
    Buffer.from('a'.repeat(ATTACHMENT_LIMITS.textCharacters + 1)),
  );
  assert.equal(long.kind, 'text');
  assert.equal(long.truncated, true);
  if (long.kind === 'text') assert.equal(long.text.length, ATTACHMENT_LIMITS.textCharacters);
});
