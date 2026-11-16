import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { skillWorkflowPackage, skillWorkflowTemplates } from './skillWorkflowTemplates';
import { readSkillPackage, skillPackageUpload } from './skillPackageImport';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('both catalogs package the same workflows with canonical names and their real files', async () => {
  const english = skillWorkflowTemplates.en;
  assert.deepEqual(
    skillWorkflowTemplates['zh-CN'].map(({ id }) => id),
    english.map(({ id }) => id),
  );
  assert.equal(new Set(english.map(({ id }) => id)).size, english.length);
  for (const language of ['en', 'zh-CN'] as const) {
    const catalog = skillWorkflowTemplates[language];
    for (const recipe of catalog) {
      const { draft, fileContents } = skillWorkflowPackage(recipe, language);
      const payload = skillPackageUpload(draft, draft.skillPackage);
      assert.equal(payload.root, recipe.id);
      assert.equal(draft.name, recipe.id);
      assert.equal(payload.frontmatter.metadata?.title, recipe.name);
      assert.equal(draft.description, recipe.description);
      assert.ok(draft.content.startsWith(recipe.content.trimEnd()));
      assert.ok(Object.keys(fileContents).length >= 2);
      for (const { path, base64 } of payload.files) {
        assert.equal(Buffer.from(base64, 'base64').toString('utf8'), fileContents[path]);
        if (path !== 'LICENSE.txt') assert.ok(draft.content.includes(path));
      }
      const header = [
        `name: ${JSON.stringify(draft.name)}`,
        `description: ${JSON.stringify(draft.description)}`,
        ...Object.entries(payload.frontmatter).map(
          ([key, value]) => `${key}: ${JSON.stringify(value)}`,
        ),
      ];
      const primary = new TextEncoder().encode(`---\n${header.join('\n')}\n---\n${draft.content}`);
      const imported = await readSkillPackage([
        {
          webkitRelativePath: `${recipe.id}/SKILL.md`,
          size: primary.length,
          arrayBuffer: async () => primary.buffer,
        },
        ...payload.files.map(({ path, base64 }) => {
          const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
          return {
            webkitRelativePath: `${recipe.id}/${path}`,
            size: bytes.length,
            arrayBuffer: async () => bytes.buffer,
          };
        }),
      ]);
      assert.deepEqual(imported, draft);
    }
  }
});

test('adapted workflows retain pinned provenance and complete notices in both client bundles', () => {
  const base = 'legal/third-party/community-skills/';
  const sources = JSON.parse(read(`${base}SOURCES.json`));
  const notice = read(`${base}NOTICE.txt`);
  assert.equal(read('web/public/licenses/community-skills.txt'), notice);
  assert.equal(read('mobile/assets/licenses/community-skills.txt'), notice);
  for (const source of sources.adaptations) {
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.ok(notice.includes(read(base + source.licenseFile)));
    for (const id of source.recipeIds) {
      for (const language of ['en', 'zh-CN'] as const) {
        const recipe = skillWorkflowTemplates[language].find((entry) => entry.id === id);
        assert.ok(recipe, `Missing translated workflow: ${id}`);
        assert.ok(recipe.content.includes(source.license));
        assert.ok(recipe.content.includes(`/${source.repository}/blob/${source.revision}/`));
        const { draft, fileContents } = skillWorkflowPackage(recipe, language);
        assert.equal(draft.skillPackage.frontmatter.license, source.license);
        assert.ok(
          draft.skillPackage.frontmatter.metadata?.source.includes(
            `/${source.repository}/blob/${source.revision}/`,
          ),
        );
        assert.equal(fileContents['LICENSE.txt'], read(base + source.licenseFile));
      }
    }
  }
});
