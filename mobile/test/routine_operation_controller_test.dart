import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/routine_operation_controller.dart';

import 'routine_operation_support.dart';
import 'support.dart';

void main() {
  test(
    'creation persists the frozen request before its single dispatch',
    () async {
      final secrets = MemorySecrets();
      Json? sent;
      final f = await fixture((request) async {
        expect(request.url.path, '/api/workspaces/space-a/routine-operations');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        sent = jsonDecode(request.body) as Json;
        final persisted = jsonDecode(secrets.values.values.single) as Json;
        expect(persisted['body'], sent);
        return jsonResponse(operationReceipt(sent!), status: 201);
      }, secrets: secrets);
      final c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      final barrier = Completer<void>();
      final held = f.session.api.vault.serial(() => barrier.future);
      final draft = routineConfigFixture();
      final creating = c.create(draft);
      draft['prompt'] = 'Changed after click';
      barrier.complete();
      await held;
      await creating;
      expect(sent!['prompt'], 'Only synthetic information.');
      expect(c.receipt!['status'], 'created');
      expect(c.locked, isTrue);
      expect(await c.finish(), isTrue);
      expect(secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'lost run survives restart and only reads the original receipt',
    () async {
      Json? sent;
      var dispatches = 0, reads = 0;
      final secrets = MemorySecrets();
      var f = await fixture((request) async {
        dispatches++;
        sent = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic loss after acceptance');
      }, secrets: secrets);
      var c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.run(routineFixture());
      expect(sent!['expectedRoutine'], routineConfigFixture());
      expect((sent!['expectedRoutine'] as Json).keys, hasLength(7));
      final id = c.pending!['body']['requestId'];
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
      f = await fixture((request) async {
        expect(request.method, 'GET');
        expect(
          request.url.path,
          '/api/workspaces/space-a/routine-operations/$id',
        );
        reads++;
        return jsonResponse(operationReceipt(sent!, status: 'completed'));
      }, secrets: secrets);
      c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.run(routineFixture()..['prompt'] = 'Changed configuration');
      expect(c.receipt!['status'], 'completed');
      expect(c.pending!['body']['requestId'], id);
      expect(dispatches, 1);
      expect(reads, 1);
      await c.check();
      expect(reads, 2);
      expect(dispatches, 1);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    '404 retains the request; lost cancellation recovers its exact 410 fence',
    () async {
      var closed = false;
      final posts = <Json>[];
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/cancel')) {
          expect(jsonDecode(request.body), {});
          closed = true;
          throw http.ClientException('Synthetic lost cancellation result');
        }
        if (request.method == 'GET') {
          return jsonResponse({
            'code': closed
                ? 'ROUTINE_OPERATION_CLOSED'
                : 'ROUTINE_OPERATION_NOT_FOUND',
            'error': 'Synthetic',
          }, status: closed ? 410 : 404);
        }
        final body = jsonDecode(request.body) as Json;
        posts.add(body);
        if (posts.length == 1) {
          throw http.ClientException('Synthetic request not received');
        }
        return jsonResponse(operationReceipt(body), status: 201);
      });
      var c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.create(routineConfigFixture());
      final id = c.pending!['body']['requestId'];
      await c.check();
      expect(c.pending!['body']['requestId'], id);
      await c.cancel();
      expect(c.pending!['body']['requestId'], id);
      c.dispose();
      c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      expect(c.pending, isNull);
      await c.create(routineConfigFixture());
      expect(posts, hasLength(2));
      expect(posts[1]['requestId'], isNot(id));
      expect(c.receipt!['status'], 'created');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'cancel after acceptance reads the original run and never sends stop',
    () async {
      Json? body;
      final paths = <String>[];
      final f = await fixture((request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/cancel')) {
          return jsonResponse(operationReceipt(body!));
        }
        body = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic lost run result');
      });
      final c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.run(routineFixture());
      await c.cancel();
      expect(c.receipt!['status'], 'submitted');
      expect(c.pending, isNotNull);
      expect(paths, hasLength(2));
      expect(
        paths.any((p) => p.endsWith('/stop') || p.endsWith('/run')),
        isFalse,
      );
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'storage failure and disposal before persistence never dispatch',
    () async {
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      var c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      f.secrets.rejectWrites = true;
      await c.run(routineFixture());
      expect(c.error, isNotNull);
      expect(calls, 0);
      f.secrets.rejectWrites = false;
      final barrier = Completer<void>();
      final held = f.session.api.vault.serial(() => barrier.future);
      final operation = c.run(routineFixture());
      c.dispose();
      barrier.complete();
      await held;
      await operation;
      expect(calls, 0);
      expect(f.secrets.values, isEmpty);
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'overlapping mounted controllers use one stored operation and one POST',
    () async {
      var calls = 0;
      final f = await fixture((request) async {
        calls++;
        return jsonResponse(operationReceipt(jsonDecode(request.body) as Json));
      });
      final a = RoutineOperationController(f.scope, 'bot-a');
      final b = RoutineOperationController(f.scope, 'bot-a');
      await a.initialize();
      await b.initialize();
      await Future.wait([a.run(routineFixture()), b.run(routineFixture())]);
      expect(calls, 1);
      expect(a.pending!['body']['requestId'], b.pending!['body']['requestId']);
      expect(f.secrets.values, hasLength(1));
      a.dispose();
      b.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'deleted accepted result stays missing and is never recreated',
    () async {
      Json? body;
      var posts = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          posts++;
          body = jsonDecode(request.body) as Json;
        }
        return jsonResponse(operationReceipt(body!, status: 'missing'));
      });
      final c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.create(routineConfigFixture());
      await c.check();
      await c.create(routineConfigFixture());
      expect(c.receipt!['status'], 'missing');
      expect(posts, 1);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
