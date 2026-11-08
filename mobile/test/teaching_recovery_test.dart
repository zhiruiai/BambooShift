import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/features/teaching/teaching_controller.dart';
import 'package:openbot_mobile/features/teaching/teaching_data.dart';
import 'package:openbot_mobile/features/teaching/teaching_pending.dart';

import 'teaching_support.dart';

Json marker(String id, String kind) => {
  'version': 1,
  'operationId': requestId(),
  'id': id,
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'userId': 'user-a',
  'workspaceId': 'space-a',
  'kind': kind,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'manual input is blocked before the initial recovery read begins',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      expect(t.ready, false);
      expect(c.teachingBlocked, true);
      expect(c.canInput, false);
      await t.initialize();
      expect(c.canInput, true);
    }),
  );
  test(
    'record validation accepts the optional screen binding in Rust records',
    () {
      final value = teachingExample();
      (value['screen'] as Json).remove('screenId');
      expect(teachingRecord(value, 'bot-a')['id'], value['id']);
      value['screen']['instanceId'] = 'invalid-instance';
      expect(
        () => teachingRecord(value, 'bot-a'),
        throwsA(isA<ApiException>()),
      );
    },
  );
  test(
    'existing live recording is surfaced before manual input can continue',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      final example = teachingExample(status: 'recording');
      s.records[example['id']] = example;
      await t.initialize();
      expect(t.record!['id'], example['id']);
      expect(t.liveRecording, false);
      expect(c.canInput, false);
      expect(s.starts, 0);
      expect(s.generates, 0);
    }),
  );
  test(
    'recovered recording cannot adopt an unrelated in-memory control lease',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      final example = teachingExample(status: 'recording');
      s.records[example['id']] = example;
      await t.recovery.replace(marker(example['id'], 'idle'), null);
      await t.initialize();
      expect(t.record!['id'], example['id']);
      expect(t.liveRecording, false);
      expect(c.canInput, false);
      await t.stop();
      expect(s.stops, 1);
      expect(t.record!['status'], 'review');
      expect(c.canInput, true);
    }),
  );
  test(
    'unavailable recovery storage prevents start without dispatching',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      await t.initialize();
      secrets.rejectWrites = true;
      await t.start();
      expect(s.starts, 0);
      expect(t.record, isNull);
      expect(t.busy, false);
      expect(c.canInput, true);
    }),
  );
  test(
    'two mounted editors cannot claim different requests in the same slot',
    () => teachingScenario((s, t, c, secrets) async {
      final other = TeachingPending(t.scope, 'bot-a');
      final a = marker(requestId(), 'start');
      final b = marker(requestId(), 'start');
      final outcomes = await Future.wait([
        t.recovery
            .replace(a, null)
            .then<Object?>((_) => null, onError: (Object e) => e),
        other
            .replace(b, null)
            .then<Object?>((_) => null, onError: (Object e) => e),
      ]);
      expect(outcomes.whereType<ApiException>().length, 1);
      await t.recovery.load();
      expect(t.pending!['id'], a['id']);
      expect(s.starts, 0);
      await t.recovery.clear(t.pending!);
    }),
  );
  test(
    'recovery metadata rejects body, token and cross-account injection',
    () => teachingScenario((s, t, c, secrets) async {
      final metadata = marker(requestId(), 'start');
      for (final extra in [
        {'leaseId': 'not-for-storage'},
        {'steps': <Object>[]},
        {'userId': 'another-user'},
        {'kind': 'generate'},
        {'kind': 'review'},
        {'conversationId': ''},
        {'conversationId': 'a' * 2049},
      ]) {
        secrets.values[t.recovery.key] = jsonEncode({...metadata, ...extra});
        await expectLater(t.recovery.load(), throwsA(isA<ApiException>()));
      }
      secrets.values.remove(t.recovery.key);
      expect(s.requests, isEmpty);
    }),
  );
  test(
    'Bot revision changes immediately block input and fence old recording',
    () => teachingScenario((s, t, c, secrets) async {
      await startTeaching(t, c);
      expect(c.canInput, true);
      await t.scope.refresh();
      expect(t.liveRecording, false);
      expect(c.canInput, false);
      for (var n = 0; n < 20 && s.cancels == 0; n++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(s.cancels, 1);
      expect(s.computer.inputs, isEmpty);
      expect(t.pending!['kind'], 'cancel');
    }),
  );
  test(
    'foreign generation receipt cannot unlock the original pending request',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      t.chooseModel(teachingModelId);
      s.lose = 'generate';
      s.commitLost = false;
      await t.generate();
      final original = t.pending!['requestId'];
      s.records[example['id']]!['status'] = 'generating';
      s.records[example['id']]!['generationRequestId'] = requestId();
      await t.check();
      expect(t.uncertain, true);
      expect(t.pending!['requestId'], original);
      expect(s.generates, 1);
    }),
  );
  test(
    'local edits survive a changed record until explicitly reloaded',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      t.updateGoal('Synthetic unsaved notes');
      s.records[example['id']] = {
        ...example,
        'revision': requestId(),
        'goal': 'Synthetic concurrent edit',
      };
      await t.check();
      expect(t.changed, true);
      expect(t.draft!['goal'], 'Synthetic unsaved notes');
      await t.save();
      expect(s.reviews, 0);
      t.loadDraft();
      expect(t.changed, false);
      expect(t.draft!['goal'], 'Synthetic concurrent edit');
    }),
  );
  test(
    'record validation rejects invented actions and private input details',
    () {
      for (final changes in [
        {'action': 'run_shell'},
        {
          'details': {'text': 'Synthetic private input'},
        },
        {'id': 'not-a-request-id'},
      ]) {
        final value = teachingExample();
        value['steps'][0] = {...value['steps'][0] as Json, ...changes};
        expect(
          () => teachingRecord(value, 'bot-a'),
          throwsA(isA<ApiException>()),
        );
      }
    },
  );
  test(
    'background bootstrap refresh does not poison future read-only recovery',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      c.suspend();
      await t.scope.refresh();
      c.resume();
      await t.check();
      expect(t.error, isNull);
      expect(t.record!['id'], example['id']);
      expect(t.draft, isNotNull);
      expect(s.generates, 0);
    }),
  );
}
