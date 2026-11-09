import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { chatTimeline } from './chatTimeline';
import { messageTime } from './dates';
import { initializeLanguage } from './i18n';

function bot(id: string, partial: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'group',
    role: 'assistant',
    agentId: 'coordinator',
    kind: 'text',
    status: 'running',
    content: 'I can start.',
    createdAt: '2026-06-01T12:00:00Z',
    ...partial,
  };
}

test('a coordinator handoff hides empty turns and never makes old partial replies blink', () => {
  const intro = bot('intro');
  const empty = bot('empty', { content: ' \n' });
  const handoff = bot('handoff', { role: 'system', kind: 'activity', agentId: 'researcher' });
  const report = bot('report', { agentId: 'researcher', content: 'My findings so far:' });
  const active = chatTimeline([intro, empty, handoff, report], true);
  assert.deepEqual(
    active.rows.map(({ message }) => message.id),
    ['intro', 'handoff', 'report'],
  );
  assert.deepEqual(
    active.rows.filter((row) => row.streaming).map(({ message }) => message.id),
    ['report'],
  );
  assert.equal(active.showWorking, false);
  const between = chatTimeline([intro, empty, handoff, bot('waiting', { content: '' })], true);
  assert.equal(
    between.rows.some((row) => row.streaming),
    false,
  );
  assert.equal(between.showWorking, true);
});

test('a Pi turn can stop streaming while its overall job remains active', () => {
  const prior = bot('prior', { metadata: { streamEnded: true } });
  const duringTool = chatTimeline([prior], true);
  assert.equal(duringTool.rows[0]?.streaming, false);
  assert.equal(duringTool.showWorking, true);
  const newer = bot('newer');
  assert.equal(chatTimeline([prior, newer], true).rows[1]?.streaming, true);
  const finished = chatTimeline([prior, newer], false);
  assert.equal(
    finished.rows.some((row) => row.streaming),
    false,
  );
  assert.equal(finished.showWorking, false);
});

test('empty structured cards, errors and annotations remain addressable', () => {
  const rows = chatTimeline(
    [
      bot('placeholder', { content: '' }),
      bot('file', { kind: 'file', content: '' }),
      bot('approval', { kind: 'approval', content: '' }),
      bot('error', { status: 'error', content: '' }),
      bot('proposal', { content: '', metadata: { teamProposal: {} } }),
      bot('reaction', { content: '', reactions: ['👍'] }),
    ],
    false,
  ).rows;
  assert.deepEqual(
    rows.map(({ message }) => message.id),
    ['file', 'approval', 'error', 'proposal', 'reaction'],
  );
});

test('clusters only adjacent replies by one sender within the local day and time window', () => {
  const { rows } = chatTimeline(
    [
      bot('first'),
      bot('second', { createdAt: '2026-06-01T12:01:00Z' }),
      bot('later', { createdAt: '2026-06-01T12:15:00Z' }),
      bot('other', { createdAt: '2026-06-01T12:16:00Z', agentId: 'researcher' }),
      bot('next-day', { createdAt: '2026-06-02T12:00:00Z', agentId: 'researcher' }),
    ],
    false,
  );
  assert.deepEqual(
    rows.map((row) => [row.groupedWithPrevious, row.groupedWithNext]),
    [
      [false, true],
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.startsDay).map((row) => row.message.id),
    ['first', 'next-day'],
  );
});

test('chat times keep the native local clock across language, zone and daylight-saving changes', () => {
  const language = initializeLanguage();
  const priorLocale = language.getSnapshot().locale;
  const priorZone = process.env.TZ;
  const dates = ['2026-01-01T05:12:00Z', '2026-07-01T13:00:00Z', '2026-11-01T06:45:00Z'];
  try {
    for (const locale of ['zh-CN', 'en'] as const) {
      language.setLanguage(locale);
      for (const zone of ['America/New_York', 'Asia/Kathmandu', 'UTC']) {
        process.env.TZ = zone;
        for (const date of dates) {
          assert.equal(
            messageTime(date),
            new Date(date).toLocaleTimeString(locale, {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }),
          );
        }
      }
    }
  } finally {
    if (priorZone === undefined) delete process.env.TZ;
    else process.env.TZ = priorZone;
    language.setLanguage(priorLocale);
  }
});
