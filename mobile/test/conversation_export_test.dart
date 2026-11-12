import 'dart:async';
import 'dart:convert';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/chat/conversation_export_controller.dart';

import 'file_export_support.dart';
import 'support.dart';

const transcript = {
  'conversationId': 'chat-a',
  'filename': 'conversation-chat-a.md',
  'content': '# Complete\n\nSynthetic conversation\n',
  'messageCount': 503,
  'exportedAt': '2026-11-01T00:00:00Z',
  'complete': true,
};
const origin = Rect.fromLTWH(10, 10, 40, 40);

void main() {
  test(
    'uses full server transcript and rechecks access before native handoff',
    () async {
      final requests = <http.Request>[];
      final f = await fixture((request) async {
        requests.add(request);
        return request.method == 'HEAD'
            ? http.Response('', 204)
            : jsonResponse(transcript);
      });
      final destination = ExportDestination();
      final c = ConversationExportController(f.scope, 'chat-a', destination);
      await c.prepare('zh-CN');
      expect(c.error, isNull);
      expect(c.messageCount, 503);
      await c.export(origin);
      expect(destination.calls, 1);
      expect(utf8.decode(destination.received!.bytes), transcript['content']);
      expect(requests.map((r) => r.method), ['GET', 'HEAD', 'HEAD']);
      expect(requests.first.url.queryParameters['language'], 'zh-CN');
      for (final request in requests) {
        expect(
          request.url.path,
          '/api/workspaces/space-a/conversations/chat-a/export',
        );
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      }
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('partial or mismatched responses cannot be shared', () async {
    for (final patch in [
      {'complete': false},
      {'conversationId': 'other'},
      {'filename': '../secret.md'},
      {'messageCount': -1},
    ]) {
      final f = await fixture(
        (_) async => jsonResponse({...transcript, ...patch}),
      );
      final destination = ExportDestination();
      final c = ConversationExportController(f.scope, 'chat-a', destination);
      await c.prepare('en');
      expect(c.error, 'exportFailed');
      expect(c.canExport, false);
      await c.export(origin);
      expect(destination.calls, 0);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  });
  test(
    'cancel discards a delayed response and never opens a share sheet',
    () async {
      final response = Completer<http.Response>();
      final requested = Completer<void>();
      final f = await fixture((_) {
        requested.complete();
        return response.future;
      });
      final destination = ExportDestination();
      final c = ConversationExportController(f.scope, 'chat-a', destination);
      final pending = c.prepare('en');
      await requested.future;
      c.cancel();
      response.complete(jsonResponse(transcript));
      await pending;
      expect(c.messageCount, isNull);
      expect(c.canExport, false);
      await c.export(origin);
      expect(destination.calls, 0);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'revocation or workspace switch while selecting a destination prevents saving',
    () async {
      for (final switchWorkspace in [false, true]) {
        var revoked = false;
        final f = await fixture(
          (request) async => request.method == 'HEAD'
              ? revoked
                    ? jsonResponse({'code': 'FORBIDDEN'}, status: 403)
                    : http.Response('', 204)
              : jsonResponse(transcript),
        );
        final destination = ExportDestination();
        final c = ConversationExportController(f.scope, 'chat-a', destination);
        await c.prepare('en');
        destination.beforeHandoff = () async {
          if (switchWorkspace) {
            final next = {...f.session.workspaces.first, 'id': 'space-b'};
            f.session.workspaces.add(next);
            f.session.selectWorkspace(next);
          } else {
            revoked = true;
          }
        };
        await c.export(origin);
        expect(destination.calls, 0);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}
