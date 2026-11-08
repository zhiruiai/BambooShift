import test from 'node:test';
import assert from 'node:assert/strict';
import { previewAction } from './htmlPreviewActions';

test('recognized preview controls preserve literal text and Unicode answer keys', () => {
  assert.deepEqual(previewAction("showSection('lesson-2')"), {
    kind: 'section',
    args: ['lesson-2'],
  });
  assert.deepEqual(previewAction('toggleCard(this)'), { kind: 'card', args: [] });
  assert.deepEqual(previewAction('event.stopPropagation(); speak("A, B and C");'), {
    kind: 'speak',
    args: ['A, B and C'],
  });
  assert.deepEqual(previewAction("checkAns(this, '对')"), { kind: 'answer', args: ['对'] });
  assert.deepEqual(previewAction('showInfo("Title", "<img src=external>")'), {
    kind: 'info',
    args: ['Title', '<img src=external>'],
  });
  assert.deepEqual(previewAction('playDivisionAnim()'), { kind: 'advance', args: [] });
  assert.deepEqual(previewAction('resetDivisionAnim()'), { kind: 'resetStages', args: [] });
  assert.deepEqual(previewAction('resetQuiz()'), { kind: 'resetQuiz', args: [] });
});

test('executable expressions, navigation, and oversized or substituted arguments are never actions', () => {
  for (const source of [
    "showSection('x'); fetch('https://invalid.example.test')",
    'showSection(location.href)',
    'showSection(`a${document.cookie}`)',
    "showSection('https://invalid.example.test')",
    "toggleCard('this')",
    'checkAns(this, document.cookie)',
    'checkAns(this, "x",)',
    'event.stopPropagation(); resetQuiz()',
    'location.href = "https://invalid.example.test"',
    "speak('a\\nb')",
    `speak('${'a'.repeat(2001)}')`,
  ]) {
    assert.equal(previewAction(source), undefined, source.slice(0, 60));
  }
});
