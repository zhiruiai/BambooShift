import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalComputer } from '../../computer-worker/index.js';
import { writeComputerFile } from '../computer-files.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=',
  'base64',
);

// A self-contained editor represents the observable states of a creator portal.
// It uses no platform assets, private endpoints, credentials or outgoing requests.
const editor = `<!doctype html><meta charset="utf-8"><title>测试创作空间</title>
<style>#body,#state { white-space: pre-wrap; }</style>
<main>
  <label>封面<input id="cover" type="file" accept="image/png,image/jpeg"></label>
  <output id="preview"></output>
  <label>标题<input id="title"></label>
  <label for="body">正文</label><div id="body" aria-label="正文" contenteditable="true"></div>
  <button id="save" type="button">保存草稿</button>
  <button id="publish" type="button">发布图文</button>
  <button id="manage" type="button">查看笔记管理</button>
  <output id="state">编辑中</output><a id="share" hidden>查看笔记</a>
</main>
<script>
const pick = id => document.getElementById(id);
let cover = '', saved = {}, submitted = false;
pick('cover').onchange = () => {
  cover = pick('cover').files[0]?.name || '';
  pick('preview').textContent = cover ? '已选择图片 ' + cover : '';
};
pick('save').onclick = () => {
  saved = { title: pick('title').value, body: pick('body').innerText, cover };
  pick('state').textContent = '草稿：' + [saved.title, saved.body, saved.cover].join(' / ');
};
pick('publish').onclick = () => {
  if (submitted || !cover || !pick('title').value || !pick('body').innerText) return;
  submitted = true; pick('publish').disabled = true; pick('state').textContent = '审核中';
};
pick('manage').onclick = () => {
  if (!submitted) return;
  pick('state').textContent = '已发布：' + saved.title;
  pick('share').href = '/notes/test-1'; pick('share').hidden = false;
};
</script>`;

test(
  'Xiaohongshu workflow attaches the selected cover, fills both fields and distinguishes draft, review and published states',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 90_000 },
  async () => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(editor);
    }).listen(0, '127.0.0.1');
    await new Promise<void>((done) => server.once('listening', done));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = origin;
    const root = await mkdtemp(join(tmpdir(), 'bambooshift-note-'));
    const workspace = join(root, 'workspace');
    const computer = new LocalComputer(workspace, join(root, 'profile'));
    try {
      // The upload_file transfer handler uses this same exclusive workspace writer.
      const path = 'selected-cover.png';
      await writeComputerFile(workspace, path, png);
      const view = (raw: unknown) =>
        computer.execute(raw) as Promise<{
          text: string;
          controls: { id?: string; href?: string }[];
        }>;
      const initial = await view({ type: 'browser_navigate', url: origin });
      assert.ok(initial.controls.some((el) => el.id === 'cover'));
      const listing = (await computer.execute({ type: 'browser_tabs' })) as {
        tabs: { tabId: string; active: boolean }[];
      };
      const selected = listing.tabs.find((tab) => tab.active);
      assert.ok(selected);
      const attach = {
        type: 'browser_attach_image',
        tabId: selected.tabId,
        path,
        selector: '#cover',
        url: origin,
        sha256: createHash('sha256').update(png).digest('hex'),
      };
      for (const changes of [
        { sha256: '0'.repeat(64) },
        { url: 'https://wrong-site.example' },
        { path: '../private.png' },
        { selector: '#title' },
      ])
        await assert.rejects(computer.execute({ ...attach, ...changes }));
      const attachment = await computer.execute(attach);
      await assert.rejects(computer.execute(attach), /选择文件/);
      assert.ok(
        attachment &&
          typeof attachment === 'object' &&
          'attached' in attachment &&
          attachment.attached === true,
      );
      const title = '雨后的植物观察';
      const body = '薄荷抽了新叶。\n第二天继续观察。';
      await view({ type: 'browser_type', selector: '#title', text: title });
      const filled = await view({ type: 'browser_type', selector: '#body', text: body });
      assert.ok(filled.text.includes('已选择图片 ' + path));
      const draft = await view({ type: 'browser_click', selector: '#save' });
      assert.ok(draft.text.includes(`草稿：${title} / ${body} / ${path}`), draft.text);
      const submission = await view({ type: 'browser_click', selector: '#publish' });
      assert.ok(submission.text.includes('审核中'));
      assert.equal(submission.controls.find((el) => el.id === 'share')?.href, undefined);
      const confirmed = await view({ type: 'browser_click', selector: '#manage' });
      assert.ok(confirmed.text.includes(`已发布：${title}`));
      assert.equal(confirmed.controls.find((el) => el.id === 'share')?.href, '/notes/test-1');
    } finally {
      await computer.close();
      await new Promise<void>((done) => server.close(() => done()));
      if (previous === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
