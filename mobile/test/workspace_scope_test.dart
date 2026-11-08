import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';

import 'support.dart';

void main() {
  test(
    'a confirmed creation opens without waiting for another bootstrap and fences older reads',
    () async {
      final late = Completer<http.Response>();
      final f = await fixture((_) => late.future);
      final reading = f.scope.refresh();
      await Future<void>.delayed(Duration.zero);
      f.scope.acceptCreation({
        'status': 'created',
        'userId': 'user-a',
        'workspaceId': 'space-a',
        'conversationId': 'new-chat',
        'conversation': {
          'id': 'new-chat',
          'isGroup': false,
          'agentIds': ['new-bot'],
        },
        'agents': [
          {'id': 'new-bot', 'name': 'Created'},
        ],
      });
      late.complete(jsonResponse(bootstrap()));
      await reading;
      expect(f.scope.find('conversations', 'new-chat'), isNotNull);
      expect(f.scope.find('agents', 'new-bot')?['name'], 'Created');
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('a slower bootstrap cannot replace a newer response', () async {
    final first = Completer<http.Response>();
    var calls = 0;
    final f = await fixture((_) async {
      calls++;
      if (calls == 1) return first.future;
      return jsonResponse({
        ...bootstrap(),
        'sync': {'epoch': 'epoch', 'revision': 3},
        'agents': [
          {'id': 'new', 'name': 'Latest'},
        ],
      });
    });
    final old = f.scope.refresh();
    await Future<void>.delayed(Duration.zero);
    await f.scope.refresh();
    first.complete(
      jsonResponse({
        ...bootstrap(),
        'sync': {'epoch': 'epoch', 'revision': 2},
        'agents': [
          {'id': 'old', 'name': 'Stale'},
        ],
      }),
    );
    await old;
    expect(f.scope.items('agents').single['id'], 'new');
    f.scope.dispose();
    f.session.dispose();
  });
  test(
    'late old-workspace data cannot populate a newly selected workspace',
    () async {
      final pending = Completer<http.Response>();
      final f = await fixture((_) => pending.future);
      final reading = f.scope.refresh();
      await Future<void>.delayed(Duration.zero);
      f.session.workspaces.add({
        'id': 'space-b',
        'name': 'Team',
        'kind': 'team',
        'role': 'member',
        'status': 'active',
      });
      f.session.selectWorkspace(f.session.workspaces.last);
      pending.complete(
        jsonResponse({
          ...bootstrap(),
          'agents': [
            {'id': 'private', 'name': 'Private'},
          ],
        }),
      );
      await reading;
      expect(f.scope.active, isFalse);
      expect(f.scope.items('agents'), isEmpty);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'workspace mutations always use the captured ExpectedUser and path',
    () async {
      String? path;
      String? actor;
      final f = await fixture((request) async {
        path = request.url.path;
        actor = request.headers['X-OpenBot-Expected-User'];
        return jsonResponse({'ok': true});
      });
      await f.scope.request('POST', '/conversations/chat-a/stop');
      expect(path, '/api/workspaces/space-a/conversations/chat-a/stop');
      expect(actor, 'user-a');
      f.session.user = {'id': 'user-b'};
      await expectLater(
        f.scope.request('POST', '/conversations/chat-a/stop'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SCOPE'),
        ),
      );
      expect(actor, 'user-a');
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
