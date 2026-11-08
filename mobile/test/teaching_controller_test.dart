import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/features/teaching/teaching_controller.dart';

import 'teaching_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'opening teaching reads existing state without recording or model calls',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await t.initialize();
      expect(t.ready, true);
      expect(t.canStart, false);
      expect(s.requests.every((r) => r.method == 'GET'), true);
      expect(s.starts, 0);
      expect(s.generates, 0);
      expect(c.teachingBlocked, false);
    }),
  );
  test(
    'record, review and generate use one original request and no auto approval',
    () => teachingScenario((s, t, c, secrets) async {
      await startTeaching(t, c);
      expect(t.liveRecording, true);
      expect(c.canInput, true);
      final id = t.record!['id'];
      final start =
          jsonDecode(
                s.requests
                    .firstWhere(
                      (r) =>
                          r.method == 'POST' &&
                          r.url.path.endsWith('/teaching'),
                    )
                    .body,
              )
              as Json;
      expect(start, {
        'requestId': id,
        'agentId': 'bot-a',
        'conversationId': 'chat-a',
        'leaseId': 'lease-original',
      });
      final step = teachingExample()['steps'][0] as Json;
      s.records[id]!['steps'] = [step];
      await t.stop();
      expect(t.record!['status'], 'review');
      t.updateGoal('Synthetic reviewed reusable task');
      t.updateNote(step['id'], 'Synthetic explanation');
      t.chooseModel(teachingModelId);
      await t.generate();
      expect(s.generates, 0, reason: 'Unsaved notes must not reach a model');
      final oldRevision = t.record!['revision'];
      await t.save();
      final patch =
          jsonDecode(s.requests.singleWhere((r) => r.method == 'PATCH').body)
              as Json;
      expect(patch, {
        'expectedRevision': oldRevision,
        'goal': 'Synthetic reviewed reusable task',
        'steps': [
          {'id': step['id'], 'note': 'Synthetic explanation'},
        ],
      });
      await t.generate();
      await t.generate();
      expect(s.generates, 1);
      expect(t.record!['status'], 'generating');
      expect(s.requests.any((r) => r.url.path.contains('/skills')), false);
      final stored = secrets.values.values.join();
      expect(stored, isNot(contains('Synthetic reviewed reusable task')));
      expect(stored, isNot(contains('Synthetic explanation')));
      expect(stored, isNot(contains('lease-original')));
      expect(stored, isNot(contains('baseUrl')));
      for (final request in s.requests) {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      }
    }),
  );
  test(
    'lost start blocks input, recovers original ID by GET and never retries',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      await t.initialize();
      s.lose = 'start';
      await t.start();
      expect(t.uncertain, true);
      expect(c.canInput, false);
      final id = t.pending!['id'];
      await t.start();
      expect(s.starts, 1);
      s.lose = null;
      await t.check();
      expect(t.record!['id'], id);
      expect(t.uncertain, false);
      expect(t.liveRecording, true);
      expect(c.canInput, true);
      expect(s.starts, 1);
    }),
  );
  test(
    'an absent unconfirmed start needs a closure fence before a new ID',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      await t.initialize();
      s.lose = 'start';
      s.commitLost = false;
      await t.start();
      final id = t.pending!['id'];
      await t.check();
      await t.newRecording();
      await t.start();
      expect(t.pending!['id'], id);
      expect(s.starts, 1);
      s.lose = null;
      await t.cancel();
      expect(s.closed, contains(id));
      expect(t.pending, isNull);
      expect(t.canStart, true);
    }),
  );
  test(
    'lost generation recovers its request without another model call',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      t.chooseModel(teachingModelId);
      s.lose = 'generate';
      await t.generate();
      expect(t.uncertain, true);
      final request = t.pending!['requestId'];
      expect(isRequestId(request), true);
      await t.generate();
      s.lose = null;
      await t.check();
      expect(t.record!['generationRequestId'], request);
      expect(t.record!['status'], 'generating');
      expect(s.generates, 1);
    }),
  );
  test(
    'stale GET cannot release an unknown cancellation for another generation',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      s.lose = 'cancel';
      s.commitLost = false;
      await t.cancel();
      await t.check();
      expect(t.pending!['kind'], 'cancel');
      expect(t.uncertain, true);
      t.chooseModel(teachingModelId);
      await t.generate();
      await t.newRecording();
      expect(s.generates, 0);
      expect(t.pending!['id'], example['id']);
      s.lose = null;
      await t.cancel();
      expect(t.uncertain, false);
      expect(s.cancels, 2, reason: 'Second cancel is an explicit user action');
    }),
  );
  test(
    'model edits invalidate selection before generation is submitted',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample();
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      t.chooseModel(teachingModelId);
      s.profile['model'] = 'replacement';
      await t.generate();
      expect(s.generates, 0);
      expect(t.selectedModel, isNull);
      expect(t.error, 'mobileTeachingModelChanged');
    }),
  );
  test(
    'interrupted steps need an explicit partial acceptance',
    () => teachingScenario((s, t, c, secrets) async {
      final example = teachingExample(status: 'interrupted');
      s.records[example['id']] = example;
      await t.initialize();
      await t.select(example);
      t.chooseModel(teachingModelId);
      await t.generate();
      expect(s.generates, 0);
      t.acceptPartial = true;
      await t.generate();
      expect(s.generates, 1);
      final body =
          jsonDecode(
                s.requests
                    .lastWhere((r) => r.url.path.endsWith('/generate'))
                    .body,
              )
              as Json;
      expect(body['acceptInterrupted'], true);
    }),
  );
  test(
    'a late start after account change is never accepted by the old scope',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      await t.initialize();
      final entered = Completer<void>(), reply = Completer<http.Response>();
      http.Request? original;
      s.intercept = (r) async {
        if (r.method == 'POST' && r.url.path.endsWith('/teaching')) {
          original = r;
          entered.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final work = t.start();
      await entered.future;
      t.scope.session.selectWorkspace(null);
      reply.complete(await s.respond(original!));
      await work;
      expect(t.record, isNull);
      expect(t.active, false);
      expect(s.cancels, 0);
    }),
  );
  test(
    'owner, local Bot and unique direct chat are required before start',
    () => teachingScenario((s, t, c, secrets) async {
      await c.refresh();
      await c.start();
      await t.initialize();
      t.scope.session.workspace!['role'] = 'member';
      await t.start();
      expect(s.starts, 0);
      t.scope.session.workspace!['role'] = 'owner';
      final bot = t.scope.find('agents', 'bot-a')!;
      bot['sharedBot'] = {'status': 'active'};
      await t.start();
      expect(s.starts, 0);
      bot.remove('sharedBot');
      t.scope.data!['conversations'].add({
        'id': 'ambiguous',
        'agentIds': ['bot-a'],
        'isGroup': false,
      });
      await t.start();
      expect(s.starts, 0);
    }),
  );
}
