import { ATTACHMENT_LIMITS } from './contract.ts';
import { parseAuthorizedBytes } from './parse.ts';

// This disposable codec has no business store, credentials, or caller-controlled file path.
const inputLimit = Math.ceil(ATTACHMENT_LIMITS.inputBytes / 3) * 4 + 32768;
const chunks: Buffer[] = [];
let received = 0;
try {
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > inputLimit) throw new Error('附件请求超过限制。');
    chunks.push(chunk);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('附件请求无效。');
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['version', 'name', 'data'].includes(key)) ||
    value.version !== 1 ||
    typeof value.name !== 'string' ||
    typeof value.data !== 'string' ||
    value.data.length % 4 !== 0
  )
    throw new Error('附件请求无效。');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data) throw new Error('附件请求无效。');
  const result = await parseAuthorizedBytes(value.name, bytes);
  const output = JSON.stringify({ version: 1, ok: true, result });
  if (Buffer.byteLength(output) > 12 * 1024 * 1024) throw new Error('附件结果超过限制。');
  process.stdout.write(output + '\n');
} catch {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      ok: false,
      code: 'DOCUMENT_INVALID',
      error: '附件解析失败，文件可能损坏、不受支持或超过限制。',
    }) + '\n',
  );
  process.exitCode = 1;
}
