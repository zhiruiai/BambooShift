import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LOCAL_SKILL_SCRIPT_CAPABILITY = 'local-skill-script-v1';
export const LOCAL_SKILL_SCRIPT_BODY_LIMIT = 2 * 1024 * 1024;
const inputPlaceholder = '__SKILL_INPUT__';
const maxFileBytes = 256 * 1024;
const maxPackageBytes = 1024 * 1024;
const control = /[\p{Cc}\p{Cs}]/u;
const skillName = /^[\p{Alphabetic}\p{N}]+(?:-[\p{Alphabetic}\p{N}]+)*$/u;
const digest = /^[0-9a-f]{64}$/;

function invalid(): never {
  throw new Error('技能脚本、参数或审批文件校验失败。');
}

function fields(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid();
  return record;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 320 &&
    !control.test(value) &&
    !/[:\\]/.test(value) &&
    value.split('/').every((part) => part.length > 0 && !/[. ]$/.test(part))
  );
}

function fileBytes(base64: unknown, hash: unknown): { bytes: Buffer; sha256: string } {
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil(maxFileBytes / 3) * 4 ||
    typeof hash !== 'string' ||
    !digest.test(hash)
  )
    return invalid();
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length > maxFileBytes ||
    bytes.toString('base64') !== base64 ||
    createHash('sha256').update(bytes).digest('hex') !== hash
  )
    return invalid();
  return { bytes, sha256: hash };
}

export function validateSkillScript(raw: unknown) {
  const action = fields(raw, ['type', 'path', 'args', 'package'], ['input']);
  const { path, args } = action;
  if (
    action.type !== 'local_skill_script' ||
    !validPath(path) ||
    !path.startsWith('scripts/') ||
    !/\.(py|mjs)$/.test(path) ||
    !Array.isArray(args) ||
    args.length > 16 ||
    args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 512 || control.test(arg))
  )
    return invalid();

  const { root, manifestSha256, files } = fields(action.package, [
    'root',
    'manifestSha256',
    'files',
  ]);
  if (
    typeof root !== 'string' ||
    root !== root.toLowerCase() ||
    [...root].length > 64 ||
    !skillName.test(root) ||
    typeof manifestSha256 !== 'string' ||
    !digest.test(manifestSha256) ||
    !Array.isArray(files) ||
    files.length < 2 ||
    files.length > 64
  )
    return invalid();

  const paths = new Set<string>();
  let total = 0;
  const entries = files.map((entry: unknown) => {
    const { path, base64, sha256 } = fields(entry, ['path', 'base64', 'sha256']);
    if (!validPath(path)) return invalid();
    const key = path.normalize('NFC').toLowerCase();
    if (paths.has(key)) return invalid();
    paths.add(key);
    const file = fileBytes(base64, sha256);
    total += file.bytes.length;
    if (total > maxPackageBytes) return invalid();
    return { path, ...file };
  });
  for (const path of paths) {
    for (const slash of path.matchAll(/\//g)) {
      if (paths.has(path.slice(0, slash.index))) return invalid();
    }
  }
  if (
    !entries.some((entry) => entry.path === 'SKILL.md') ||
    !entries.some((entry) => entry.path === path)
  )
    return invalid();

  const manifest = createHash('sha256').update(`bambooshift-skill-package-v1\n${root}\n`);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const file of entries) manifest.update(`${file.path}\0${file.sha256}\n`);
  if (manifest.digest('hex') !== manifestSha256) return invalid();

  const placeholders = args.filter((arg) => arg === inputPlaceholder).length;
  let input: { name: string; bytes: Buffer } | undefined;
  if (Object.hasOwn(action, 'input')) {
    const { name, base64, sha256 } = fields(action.input, ['name', 'base64', 'sha256']);
    if (
      !validPath(name) ||
      name.includes('/') ||
      !name.toLowerCase().endsWith('.csv') ||
      Buffer.byteLength(name) > 255 ||
      placeholders !== 1
    )
      return invalid();
    input = { name, bytes: fileBytes(base64, sha256).bytes };
  } else if (placeholders !== 0) {
    return invalid();
  }

  return { path, args: args as string[], root, entries, input };
}

export type ValidatedSkillScript = ReturnType<typeof validateSkillScript>;

export async function pythonForSkillScript() {
  // Avoid the macOS /usr/bin/python3 installation prompt on systems without developer tools.
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Library/Developer/CommandLineTools/usr/bin/python3',
          '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
          '/opt/homebrew/bin/python3',
          '/usr/local/bin/python3',
        ]
      : ['/usr/bin/python3', '/usr/local/bin/python3'];
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
}

export async function stageSkillScript(
  action: ValidatedSkillScript,
  stagingDirectory: string,
  signal: AbortSignal,
) {
  const cwd = join(stagingDirectory, action.root);
  for (const file of action.entries) {
    signal.throwIfAborted();
    const target = join(cwd, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  let inputPath: string | undefined;
  if (action.input) {
    signal.throwIfAborted();
    // A workspace filename cannot overwrite even a specially named package file.
    const inputDirectory = join(stagingDirectory, '.input');
    await mkdir(inputDirectory, { mode: 0o700 });
    inputPath = join(inputDirectory, action.input.name);
    await writeFile(inputPath, action.input.bytes, { flag: 'wx', mode: 0o600 });
  }
  return {
    cwd,
    script: join(cwd, action.path),
    args: action.args.map((arg) => (arg === inputPlaceholder ? inputPath! : arg)),
    env: inputPath ? { BAMBOOSHIFT_SKILL_INPUT: inputPath } : undefined,
  };
}
