import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { skillWorkflowTemplates } from './skillWorkflowTemplates';
import { parseSkillFile } from './skillFileImport';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('both catalogs can become valid editable skill drafts with the same stable identities', () => {
  const english = skillWorkflowTemplates.en;
  assert.deepEqual(
    skillWorkflowTemplates['zh-CN'].map(({ id }) => id),
    english.map(({ id }) => id),
  );
  assert.equal(new Set(english.map(({ id }) => id)).size, english.length);
  for (const catalog of Object.values(skillWorkflowTemplates)) {
    for (const recipe of catalog) {
      const header = `---\nname: ${JSON.stringify(recipe.name)}\ndescription: ${JSON.stringify(recipe.description)}\n---\n`;
      const draft = parseSkillFile(new TextEncoder().encode(header + recipe.content));
      assert.deepEqual(draft, {
        name: recipe.name,
        description: recipe.description,
        content: recipe.content,
      });
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
      for (const catalog of Object.values(skillWorkflowTemplates)) {
        const recipe = catalog.find((entry) => entry.id === id);
        assert.ok(recipe, `Missing translated workflow: ${id}`);
        assert.ok(recipe.content.includes(source.license));
        assert.ok(recipe.content.includes(`/${source.repository}/blob/${source.revision}/`));
      }
    }
  }
});
