import test from 'node:test';
import assert from 'node:assert/strict';
import {
  all,
  configured,
  harness,
  json,
  profile,
  settings,
} from './testSupport/smartTeamSettingsFixture';

const changedEndpoint = 'https://replacement-model.example.test/v1';
const firstKey = 'synthetic-first-provider-key';
const replacementKey = 'synthetic-replacement-provider-key';

async function modelEditor(existing: boolean) {
  const writes: Record<string, unknown>[] = [];
  const ui = await harness(
    'web/src/components/SettingsDialog.tsx',
    'ModelSettingsDialog',
    {
      settings: existing ? configured : settings,
      workspaceId: 'space-a',
      userId: 'owner-a',
      showManagement: false,
      onClose() {},
      onSettingsChanged() {},
    },
    {
      window: { location: { pathname: '/w/space-a/' } },
      fetch: async (_url: unknown, init: RequestInit) => {
        if (init.method === 'GET')
          return json({
            activeProfileId: existing ? profile.id : '',
            profiles: existing ? [profile] : [],
          });
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return json({ profile: { ...profile, ...body }, settings: configured });
      },
    },
  );
  await ui.flush();
  return {
    ui,
    writes,
    async editInput(type: string, value: string) {
      const input = all(ui.tree, (node) => node.type === 'input' && node.props.type === type)[0];
      assert.ok(input, `Missing ${type} input`);
      input.props.onChange({ target: { value } });
      await ui.flush();
    },
    key() {
      return all(ui.tree, (node) => node.type === 'input' && node.props.type === 'password')[0]
        .props.value;
    },
    async save() {
      all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
      await ui.flush();
    },
  };
}

test('changing an existing model endpoint discards its unsaved key, including after switching back', async () => {
  const editor = await modelEditor(true);
  try {
    await editor.editInput('password', firstKey);
    await editor.editInput('url', changedEndpoint);
    assert.equal(editor.key(), '');
    await editor.editInput('url', profile.baseUrl!);
    assert.equal(
      editor.key(),
      '',
      'Returning to the old address must not restore the old draft secret',
    );
    await editor.editInput('url', changedEndpoint);
    assert.equal(editor.writes.length, 0, 'Editing an endpoint must not send model requests');
    await editor.save();
    assert.equal(editor.writes.length, 1);
    assert.equal(editor.writes[0].baseUrl, changedEndpoint);
    assert.equal(Object.hasOwn(editor.writes[0], 'apiKey'), false);
  } finally {
    editor.ui.dispose();
  }
});

test('a new model accepts a newly entered key for its changed endpoint and preserves it during name edits', async () => {
  const editor = await modelEditor(false);
  try {
    await editor.editInput('password', firstKey);
    await editor.editInput('url', changedEndpoint);
    assert.equal(editor.key(), '');
    await editor.editInput('password', replacementKey);
    editor.ui
      .field('配置名称')
      .props.onChange({ target: { value: 'Synthetic replacement model' } });
    await editor.ui.flush();
    assert.equal(editor.key(), replacementKey);
    assert.equal(editor.writes.length, 0);
    await editor.save();
    assert.equal(editor.writes.length, 1);
    assert.equal(editor.writes[0].baseUrl, changedEndpoint);
    assert.equal(editor.writes[0].apiKey, replacementKey);
    assert.equal(editor.writes[0].name, 'Synthetic replacement model');
    assert.equal(JSON.stringify(editor.writes).includes(firstKey), false);
  } finally {
    editor.ui.dispose();
  }
});
