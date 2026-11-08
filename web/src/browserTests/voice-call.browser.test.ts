import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { SPEECH_LIMITS } from '../../../shared/speech';
import type { Message } from '../../../shared/types';

const workspace = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', name: 'Fixture Owner', email: 'voice@example.test' };
const bot = { id: 'bot', name: 'Voice Bot', role: 'Assistant', color: '#8b6cca', avatar: 'orb' };
const base = `/api/workspaces/${workspace}`;

test(
  'voice call records two real AudioWorklet turns and reconciles a lost response without resending',
  { timeout: 90_000 },
  async (t) => {
    const bundled = await build({
      stdin: {
        contents: `import './web/src/styles.css'; import './web/src/theme.css';
      import { createRoot } from 'react-dom/client';
      import { initializeLanguage } from './web/src/i18n';
      import { LocalizedRoot } from './web/src/i18n/LocalizedRoot';
      initializeLanguage().setLanguage('en');
      createRoot(document.getElementById('root')).render(<LocalizedRoot />);`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const js = bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundled.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const worklet = await readFile('web/public/pcm-recorder.worklet.js', 'utf8');
    const server = createServer((request, response) => {
      if (request.url === '/fixture.js' || request.url === '/pcm-recorder.worklet.js') {
        return response
          .writeHead(200, { 'Content-Type': 'text/javascript' })
          .end(request.url === '/fixture.js' ? js : worklet);
      }
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const chrome = process.env.CHROME_EXECUTABLE;
    const launch = {
      headless: true,
      args: ['--no-proxy-server'],
      executablePath: chrome,
    };
    const browser = await chromium.launch(launch).catch((error: Error) => {
      if (
        chrome ||
        process.platform !== 'darwin' ||
        !error.message.includes("Executable doesn't exist")
      )
        throw error;
      return chromium.launch({
        ...launch,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(10_000);
    await page.addInitScript({
      content: `
      const capture = { count: 0 };
      let events;
      const synth = new EventTarget();
      const spoken = [];
      let pending;
      Object.defineProperty(window, 'speechSynthesis', {
        value: Object.assign(synth, {
          getVoices: () => [
            { voiceURI: 'fixture', name: 'Fixture voice', lang: 'en-US', localService: true },
          ],
          speak: (utterance) => {
            spoken.push(utterance.text);
            pending = utterance;
          },
          cancel: () => {
            pending = undefined;
          },
        }),
      });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        value: class {
          constructor(text) { this.text = text; }
        },
      });
      navigator.mediaDevices.getUserMedia = async () => {
        capture.count++;
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await context.resume();
        capture.gain = gain;
        capture.stream = destination.stream;
        return destination.stream;
      };
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          events = this;
          setTimeout(() => {
            this.onopen?.();
            this.dispatchEvent(
              new MessageEvent('sync', { data: '{"epoch":"voice","revision":0}' }),
            );
          }, 0);
        }
        close() {}
      };
      Object.assign(window, {
        voiceFixture: {
          wave: async () => {
            capture.gain.gain.value = 0.35;
            await new Promise((resolve) => setTimeout(resolve, 560));
            capture.gain.gain.value = 0;
            await new Promise((resolve) => setTimeout(resolve, 900));
          },
          update: (revision) =>
            events?.dispatchEvent(new MessageEvent('update', { lastEventId: 'voice:' + revision })),
          finish: () => {
            const value = pending;
            pending = undefined;
            value?.onend?.();
          },
          info: () => ({
            count: capture.count,
            track: capture.stream?.getAudioTracks()[0]?.readyState,
            spoken,
          }),
        },
      });
    `,
    });
    const now = new Date().toISOString();
    const messages: Message[] = [];
    const snapshot = {
      sync: { epoch: 'voice', revision: 0 },
      agents: [bot],
      conversations: [
        {
          id: 'chat',
          title: bot.name,
          agentIds: [bot.id],
          isGroup: false,
          unread: 0,
          updatedAt: now,
        },
      ],
      messages,
      routines: [],
      files: [],
      skills: [],
      memories: [],
      apps: [],
      settings: { configured: true, model: 'fixture', language: 'en' },
      computer: { status: 'disconnected' },
      runningConversationIds: [],
      runningRequests: [],
    };
    const posts: Array<{ clientId: string; content: string; mode: string; voiceCallId: string }> =
      [];
    let recognized = 0,
      ended = 0,
      callId = '';
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const changed = async () => {
      snapshot.sync.revision++;
      await page.evaluate(
        (revision) => (window as any).voiceFixture.update(revision),
        snapshot.sync.revision,
      );
    };
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/account/session')
        return route.fulfill({
          json: {
            authenticated: true,
            user,
            workspaces: [
              {
                id: workspace,
                name: 'Test Space',
                kind: 'personal',
                role: 'owner',
                status: 'active',
              },
            ],
          },
        });
      if (url.pathname === `${base}/bootstrap`) return route.fulfill({ json: snapshot });
      if (url.pathname === `${base}/speech/status`)
        return route.fulfill({ json: { available: true, ...SPEECH_LIMITS } });
      if (url.pathname === `${base}/speech/transcribe`) {
        assert.equal(request.headers()['x-openbot-expected-user'], user.id);
        assert.equal(request.headers()['x-openbot-voice-call'], callId);
        const bytes = request.postDataBuffer()!;
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(bytes.readUInt32LE(24), 16000);
        assert.ok(bytes.length > 20_000 && bytes.length < 100_000);
        return route.fulfill({
          json: { text: `Question ${++recognized}`, userId: user.id, durationMs: 1200 },
        });
      }
      if (url.pathname === `${base}/conversations/chat/voice-calls`) {
        callId = request.postDataJSON().id;
        return route.fulfill({
          json: {
            call: {
              id: callId,
              userId: user.id,
              conversationId: 'chat',
              agentId: bot.id,
              startedAt: now,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
          },
        });
      }
      if (url.pathname === `${base}/conversations/chat/voice-calls/${callId}/end`) {
        ended++;
        messages.push({
          id: 'card',
          conversationId: 'chat',
          role: 'system',
          kind: 'voice_call',
          userId: user.id,
          agentId: bot.id,
          content: 'Voice chat',
          createdAt: now,
          metadata: { voiceCall: { id: callId, startedAt: now, endedAt: now, durationMs: 7000 } },
        });
        await changed();
        return route.fulfill({ json: { call: {} } });
      }
      if (url.pathname === `${base}/conversations/chat/messages` && request.method() === 'POST') {
        const body = request.postDataJSON();
        posts.push(body);
        const number = posts.length;
        const human: Message = {
          id: `input-${number}`,
          conversationId: 'chat',
          role: 'user',
          kind: 'text',
          userId: user.id,
          content: body.content,
          createdAt: now,
          metadata: { voiceCallId: callId },
          delivery: { state: 'delivered', mode: 'followUp', clientId: body.clientId },
        };
        const assistant: Message = {
          id: `reply-${number}`,
          conversationId: 'chat',
          role: 'assistant',
          kind: 'text',
          agentId: bot.id,
          content: `Answer ${number}`,
          createdAt: now,
          status: 'done',
          metadata: { voiceCallId: callId, inputMessageId: human.id, voiceCallTerminal: true },
        };
        messages.push(human, assistant);
        await changed();
        return route.fulfill(
          number === 1
            ? { status: 503, json: { error: 'Response lost' } }
            : { json: { message: human } },
        );
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
      return route.continue();
    });
    await page.goto(`${origin}/w/${workspace}?conversation=chat`, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });
    const start = page.getByRole('button', { name: 'Start voice chat', exact: true });
    await start.click();
    const consent = page.getByRole('dialog', { name: 'Start voice chat' });
    await consent.getByText(/server transcribes each spoken turn/).waitFor();
    assert.equal(await page.evaluate(() => (window as any).voiceFixture.info().count), 0);
    await consent.getByRole('button', { name: 'Start voice chat' }).click();
    const panel = page.getByRole('region', { name: 'Voice chat', exact: true });
    await panel.getByText('Listening…').waitFor();
    await panel.getByRole('button', { name: 'Mute microphone' }).click();
    await page.evaluate(() => (window as any).voiceFixture.wave());
    assert.equal(recognized, 0);
    await panel.getByRole('button', { name: 'Unmute microphone' }).click();
    await page.evaluate(() => (window as any).voiceFixture.wave());
    await panel.getByRole('button', { name: 'Interrupt playback' }).click();
    await panel.getByText('Listening…').waitFor();
    await page.evaluate(() => (window as any).voiceFixture.wave());
    await panel.getByText('Reading the reply…').waitFor();
    await page.evaluate(() => (window as any).voiceFixture.finish());
    await panel.getByText('Listening…').waitFor();
    const before = await page.evaluate(() => (window as any).voiceFixture.info());
    assert.deepEqual(before, { count: 1, track: 'live', spoken: ['Answer 1', 'Answer 2'] });
    await panel.getByRole('button', { name: 'Hang up' }).click();
    await page.locator('#message-card').getByText('Show transcript').click();
    await page.locator('#message-card').getByText('Answer 2').waitFor();
    await page.locator('#message-card').getByRole('button', { name: 'Read reply' }).last().click();
    const after = await page.evaluate(() => (window as any).voiceFixture.info());
    assert.equal(after.track, 'ended');
    assert.deepEqual(after.spoken, ['Answer 1', 'Answer 2', 'Answer 2']);
    assert.equal(ended, 1);
    assert.deepEqual(
      posts.map(({ content, mode, voiceCallId }) => ({ content, mode, voiceCallId })),
      [1, 2].map((number) => ({
        content: `Question ${number}`,
        mode: 'followUp',
        voiceCallId: callId,
      })),
    );
    assert.equal(new Set(posts.map(({ clientId }) => clientId)).size, 2);
    assert.deepEqual(errors, []);
  },
);
