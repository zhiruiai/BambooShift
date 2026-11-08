import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/routine_operation_controller.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';

import 'routine_operation_support.dart';
import 'support.dart';

class FailingDeleteSecrets extends MemorySecrets {
  bool rejectDelete = false;
  @override
  Future<void> delete(String key) async {
    if (rejectDelete) throw StateError('Synthetic device storage failure');
    await super.delete(key);
  }
}

void main() {
  test(
    'actor, workspace and origin partition recovery without reading another account',
    () async {
      final secrets = MemorySecrets();
      final f = await fixture((_) async {
        throw http.ClientException('Synthetic loss');
      }, secrets: secrets);
      final original = RoutineOperationController(f.scope, 'bot-a');
      await original.initialize();
      await original.run(routineFixture());
      final record = secrets.values.values.single;
      var reads = 0;
      for (final boundary in ['actor', 'workspace', 'origin']) {
        final other = await fixture((_) async {
          reads++;
          return jsonResponse({});
        }, secrets: secrets);
        if (boundary == 'actor') other.session.user = {'id': 'user-b'};
        if (boundary == 'workspace') {
          other.session.workspace = {'id': 'space-b', 'role': 'owner'};
        }
        if (boundary == 'origin') {
          await other.session.api.configure(
            parseServer('https://other.example.test'),
          );
        }
        final scope = WorkspaceController(other.session);
        final controller = RoutineOperationController(scope, 'bot-a');
        await controller.initialize();
        expect(controller.pending, isNull, reason: boundary);
        expect(controller.ready, isTrue);
        expect(reads, 0);
        controller.dispose();
        scope.dispose();
        other.scope.dispose();
        other.session.dispose();
      }
      expect(secrets.values.values.single, record);
      original.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'late accepted response cannot publish after account or workspace changes',
    () async {
      for (final boundary in ['actor', 'workspace']) {
        final response = Completer<http.Response>();
        final dispatched = Completer<Json>();
        final f = await fixture((request) {
          dispatched.complete(jsonDecode(request.body) as Json);
          return response.future;
        });
        final c = RoutineOperationController(f.scope, 'bot-a');
        await c.initialize();
        final operation = c.run(routineFixture());
        final body = await dispatched.future;
        if (boundary == 'actor') f.session.user = {'id': 'other-user'};
        if (boundary == 'workspace') {
          f.session.workspace = {'id': 'other-space', 'role': 'owner'};
        }
        response.complete(jsonResponse(operationReceipt(body)));
        await operation;
        expect(c.receipt, isNull);
        expect(f.secrets.values, hasLength(1));
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );

  test(
    'untrusted receipt tuples and all uncertain HTTP errors retain the same request',
    () async {
      for (final mode in [
        'actor',
        'workspace',
        'agent',
        'routine',
        'message',
        '401',
        '403',
        '404',
        '409',
        '422',
      ]) {
        final f = await fixture((request) async {
          final body = jsonDecode(request.body) as Json;
          final status = int.tryParse(mode);
          if (status != null) {
            return jsonResponse({
              'code': status == 422
                  ? 'ROUTINE_OPERATION_NOT_STARTED'
                  : 'SYNTHETIC_ERROR',
              'error': 'Synthetic rejection',
            }, status: status);
          }
          final result = operationReceipt(body);
          result[{
            'actor': 'userId',
            'workspace': 'workspaceId',
            'agent': 'agentId',
            'routine': 'routineId',
            'message': 'messageId',
          }[mode]!] = mode == 'message'
              ? null
              : 'foreign';
          return jsonResponse(result);
        });
        final c = RoutineOperationController(f.scope, 'bot-a');
        await c.initialize();
        await c.run(routineFixture());
        expect(c.receipt, isNull, reason: mode);
        expect(c.pending, isNotNull, reason: mode);
        expect(c.locked, isTrue);
        expect(f.secrets.values, hasLength(1));
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );

  test(
    'corrupt recovery metadata fails closed without requests or deleting evidence',
    () async {
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      final key = f.session.api.vault.key(
        'https://api.example.test',
        'routine-operation:user-a:space-a:bot-a',
      );
      f.secrets.values[key] = '{broken';
      final c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.create(routineConfigFixture());
      expect(c.ready, isFalse);
      expect(c.locked, isTrue);
      expect(calls, 0);
      expect(f.secrets.values[key], '{broken');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'failed acknowledgement storage deletion cannot unlock another submission',
    () async {
      var calls = 0;
      final secrets = FailingDeleteSecrets();
      final f = await fixture((request) async {
        calls++;
        return jsonResponse(operationReceipt(jsonDecode(request.body) as Json));
      }, secrets: secrets);
      final c = RoutineOperationController(f.scope, 'bot-a');
      await c.initialize();
      await c.run(routineFixture());
      secrets.rejectDelete = true;
      expect(await c.finish(), isFalse);
      await c.run(routineFixture());
      expect(calls, 1);
      expect(c.pending, isNotNull);
      secrets.rejectDelete = false;
      expect(await c.finish(), isTrue);
      expect(secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test('a member or downgraded owner never dispatches an operation', () async {
    var calls = 0;
    final f = await fixture((_) async {
      calls++;
      return jsonResponse({});
    });
    final c = RoutineOperationController(f.scope, 'bot-a');
    await c.initialize();
    f.session.workspace!['role'] = 'member';
    await c.run(routineFixture());
    expect(calls, 0);
    expect(f.secrets.values, isEmpty);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
