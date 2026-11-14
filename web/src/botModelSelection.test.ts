import assert from 'node:assert/strict';
import test from 'node:test';
import { botProfileDraft } from './botProfiles';
import { fixture, until, writes, agent } from './testSupport/creationFlowFixture';

const model = '44444444-4444-4444-8444-444444444444';

test('Bot drafts preserve explicit model inheritance and workspace-local choices', () => {
  assert.equal(Object.hasOwn(botProfileDraft(agent), 'modelProfileId'), false);
  assert.equal(botProfileDraft({ ...agent, modelProfileId: null }).modelProfileId, null);
  assert.equal(botProfileDraft({ ...agent, modelProfileId: model }).modelProfileId, model);
});

test('ordinary creation submits the selected model in the frozen Bot profile', async () => {
  const f = await fixture();
  try {
    await f.fill();
    const fields = f.profile();
    assert.equal(fields.props.modelSelection, true);
    fields.props.onChange({ ...fields.props.draft, modelProfileId: model });
    await f.ui.flush();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    const submitted = writes(f.calls);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].body.profile.modelProfileId, model);
    assert.equal('apiKey' in submitted[0].body.profile, false);
    assert.equal('provider' in submitted[0].body.profile, false);
  } finally {
    f.ui.dispose();
  }
});
