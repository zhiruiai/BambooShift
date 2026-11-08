import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/routine_operation_data.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_controller.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_data.dart';

import 'routine_transfer_support.dart';
import 'support.dart';

void main() {
  test(
    'transfer uses exact original configuration and fixed actor, preserving scheduling',
    () async {
      final server = TransferServer();
      final f = await fixture((r) async {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(r.url.path.startsWith('/api/workspaces/space-a/'), true);
        return server.handle(r);
      });
      f.scope.data = server.data;
      final c = RoutineTransferController(f.scope, 'routine-a');
      await c.initialize();
      final choices = transferTargets(f.scope, 'bot-a');
      expect(choices.length, 1);
      expect(choices.single['agent']['id'], 'bot-b');
      final before = transferRoutine();
      await c.start(before, choices.single);
      expect(server.transfers, 1);
      final body = jsonDecode(server.requests.first.body) as Json;
      expect(body.keys.toSet(), {
        'requestId',
        'expectedRoutine',
        'targetAgentId',
        'targetConversationId',
      });
      expect(body['expectedRoutine'], routineConfig(before));
      expect((body['expectedRoutine'] as Json).keys.length, 7);
      expect(c.receipt?['routine']['enabled'], false);
      expect(c.receipt?['routine']['nextRunAt'], before['nextRunAt']);
      expect(c.receipt?['routine']['lastRunAt'], before['lastRunAt']);
      expect(server.requests.any((r) => r.url.path.endsWith('/run')), false);
      final stored = jsonDecode(f.secrets.values.values.single) as Json;
      expect(stored.keys.toSet(), {
        'version',
        'requestId',
        'routineId',
        'userId',
        'workspaceId',
        ...transferTuple,
      });
      expect(f.secrets.values.values.single, isNot(contains(before['prompt'])));
      expect(await c.finish(), true);
      expect(f.secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost accepted response restores exact receipt after routine leaves original Bot',
    () async {
      final server = TransferServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'POST' && r.url.path.endsWith('/transfer')) {
          throw http.ClientException('Lost response');
        }
        return response;
      });
      f.scope.data = server.data;
      final c = RoutineTransferController(f.scope, 'routine-a');
      await c.initialize();
      await c.start(
        transferRoutine(),
        transferTargets(f.scope, 'bot-a').single,
      );
      expect(c.receipt, isNull);
      expect(c.pending, isNotNull);
      c.dispose();
      await f.scope.refresh();
      expect(f.scope.items('routines').single['agentId'], 'bot-b');
      final pending = await readTransferRecovery(f.scope);
      expect(pending?['sourceAgentId'], 'bot-a');
      final restored = RoutineTransferController(f.scope, 'routine-a');
      await restored.initialize();
      expect(restored.receipt?['status'], 'transferred');
      expect(server.transfers, 1);
      await restored.cancel();
      expect(restored.receipt?['status'], 'transferred');
      expect(server.closed, false);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    '404 preserves identity until explicit server closure fences the original request',
    () async {
      final server = TransferServer();
      final f = await fixture((r) async {
        if (r.method == 'POST' && r.url.path.endsWith('/transfer')) {
          throw http.ClientException('Unknown');
        }
        return server.handle(r);
      });
      f.scope.data = server.data;
      final c = RoutineTransferController(f.scope, 'routine-a');
      await c.initialize();
      await c.start(
        transferRoutine(),
        transferTargets(f.scope, 'bot-a').single,
      );
      final original = c.pending!['requestId'];
      await c.check();
      expect(c.pending!['requestId'], original);
      expect(c.error, 'mobileWorkspaceTransferNotFound');
      await c.cancel();
      expect(c.pending, isNull);
      expect(server.closed, true);
      expect(f.secrets.values, isEmpty);
      expect(
        server.requests.where((r) => r.method == 'POST').single.url.path,
        '/api/workspaces/space-a/routine-transfers/$original/cancel',
      );
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'wrong target receipt is rejected; deleted routine receipt never reconstructs a task',
    () async {
      final server = TransferServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'POST') {
          server.saved!['targetConversationId'] = 'foreign-chat';
          return jsonResponse(server.saved!);
        }
        return response;
      });
      f.scope.data = server.data;
      final c = RoutineTransferController(f.scope, 'routine-a');
      await c.initialize();
      await c.start(
        transferRoutine(),
        transferTargets(f.scope, 'bot-a').single,
      );
      expect(c.receipt, isNull);
      expect(c.error, 'mobileWorkspaceTransferInvalid');
      server.saved!['targetConversationId'] = 'chat-b';
      server.saved!['status'] = 'missing';
      server.saved!.remove('routine');
      server.data['routines'] = [];
      await c.check();
      expect(c.receipt?['status'], 'missing');
      expect(server.transfers, 1);
      expect(f.scope.items('routines'), isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'multiple mounts share one transfer slot and stale configuration cannot dispatch',
    () async {
      final server = TransferServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final first = RoutineTransferController(f.scope, 'routine-a'),
          second = RoutineTransferController(f.scope, 'routine-a');
      await first.initialize();
      await second.initialize();
      final target = transferTargets(f.scope, 'bot-a').single;
      await first.start({
        ...transferRoutine(),
        'prompt': 'Stale prompt',
      }, target);
      expect(server.transfers, 0);
      await Future.wait([
        first.start(transferRoutine(), target),
        second.start(transferRoutine(), target),
      ]);
      expect(server.transfers, 1);
      expect(first.pending?['requestId'], second.pending?['requestId']);
      first.dispose();
      second.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'member/team/shared/ambiguous source and unavailable recovery storage do not dispatch',
    () async {
      for (final mode in ['member', 'team', 'shared', 'ambiguous', 'storage']) {
        final server = TransferServer();
        final f = await fixture(server.handle);
        f.scope.data = server.data;
        final c = RoutineTransferController(f.scope, 'routine-a');
        await c.initialize();
        if (mode == 'member') f.session.workspace!['role'] = 'member';
        if (mode == 'team') f.session.workspace!['kind'] = 'team';
        if (mode == 'shared') f.scope.items('agents').first['sharedBot'] = null;
        if (mode == 'ambiguous') {
          (f.scope.data!['conversations'] as List).add({
            'id': 'other',
            'isGroup': false,
            'agentIds': ['bot-a'],
          });
        }
        if (mode == 'storage') f.secrets.rejectWrites = true;
        await c.start(
          transferRoutine(),
          transferTargets(f.scope, 'bot-a').first,
        );
        expect(server.transfers, 0, reason: mode);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'account switch hides late accepted receipt and never sends it again',
    () async {
      final server = TransferServer();
      final late = Completer<http.Response>(), started = Completer<void>();
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          final result = await server.handle(r);
          started.complete();
          await late.future;
          return result;
        }
        return server.handle(r);
      });
      f.scope.data = server.data;
      final c = RoutineTransferController(f.scope, 'routine-a');
      await c.initialize();
      final send = c.start(
        transferRoutine(),
        transferTargets(f.scope, 'bot-a').single,
      );
      await started.future;
      f.session.selectWorkspace(null);
      late.complete(jsonResponse({}));
      await send;
      expect(c.receipt, isNull);
      expect(c.active, false);
      expect(server.transfers, 1);
      expect(f.secrets.values, isNotEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
