import { isMap, isScalar, parseDocument, visit } from 'yaml';

export const SKILL_FILE_MAX_BYTES = 64 * 1024;
export type ImportedSkillDraft = { name: string; description: string; content: string };
export type SkillFileProblem =
  'file' | 'size' | 'encoding' | 'format' | 'name' | 'description' | 'content';
export class SkillFileError extends Error {
  constructor(public readonly problem: SkillFileProblem) {
    super(`Invalid skill file: ${problem}`);
  }
}

export function parseSkillFile(bytes: Uint8Array): ImportedSkillDraft {
  if (bytes.byteLength > SKILL_FILE_MAX_BYTES) throw new SkillFileError('size');
  let source: string;
  try {
    // The decoder consumes an optional UTF-8 BOM and rejects malformed bytes.
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
  } catch {
    throw new SkillFileError('encoding');
  }
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (!frontmatter) throw new SkillFileError('format');
  let name: string, description: string;
  try {
    const document = parseDocument(frontmatter[1], { uniqueKeys: true, schema: 'core' });
    if (document.errors.length || document.warnings.length || !isMap(document.contents))
      throw new SkillFileError('format');
    const mapping = document.contents;
    // Inspect syntax nodes directly: never resolve aliases or convert arbitrary
    // metadata into JS objects, dependencies, permissions, or executable setup.
    visit(document, {
      Alias: () => {
        throw new SkillFileError('format');
      },
    });
    const field = (key: 'name' | 'description') => {
      const node: unknown = mapping.get(key, true);
      if (!isScalar(node) || typeof node.value !== 'string') throw new SkillFileError(key);
      return node.value.trim();
    };
    name = field('name');
    description = field('description');
  } catch (error) {
    throw error instanceof SkillFileError ? error : new SkillFileError('format');
  }
  const content = source.slice(frontmatter[0].length).trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name))
    throw new SkillFileError('name');
  if (!description || description.length > 1000) throw new SkillFileError('description');
  if (!content || content.length > 16000) throw new SkillFileError('content');
  return { name, description, content };
}

export async function readSkillFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>) {
  if (!/\.md$/i.test(file.name)) throw new SkillFileError('file');
  if (file.size > SKILL_FILE_MAX_BYTES) throw new SkillFileError('size');
  return parseSkillFile(new Uint8Array(await file.arrayBuffer()));
}
