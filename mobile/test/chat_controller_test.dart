import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';

import 'support.dart';

void main() {
  test(
    'closing the composer during secure persistence prevents later dispatch',
    () async {
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      final controller = ChatController(f.scope, 'chat-a');
      await controller.initialize();
      final barrier = Completer<void>();
      final held = f.session.api.vault.serial(() => barrier.future);
      final send = controller.send('Do not dispatch after close');
      controller.dispose();
      barrier.complete();
      await held;
      await send;
      expect(calls, 0);
      expect(f.secrets.values, isEmpty);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'unknown send is recovered by its real message, never resubmitted on remount',
    () async {
      final sent = <Json>[];
      final messages = <Json>[];
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          final body = jsonDecode(request.body) as Json;
          sent.add(body);
          messages.add({
            'id': 'message-a',
            'conversationId': 'chat-a',
            'userId': 'user-a',
            'role': 'user',
            'content': body['content'],
            'delivery': {'clientId': body['clientId']},
          });
          throw http.ClientException('Synthetic lost response');
        }
        return jsonResponse(bootstrap(messages: messages));
      });
      var controller = ChatController(f.scope, 'chat-a');
      await controller.initialize();
      expect(await controller.send('A real draft'), isFalse);
      expect(controller.pending, isNotNull);
      expect(sent, hasLength(1));
      controller.dispose();
      controller = ChatController(f.scope, 'chat-a');
      await controller.initialize();
      expect(controller.pending, isNull);
      expect(sent, hasLength(1));
      expect(f.secrets.values, isEmpty);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'retry preserves the exact request and explicit Bot after rejection',
    () async {
      final sent = <Json>[];
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          final body = jsonDecode(request.body) as Json;
          sent.add(body);
          if (sent.length == 1) {
            return jsonResponse({
              'error': 'Busy',
              'code': 'CONFLICT',
            }, status: 409);
          }
          return jsonResponse({
            'message': {
              'id': 'm',
              'conversationId': 'chat-a',
              'userId': 'user-a',
              'role': 'user',
              'delivery': {
                'clientId': body['clientId'],
                'explicitAgentId': body['agentId'],
              },
            },
          });
        }
        return jsonResponse(bootstrap());
      });
      final controller = ChatController(f.scope, 'chat-a');
      await controller.initialize();
      await controller.send('Hello', agentId: 'bot-a');
      await controller.retry();
      expect(sent, hasLength(2));
      expect(sent[1], sent[0]);
      expect(controller.pending, isNull);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('secure storage failure prevents dispatch, including retry', () async {
    var posts = 0;
    final f = await fixture((_) async {
      posts++;
      return jsonResponse({});
    });
    final controller = ChatController(f.scope, 'chat-a');
    await controller.initialize();
    f.secrets.rejectWrites = true;
    await controller.send('Private draft');
    await controller.retry();
    expect(posts, 0);
    expect(controller.pending, isNotNull);
    controller.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
  test(
    'late send response cannot update a different account or erase its pending intent',
    () async {
      final response = Completer<http.Response>();
      Json? body;
      final f = await fixture((request) {
        body = jsonDecode(request.body) as Json;
        return response.future;
      });
      final controller = ChatController(f.scope, 'chat-a');
      await controller.initialize();
      final sending = controller.send('Original actor');
      await Future<void>.delayed(Duration.zero);
      f.session.user = {'id': 'user-b'};
      response.complete(
        jsonResponse({
          'message': {
            'id': 'm',
            'conversationId': 'chat-a',
            'userId': 'user-a',
            'role': 'user',
            'delivery': {'clientId': body!['clientId']},
          },
        }),
      );
      expect(await sending, isFalse);
      expect(controller.pending, isNotNull);
      expect(f.secrets.values, hasLength(1));
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
