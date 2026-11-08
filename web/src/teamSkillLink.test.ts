import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTeamSkillLinkPath, teamSkillLinkPath } from '../../shared/team-skills';
import { accountEntryPath, safeAccountNext } from './platform/platformApi';

const teamId = '11111111-1111-4111-8111-111111111111';
const publicationId = '22222222-2222-4222-8222-222222222222';
const linkId = '3a333333-3333-4333-8333-333333333333';
const path = `/team-skills/${teamId}/${publicationId}/${linkId}`;

test('team skill links round-trip exactly through the account entry allow-list', () => {
  assert.equal(teamSkillLinkPath(teamId, publicationId, linkId), path);
  assert.deepEqual(parseTeamSkillLinkPath(path), { teamId, publicationId, linkId });
  assert.equal(safeAccountNext(path), path);
  assert.equal(accountEntryPath('login', path), `/login?next=${encodeURIComponent(path)}`);
  assert.equal(teamSkillLinkPath(teamId, publicationId), undefined);
});

test('team skill links reject alternate origins, query, case and encoded paths', () => {
  for (const invalid of [
    `https://outside.example${path}`,
    `//outside.example${path}`,
    `${path}/`,
    `${path}?`,
    `${path}?next=/admin`,
    `${path}#`,
    `${path}\n`,
    `${path}/../${linkId}`,
    path.replace(linkId, linkId.toUpperCase()),
    path.replace(linkId, `%33${linkId.slice(1)}`),
    path.replace('/team-skills/', '/team-skills%2F'),
    `/team-skills/${teamId}/${publicationId}`,
    `/team-skills/${teamId}/${publicationId}/not-an-id`,
  ]) {
    assert.equal(parseTeamSkillLinkPath(invalid), undefined, invalid);
    assert.equal(safeAccountNext(invalid), '', invalid);
    assert.equal(accountEntryPath('login', invalid), '/login', invalid);
  }
});
