import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicationIntent, parsePublicationTeams } from './privateSkillPublications';
import { harness, json } from './testSupport/appsFixture';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';
const publicationId = '33333333-3333-4333-8333-333333333333';
const linkId = '44444444-4444-4444-8444-444444444444';
const userId = 'owner';

test('team policy needs an explicit save, refuses stale versions and reloads before another write', async () => {
  const requests: unknown[] = [];
  let remote = { memberPublishing: false, revision: 'unset' };
  let stale = true;
  const ui = await harness(
    'web/src/platform/team/TeamSkillPublishingPolicy.tsx',
    'PolicyHarness',
    { workspaceId, userId },
    async (path, init) => {
      assert.equal(path, `/api/workspaces/${workspaceId}/team-skills/publishing-policy`);
      assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), userId);
      if (init?.method === 'GET') return json(remote);
      assert.equal(init?.method, 'PUT');
      const data = JSON.parse(String(init.body));
      requests.push(data);
      if (stale) return json({ code: 'TEAM_SKILL_POLICY_CHANGED' }, 409);
      remote = { memberPublishing: data.memberPublishing, revision };
      return json(remote);
    },
    {},
    'const PolicyHarness = TeamSkillPublishingPolicy;',
  );
  const select = async (value: string) => {
    ui.field('允许发布').props.onChange({ currentTarget: { value } });
    await ui.flush();
  };
  const submit = async () => {
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
  };
  try {
    await ui.flush();
    assert.equal(ui.field('允许发布').props.value, 'owner');
    await select('members');
    assert.deepEqual(requests, []);
    await submit();
    assert.deepEqual(requests, [{ memberPublishing: true, expectedRevision: 'unset' }]);
    assert.match(ui.copy, /发布权限已变化/);
    assert.equal(ui.button('保存').props.disabled, true);
    await submit();
    assert.equal(requests.length, 1);
    stale = false;
    remote = { memberPublishing: false, revision };
    ui.button('刷新').props.onClick();
    await ui.flush();
    await select('members');
    await submit();
    assert.deepEqual(requests[1], { memberPublishing: true, expectedRevision: revision });
    assert.match(ui.copy, /已保存团队技能发布权限/);
    assert.equal(ui.button('保存').props.disabled, true);
  } finally {
    ui.dispose();
  }
});

test('member confirmation persists exact policy revision without invalidating legacy owner recovery records', () => {
  const sourceRevision = 'a'.repeat(64);
  const intent = {
    version: 1,
    skillId: 'reviewed-source',
    teamId: workspaceId,
    requestId: publicationId,
    expectedSourceRevision: sourceRevision,
    expectedPublicationRevision: null,
  };
  assert.deepEqual(parsePublicationIntent(intent), intent);
  const member = { ...intent, expectedTeamPolicyRevision: revision };
  assert.deepEqual(parsePublicationIntent(member), member);
  assert.equal(
    parsePublicationIntent({ ...member, expectedTeamPolicyRevision: 'unset' }),
    undefined,
  );
  const row = {
    workspaceId,
    workspaceName: 'Authorized team',
    policyRevision: revision,
    publication: { id: publicationId, revision, sourceRevision, version: 1, linkId },
  };
  assert.deepEqual(parsePublicationTeams({ teams: [row] }), [row]);
  assert.equal(parsePublicationTeams({ teams: [{ ...row, policyRevision: 'unset' }] }), undefined);
  assert.equal(
    parsePublicationTeams({
      teams: [{ ...row, publication: { ...row.publication, linkId: 'bad' } }],
    }),
    undefined,
  );
});
