import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/attachment_controller.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';

import 'attachment_support.dart';
import 'support.dart';

void main() {
  test(
    'restart accepts original message and clears references without another send or upload',
    () async {
      final server = AttachmentServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'POST' && r.url.path.endsWith('/messages')) {
          throw http.ClientException('Lost message response');
        }
        return response;
      });
      var attachments = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      var chat = ChatController(
        f.scope,
        'chat-a',
        onAccepted: (content) => attachments.acknowledgeSent(content),
      );
      await attachments.initialize();
      await chat.initialize();
      await attachments.choose();
      await attachments.upload();
      expect(await chat.send(attachments.compose('Review document')), false);
      expect(chat.pending, isNotNull);
      expect(attachments.files.length, 1);
      chat.dispose();
      attachments.dispose();
      attachments = AttachmentController(f.scope, 'chat-a');
      chat = ChatController(
        f.scope,
        'chat-a',
        onAccepted: (content) => attachments.acknowledgeSent(content),
      );
      await attachments.initialize();
      await chat.initialize();
      expect(chat.pending, isNull);
      expect(attachments.files, isEmpty);
      expect(
        server.requests
            .where(
              (r) => r.method == 'POST' && r.url.path.endsWith('/messages'),
            )
            .length,
        1,
      );
      expect(
        server.requests
            .where((r) => r.method == 'POST' && r.url.path.endsWith('/files'))
            .length,
        1,
      );
      chat.dispose();
      attachments.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'presentation callback failures do not turn an accepted message into a retry',
    () async {
      final server = AttachmentServer();
      final f = await fixture(server.handle);
      var calls = 0;
      final chat = ChatController(
        f.scope,
        'chat-a',
        onAccepted: (_) async {
          calls++;
          throw StateError('Local presentation failure');
        },
      );
      await chat.initialize();
      expect(await chat.send('Accepted message'), true);
      expect(chat.pending, isNull);
      expect(calls, 1);
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
      chat.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'a mismatched returned actor cannot invoke the accepted callback',
    () async {
      var calls = 0;
      final f = await fixture((r) async {
        final body = jsonDecode(r.body) as Json;
        return jsonResponse({
          'message': {
            'id': 'wrong',
            'conversationId': 'chat-a',
            'role': 'user',
            'userId': 'other',
            'delivery': {'clientId': body['clientId']},
          },
        });
      });
      final chat = ChatController(
        f.scope,
        'chat-a',
        onAccepted: (_) async {
          calls++;
        },
      );
      await chat.initialize();
      expect(await chat.send('Do not clear'), false);
      expect(chat.pending, isNotNull);
      expect(calls, 0);
      chat.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
