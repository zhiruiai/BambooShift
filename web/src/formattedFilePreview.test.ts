import assert from 'node:assert/strict';
import test from 'node:test';
import { all, harness } from './testSupport/creationFlowFixture';

const component = 'web/src/components/FormattedFilePreview.tsx';

test('tabular previews render formula and markup strings as plain cells', async () => {
  const ui = await harness(component, 'DelimitedFilePreview', {
    text: '=SUM(A1)\t<script>ignored</script>\n"two\tvalues"\t中文',
    delimiter: '\t',
  });
  await ui.flush();
  assert.deepEqual(
    all(ui.tree, (node) => node.type === 'td').map((node) => node.props.children),
    ['=SUM(A1)', '<script>ignored</script>', 'two\tvalues', '中文'],
  );
  assert.equal(all(ui.tree, (node) => node.type === 'script').length, 0);
  ui.dispose();
});

test('media has explicit playback controls and a decoder failure remains inside the dialog', async () => {
  const ui = await harness(component, 'MediaPreview', {
    kind: 'video',
    url: 'blob:synthetic-media',
  });
  await ui.flush();
  const video = all(ui.tree, (node) => node.type === 'video')[0];
  assert.equal(video.props.src, 'blob:synthetic-media');
  assert.equal(video.props.controls, true);
  assert.equal(video.props.autoPlay, undefined);
  assert.equal(video.props.disableRemotePlayback, true);
  assert.equal(video.props.preload, 'metadata');
  video.props.onError();
  await ui.flush();
  assert.equal(all(ui.tree, (node) => node.type === 'video').length, 0);
  assert.equal(all(ui.tree, (node) => node.props.role === 'alert').length, 1);
  ui.dispose();
});
