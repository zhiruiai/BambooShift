import { isMap, isScalar } from 'yaml';
import type { AgentSkillFrontmatter } from '../../shared/types';
import { parseSkillDocument, SkillFileError, type ImportedSkillDraft } from './skillFileImport';

const maximumFile = 256 * 1024;
const maximumPackage = 1024 * 1024;
const maximumBody = 64 * 1024;
const maximumFiles = 64;
const entryFile = 'SKILL.md';
const optionalStringLimits = { license: 1024, compatibility: 500, 'allowed-tools': 4096 } as const;
const permittedFields = new Set([
  'name',
  'description',
  'metadata',
  ...Object.keys(optionalStringLimits),
]);
const invalidText = /[\u0000\p{Cs}]/u;

type FolderFile = Pick<File, 'webkitRelativePath' | 'size' | 'arrayBuffer'>;
type PackageFile = { path: string; size: number; base64: string };
export type SkillPackageDraft = {
  root: string;
  frontmatter: AgentSkillFrontmatter;
  files: PackageFile[];
};
export type ImportedSkillPackage = ImportedSkillDraft & { skillPackage: SkillPackageDraft };
export type SkillPackageProblem =
  'folder' | 'name' | 'paths' | 'size' | 'frontmatter' | 'description' | 'content' | 'encoding';

export class SkillPackageError extends Error {
  constructor(readonly problem: SkillPackageProblem) {
    super(problem);
  }
}

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const yamlString = (value: string) =>
  JSON.stringify(value)
    .replaceAll('---', '\\u002d\\u002d\\u002d')
    .replace(
      /[\u0085\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );

function validName(value: string) {
  return (
    [...value].length <= 64 &&
    value === value.toLowerCase() &&
    !/\p{Uppercase}/u.test(value) &&
    value.split('-').every((part) => !!part && !/[^\p{Alphabetic}\p{N}]/u.test(part))
  );
}

function validPath(value: string) {
  return (
    byteLength(value) <= 320 &&
    !/[\\:\p{Cc}\p{Cs}]/u.test(value) &&
    value.split('/').every((part) => !!part && !part.endsWith('.') && !part.endsWith(' '))
  );
}

function readFrontmatter(frontmatter: ReturnType<typeof parseSkillDocument>['frontmatter']) {
  for (const { key } of frontmatter.items)
    if (!isScalar(key) || typeof key.value !== 'string' || !permittedFields.has(key.value))
      throw new SkillPackageError('frontmatter');
  function string(key: string, limit: number, problem: SkillPackageProblem = 'frontmatter') {
    const node: unknown = frontmatter.get(key, true);
    if (!isScalar(node) || typeof node.value !== 'string') throw new SkillPackageError(problem);
    const value = key === 'name' ? node.value.normalize('NFKC') : node.value;
    if (!value.trim() || [...value].length > limit || invalidText.test(value))
      throw new SkillPackageError(problem);
    return value;
  }
  const name = string('name', 64, 'name');
  const description = string('description', 1024, 'description');
  const extra: AgentSkillFrontmatter = {};
  for (const key of Object.keys(optionalStringLimits) as Array<keyof typeof optionalStringLimits>)
    if (frontmatter.has(key)) extra[key] = string(key, optionalStringLimits[key]);
  if (frontmatter.has('metadata')) {
    const map = frontmatter.get('metadata', true);
    if (!isMap(map) || map.items.length > 32) throw new SkillPackageError('frontmatter');
    extra.metadata = Object.fromEntries(
      map.items.map(({ key, value }) => {
        if (
          !isScalar(key) ||
          typeof key.value !== 'string' ||
          byteLength(key.value) > 128 ||
          invalidText.test(key.value) ||
          !isScalar(value) ||
          typeof value.value !== 'string' ||
          byteLength(value.value) > 1024 ||
          invalidText.test(value.value)
        )
          throw new SkillPackageError('frontmatter');
        return [key.value, value.value];
      }),
    );
  }
  return { name, description, extra };
}

function base64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(''));
}

export function skillPackageFile(path: string, bytes: Uint8Array): PackageFile {
  return { path, size: bytes.byteLength, base64: base64(bytes) };
}

export function skillPackageUpload(
  { name, description, content }: ImportedSkillDraft,
  { root, frontmatter, files }: SkillPackageDraft,
) {
  if (name !== root || !validName(name)) throw new SkillPackageError('name');
  if (!description.trim() || [...description].length > 1024 || invalidText.test(description))
    throw new SkillPackageError('description');
  if (byteLength(content) > maximumBody || invalidText.test(content))
    throw new SkillPackageError('content');
  const metadataLines = Object.entries({ name, description, ...frontmatter }).map(
    ([key, value]) => {
      if (typeof value === 'string') return `${key}: ${yamlString(value)}\n`;
      if (!value || !Object.keys(value).length) return '';
      const entries = Object.entries(value).map(
        ([name, detail]) => `  ${yamlString(name)}: ${yamlString(detail)}\n`,
      );
      return `${key}:\n${entries.join('')}`;
    },
  );
  const size = byteLength(`---\n${metadataLines.join('')}---\n${content}`);
  if (files.reduce((total, file) => total + file.size, size) > maximumPackage)
    throw new SkillPackageError('size');
  return { root, frontmatter, files: files.map(({ path, base64 }) => ({ path, base64 })) };
}

export async function readSkillPackage(
  input: readonly FolderFile[],
): Promise<ImportedSkillPackage> {
  if (input.length > maximumFiles) throw new SkillPackageError('size');
  const folderName = input[0]?.webkitRelativePath.split('/')[0];
  if (!folderName || !input[0].webkitRelativePath.includes('/'))
    throw new SkillPackageError('folder');
  const root = folderName.normalize('NFKC');
  if (!validName(root)) throw new SkillPackageError('name');
  const used = new Set<string>();
  const files = input.map((file) => {
    if (!file.webkitRelativePath.startsWith(`${folderName}/`))
      throw new SkillPackageError('folder');
    const path = file.webkitRelativePath.slice(folderName.length + 1);
    const portable = path.toLowerCase();
    if (!validPath(path) || used.has(portable)) throw new SkillPackageError('paths');
    used.add(portable);
    if (file.size > maximumFile) throw new SkillPackageError('size');
    return { path, file };
  });
  for (const path of used)
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1))
      if (used.has(path.slice(0, slash))) throw new SkillPackageError('paths');
  const primary = files.find((file) => file.path === entryFile);
  if (!primary) throw new SkillPackageError('folder');
  const supporting = files.filter((file) => file !== primary);
  if (supporting.reduce((total, { file }) => total + file.size, 0) > maximumPackage)
    throw new SkillPackageError('size');
  let document: ReturnType<typeof parseSkillDocument>;
  try {
    document = parseSkillDocument(new Uint8Array(await primary.file.arrayBuffer()), maximumFile);
  } catch (cause) {
    if (cause instanceof SkillFileError) {
      const problem =
        cause.problem === 'encoding' || cause.problem === 'size' ? cause.problem : 'frontmatter';
      throw new SkillPackageError(problem);
    }
    throw cause;
  }
  const { name, description, extra } = readFrontmatter(document.frontmatter);
  if (name !== root) throw new SkillPackageError('name');
  const resources = await Promise.all(
    supporting.map(async ({ path, file }) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size || bytes.byteLength > maximumFile)
        throw new SkillPackageError('size');
      return skillPackageFile(path, bytes);
    }),
  );
  const draft = { name, description, content: document.content };
  const skillPackage = { root, frontmatter: extra, files: resources };
  skillPackageUpload(draft, skillPackage);
  return { ...draft, skillPackage };
}
