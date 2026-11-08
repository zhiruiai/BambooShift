import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/creation_controller.dart';

import 'support.dart';

Json receipt(Json body) => {
  'requestId': body['requestId'],
  'userId': 'user-a',
  'workspaceId': 'space-a',
  'kind': body['kind'],
  'status': 'created',
  'conversationId': 'new-chat',
  'agentIds': ['new-bot'],
  'conversation': {
    'id': 'new-chat',
    'isGroup': false,
    'agentIds': ['new-bot'],
  },
  'agents': [
    {'id': 'new-bot', 'name': 'Created'},
  ],
};
void main() {
  test(
    'the creation payload is frozen before asynchronous persistence',
    () async {
      Json? sent;
      final f = await fixture((request) async {
        sent = jsonDecode(request.body) as Json;
        return jsonResponse(receipt(sent!));
      });
      final controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      final barrier = Completer<void>();
      final held = f.session.api.vault.serial(() => barrier.future);
      final profile = <String, dynamic>{'name': 'Original', 'role': 'Helper'};
      final creating = controller.start({'profile': profile});
      profile['name'] = 'Changed after click';
      barrier.complete();
      await held;
      await creating;
      expect(sent?['profile']['name'], 'Original');
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'closing during secure persistence does not create a hidden Bot',
    () async {
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      final controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      final barrier = Completer<void>();
      final held = f.session.api.vault.serial(() => barrier.future);
      final creating = controller.start({
        'profile': {'name': 'Example', 'role': 'Helper'},
      });
      controller.dispose();
      barrier.complete();
      await held;
      await creating;
      expect(calls, 0);
      expect(f.secrets.values, isEmpty);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost creation response survives remount and reads its original receipt',
    () async {
      var writes = 0;
      Json? saved;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes++;
          saved = jsonDecode(request.body) as Json;
          throw http.ClientException('Synthetic loss');
        }
        return jsonResponse(receipt(saved!));
      });
      var controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      await controller.start({
        'profile': {'name': 'Example', 'role': 'Helper'},
      });
      expect(controller.pending, isNotNull);
      expect(writes, 1);
      controller.dispose();
      controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      expect(controller.receipt?['status'], 'created');
      expect(writes, 1);
      expect(controller.pending?['requestId'], saved!['requestId']);
      await controller.finish();
      expect(f.secrets.values, isEmpty);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    '404 does not clear an unknown attempt; only a real cancellation fences it',
    () async {
      final methods = <String>[];
      final f = await fixture((request) async {
        methods.add('${request.method} ${request.url.path}');
        if (request.url.path.endsWith('/cancel')) {
          return jsonResponse({
            'requestId':
                request.url.pathSegments[request.url.pathSegments.length - 2],
            'userId': 'user-a',
            'workspaceId': 'space-a',
            'status': 'not_submitted',
          });
        }
        if (request.method == 'GET') {
          return jsonResponse({
            'code': 'NOT_FOUND',
            'error': 'Missing',
          }, status: 404);
        }
        throw http.ClientException('Synthetic loss');
      });
      final controller = CreationController(f.scope, 'group');
      await controller.initialize();
      await controller.start({
        'title': 'Group',
        'agentIds': ['a', 'b'],
      });
      final id = controller.pending!['requestId'];
      await controller.check();
      expect(controller.pending?['requestId'], id);
      await controller.cancel();
      expect(controller.pending, isNull);
      expect(controller.receipt, isNull);
      expect(
        methods.where((m) => m.endsWith('/creation-requests')),
        hasLength(1),
      );
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'cancel after acceptance returns the same group instead of suggesting it was stopped',
    () async {
      Json? saved;
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/cancel')) {
          return jsonResponse(receipt(saved!));
        }
        saved = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic loss');
      });
      final controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      await controller.start({
        'profile': {'name': 'Example', 'role': 'Helper'},
      });
      await controller.cancel();
      expect(controller.receipt?['status'], 'created');
      expect(controller.pending, isNotNull);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'wrong actor receipts and malformed current entity projections stay unresolved',
    () async {
      var badActor = true;
      final f = await fixture((request) async {
        final body = jsonDecode(request.body) as Json;
        final value = receipt(body);
        if (badActor) {
          value['userId'] = 'user-b';
        } else {
          value['agents'] = [];
        }
        return jsonResponse(value);
      });
      final controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      await controller.start({
        'profile': {'name': 'Example', 'role': 'Helper'},
      });
      expect(controller.receipt, isNull);
      expect(controller.pending, isNotNull);
      badActor = false;
      await controller.retry();
      expect(controller.receipt, isNull);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'account switch drops a late result and keeps the original encrypted recovery record',
    () async {
      final late = Completer<http.Response>();
      Json? body;
      final f = await fixture((request) {
        body = jsonDecode(request.body) as Json;
        return late.future;
      });
      final controller = CreationController(f.scope, 'bot');
      await controller.initialize();
      final sending = controller.start({
        'profile': {'name': 'Example', 'role': 'Helper'},
      });
      await Future<void>.delayed(Duration.zero);
      f.session.user = {'id': 'user-b'};
      late.complete(jsonResponse(receipt(body!)));
      await sending;
      expect(controller.receipt, isNull);
      expect(controller.pending, isNotNull);
      expect(f.secrets.values, hasLength(1));
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('storage failure blocks both the first mutation and retries', () async {
    var calls = 0;
    final f = await fixture((_) async {
      calls++;
      return jsonResponse({});
    });
    final controller = CreationController(f.scope, 'bot');
    await controller.initialize();
    f.secrets.rejectWrites = true;
    await controller.start({
      'profile': {'name': 'Example', 'role': 'Helper'},
    });
    await controller.retry();
    expect(calls, 0);
    controller.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
