import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'chat_interactions_test.dart' show original, snapshot;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  testWidgets(
    'phone opens a thread, keeps the main draft and sends to the root',
    (tester) async {
      tester.view.physicalSize = const Size(390, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final rows = <Json>[
        original,
        {
          'id': 'thread-child',
          'conversationId': 'chat-a',
          'role': 'assistant',
          'agentId': 'bot-a',
          'content': 'Thread result only',
          'threadRootId': 'message-a',
        },
      ];
      final posts = <Json>[];
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(snapshot(rows));
        if (!request.url.path.endsWith('/messages')) {
          return jsonResponse({'ok': true});
        }
        final body = jsonDecode(request.body) as Json;
        posts.add(body);
        final receipt = <String, dynamic>{
          'id': 'thread-submitted',
          'conversationId': 'chat-a',
          'role': 'user',
          'userId': 'user-a',
          'content': body['content'],
          'threadRootId': body['threadRootId'],
          'replyTo': {'id': body['replyToMessageId']},
          'delivery': {'clientId': body['clientId']},
        };
        rows.add(receipt);
        return jsonResponse({'message': receipt}, status: 202);
      });
      f.scope.data = snapshot(rows);
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
      );
      final field = find.byType(TextField);
      await waitFor(
        tester,
        () => tester.widget<TextField>(field).enabled == true,
      );
      expect(find.text('Thread result only'), findsNothing);
      await tester.enterText(field, 'Keep main draft');
      await tester.tap(find.text('Thread · 1'));
      await tester.pumpAndSettle();
      expect(find.text('Thread result only'), findsOneWidget);
      expect(find.text('The earlier result'), findsOneWidget);
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      await tester.enterText(field, 'Keep thread draft');
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(field).controller!.text,
        'Keep main draft',
      );
      expect(find.text('Thread result only'), findsNothing);
      await tester.tap(find.text('Thread · 1'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(field).controller!.text,
        'Keep thread draft',
      );
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await waitFor(
        tester,
        () =>
            posts.length == 1 &&
            tester.widget<TextField>(field).controller!.text.isEmpty,
      );
      expect(posts.single['threadRootId'], 'message-a');
      expect(posts.single['replyToMessageId'], 'message-a');
      expect(posts.single['content'], 'Keep thread draft');
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('Thread · 2'), findsOneWidget);
      expect(
        tester.widget<TextField>(field).controller!.text,
        'Keep main draft',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test('uncertain thread send recovers only in the same thread', () async {
    final requests = <Json>[];
    final f = await fixture((request) async {
      if (request.method == 'GET') return jsonResponse(snapshot([original]));
      requests.add(jsonDecode(request.body) as Json);
      return jsonResponse({'error': 'Try again'}, status: 503);
    });
    var thread = ChatController(f.scope, 'chat-a', threadRootId: 'message-a');
    await thread.initialize();
    expect(await thread.send('Persist original request'), isFalse);
    final pending = thread.pending;
    expect(pending?['threadRootId'], 'message-a');
    thread.dispose();
    final main = ChatController(f.scope, 'chat-a');
    await main.initialize();
    expect(main.pending, isNull);
    thread = ChatController(f.scope, 'chat-a', threadRootId: 'message-a');
    await thread.initialize();
    expect(thread.pending, pending);
    await thread.retry();
    expect(requests, [pending, pending]);
    thread.dispose();
    main.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
