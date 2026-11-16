import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Skill } from '../../shared/types';
import {
  acceptInstalledSkill,
  matchesSkillPackage,
  reconcileSkillReceipt,
  skillInstallBody,
} from './skillInstallation';
import { skillWorkflowPackage, skillWorkflowTemplates } from './skillWorkflowTemplates';

const { draft } = skillWorkflowPackage(
  skillWorkflowTemplates.en.find(({ id }) => id === 'data-quality-check') ||
    skillWorkflowTemplates.en[0],
  'en',
);
function installed(): Skill {
  return {
    agentId: 'bot',
    id: 'installed',
    name: draft.name,
    description: draft.description,
    content: draft.content,
    version: 1,
    status: 'active',
    createdAt: '2026-11-16T00:00:00Z',
    skillPackage: {
      format: 'agent-skills',
      root: draft.skillPackage.root,
      frontmatter: {
        ...draft.skillPackage.frontmatter,
        name: draft.name,
        description: draft.description,
      },
      files: [
        { path: 'SKILL.md', size: 100, sha256: 'a'.repeat(64) },
        ...draft.skillPackage.files.map(({ path, base64 }) => {
          const bytes = Buffer.from(base64, 'base64');
          return {
            path,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        }),
      ],
    },
  };
}
test('installed detection checks instructions, metadata and every resource byte', async () => {
  assert.equal(await matchesSkillPackage(installed(), draft), true);
  assert.equal(
    await matchesSkillPackage({ ...installed(), content: draft.content + ' ' }, draft),
    false,
  );
  const scriptChanged = installed();
  scriptChanged.skillPackage!.files[1].sha256 = '0'.repeat(64);
  assert.equal(await matchesSkillPackage(scriptChanged, draft), false);
  const missing = installed();
  missing.skillPackage!.files.pop();
  assert.equal(await matchesSkillPackage(missing, draft), false);
  const metadataChanged = installed();
  metadataChanged.skillPackage!.frontmatter.license = 'different';
  assert.equal(await matchesSkillPackage(metadataChanged, draft), false);
  assert.equal(
    await matchesSkillPackage({ ...installed(), content: 'other instructions' }, draft),
    false,
  );
  assert.equal(
    await matchesSkillPackage({ ...installed(), skillPackage: undefined }, draft),
    false,
  );
});
test('installation keeps full resource bytes and pins the active version for an update', () => {
  const body = skillInstallBody({ agentId: 'bot', skill: draft }, 'previous');
  assert.equal(body.expectedActiveId, 'previous');
  assert.deepEqual(
    body.skillPackage.files,
    draft.skillPackage.files.map(({ path, base64 }) => ({ path, base64 })),
  );
  const first = { ...installed(), id: 'previous' };
  const otherBot = { ...first, id: 'other', agentId: 'other-bot' };
  const result = acceptInstalledSkill([first, otherBot], installed());
  assert.equal(result.find(({ id }) => id === 'previous')?.status, 'archived');
  assert.equal(result.find(({ id }) => id === 'other')?.status, 'active');
  assert.deepEqual(acceptInstalledSkill(result, installed()), result);
});

test('confirmed install survives refresh latency but yields to disabled, replaced and removed versions', () => {
  const receipt = installed();
  assert.equal(reconcileSkillReceipt([], receipt, false).active, receipt);
  assert.equal(
    reconcileSkillReceipt([{ ...receipt, status: 'proposed' }], receipt, false).active,
    receipt,
  );
  const observed = reconcileSkillReceipt([receipt], receipt, false);
  assert.equal(observed.acknowledged, true);
  assert.equal(
    reconcileSkillReceipt([{ ...receipt, status: 'disabled' }], receipt, observed.acknowledged)
      .active,
    undefined,
  );
  assert.equal(reconcileSkillReceipt([], receipt, observed.acknowledged).active, undefined);
  const replacement = { ...receipt, id: 'replacement', version: 2 };
  assert.equal(
    reconcileSkillReceipt(
      [{ ...receipt, status: 'archived' }, replacement],
      receipt,
      observed.acknowledged,
    ).active,
    replacement,
  );
  assert.equal(reconcileSkillReceipt([replacement], receipt, false).active, replacement);
});
