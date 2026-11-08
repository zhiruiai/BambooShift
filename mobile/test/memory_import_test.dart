import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/memory_import_controller.dart';

import 'support.dart';

const primary = {
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'revision': '00000000-0000-4000-8000-000000000001',
};
const importReady = {
  'available': true,
  'primary': primary,
  'modelConfigured': true,
};
const source = 'Synthetic source that must never be saved in a recovery record';
Json receipt(Json body) => {
  'requestId': body['requestId'],
  'userId': 'user-a',
  'workspaceId': 'space-a',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'primaryRevision': primary['revision'],
  'messageId': 'input-a',
  'status': 'queued',
};

void main() {
  test(
    'import uses the reviewed primary revision, persists no source, and never auto-replays',
    () async {
      var posts = 0;
      Json? saved;
      final value = await fixture((request) async {
        if (request.method == 'POST') {
          posts++;
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          final body = jsonDecode(request.body) as Json;
          expect(body.keys.toSet(), {
            'requestId',
            'expectedPrimaryRevision',
            'content',
          });
          expect(body['content'], source);
          expect(body['expectedPrimaryRevision'], primary['revision']);
          saved = receipt(body);
          return jsonResponse(saved!, status: 202);
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(bootstrap());
        }
        if (request.url.path.endsWith('/memory-imports')) {
          return jsonResponse(importReady);
        }
        return jsonResponse({...saved!, 'status': 'completed'});
      });
      var model = MemoryImportController(value.scope);
      await model.initialize();
      expect(model.canSubmit, true);
      expect(await model.submit(source), true);
      expect(value.secrets.values.values.single.contains(source), false);
      expect(model.receipt?['status'], 'queued');
      model.dispose();
      model = MemoryImportController(value.scope);
      await model.initialize();
      expect(model.receipt?['status'], 'completed');
      expect(await model.submit(source), false);
      expect(posts, 1);
      expect(await model.acknowledge(), true);
      expect(value.secrets.values, isEmpty);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'an unknown POST and GET 404 stay unresolved until explicit local abandonment',
    () async {
      var posts = 0;
      final value = await fixture((request) async {
        if (request.method == 'POST') {
          posts++;
          throw http.ClientException('Lost before reply');
        }
        if (request.url.path.endsWith('/memory-imports')) {
          return jsonResponse(importReady);
        }
        return jsonResponse({
          'code': 'MEMORY_IMPORT_NOT_FOUND',
          'error': 'Unknown',
        }, status: 404);
      });
      var model = MemoryImportController(value.scope);
      await model.initialize();
      expect(await model.submit(source), false);
      model.dispose();
      model = MemoryImportController(value.scope);
      await model.initialize();
      expect(model.pending, isNotNull);
      expect(model.receipt, isNull);
      expect(model.checked, true);
      expect(await model.submit(source), false);
      expect(await model.acknowledge(), false);
      expect(await model.acknowledge(abandon: true), true);
      expect(posts, 1);
      expect(value.secrets.values, isEmpty);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'only the explicit server NOT_STARTED code releases a rejected submission',
    () async {
      for (final explicit in [false, true]) {
        final value = await fixture(
          (request) async => request.method == 'POST'
              ? jsonResponse({
                  'code': explicit ? 'MEMORY_IMPORT_NOT_STARTED' : 'CONFLICT',
                  'error': 'Rejected',
                }, status: 409)
              : jsonResponse(importReady),
        );
        final model = MemoryImportController(value.scope);
        await model.initialize();
        expect(await model.submit(source), false);
        expect(model.pending == null, explicit);
        expect(value.secrets.values.isEmpty, explicit);
        model.dispose();
        value.scope.dispose();
        value.session.dispose();
      }
    },
  );

  test(
    'a wrong receipt tuple and failed GET never unlock a pending source',
    () async {
      final value = await fixture((request) async {
        if (request.method == 'POST') {
          return jsonResponse({
            ...receipt(jsonDecode(request.body) as Json),
            'conversationId': 'other-chat',
          });
        }
        if (request.url.path.endsWith('/memory-imports')) {
          return jsonResponse(importReady);
        }
        throw http.ClientException('Synthetic disconnected read');
      });
      final model = MemoryImportController(value.scope);
      await model.initialize();
      expect(await model.submit(source), false);
      expect(model.receipt, isNull);
      await model.refresh();
      expect(model.checked, false);
      expect(await model.acknowledge(abandon: true), false);
      expect(model.pending, isNotNull);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'cross-mounted imports dispatch once and late account replies are fenced',
    () async {
      var posts = 0;
      final reply = Completer<http.Response>(), sent = Completer<void>();
      Json? body;
      final value = await fixture((request) async {
        if (request.method == 'POST') {
          posts++;
          body = jsonDecode(request.body) as Json;
          sent.complete();
          return reply.future;
        }
        return jsonResponse(importReady);
      });
      final first = MemoryImportController(value.scope),
          second = MemoryImportController(value.scope);
      await first.initialize();
      await second.initialize();
      final submitted = first.submit(source);
      await sent.future;
      expect(await second.submit(source), false);
      expect(second.pending?['requestId'], body?['requestId']);
      value.session.user = {'id': 'user-b'};
      reply.complete(jsonResponse(receipt(body!)));
      expect(await submitted, false);
      expect(first.receipt, isNull);
      expect(posts, 1);
      first.dispose();
      second.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'member, team and unreadable storage cannot start import work',
    () async {
      var posts = 0;
      final value = await fixture((request) async {
        if (request.method == 'POST') posts++;
        return jsonResponse(importReady);
      });
      final model = MemoryImportController(value.scope);
      await model.initialize();
      value.session.workspaces.first['role'] = 'member';
      expect(await model.submit(source), false);
      value.session.workspaces.first['role'] = 'owner';
      value.session.workspaces.first['kind'] = 'team';
      expect(await model.submit(source), false);
      value.session.workspaces.first['kind'] = 'personal';
      value.secrets.rejectWrites = true;
      expect(await model.submit(source), false);
      expect(posts, 0);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );
}
