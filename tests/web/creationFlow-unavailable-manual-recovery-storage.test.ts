import test from 'node:test';
import assert from 'node:assert/strict';
import { storage, fixture, click, component } from './fixtures/creationFlowFixture';

test('unavailable manual recovery storage blocks manual creation without disabling intelligent teaming', async () => {
  const memory = storage();
  memory.getItem = () => {
    throw new Error('Synthetic storage denied');
  };
  const f = await fixture({ memory });
  try {
    assert.equal(f.profile().props.disabled, true);
    await click(f.ui, '智能组队');
    assert.equal(component(f.ui.tree, 'SmartTeamPanel').props.disabled, false);
    component(f.ui.tree, 'SmartTeamPanel').props.onConfigureModel();
    await f.ui.flush();
    assert.ok(component(f.ui.tree, 'SettingsDialog'));
    assert.equal(f.calls.length, 0);
  } finally {
    f.ui.dispose();
  }
});
