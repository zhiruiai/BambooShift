import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'attachment_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

String composerText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

Future<void> waitForComposer(WidgetTester tester) => waitFor(
  tester,
  () => tester.widget<TextField>(find.byType(TextField)).enabled == true,
);

void main() {
  testWidgets(
    'switching and reopening conversations preserves separate drafts',
    (tester) async {
      final server = AttachmentServer();
      final value = await fixture(server.handle);
      await tester.runAsync(value.scope.refresh);
      final chats = value.scope.items('conversations');
      value.scope.data!['conversations'] = [
        ...chats,
        {...chats.single, 'id': 'chat-b', 'title': 'Other conversation'},
      ];

      Future<void> open(String id) async {
        await tester.pumpWidget(
          testApp(ChatScreen(scope: value.scope, conversationId: id)),
        );
        await waitForComposer(tester);
      }

      await open('chat-a');
      await tester.enterText(find.byType(TextField), 'Draft A');
      await open('chat-b');
      expect(composerText(tester), isEmpty);
      await tester.enterText(find.byType(TextField), 'Draft B');
      await tester.pumpWidget(const SizedBox.shrink());
      await open('chat-a');
      expect(composerText(tester), 'Draft A');
      await open('chat-b');
      expect(composerText(tester), 'Draft B');
      expect(value.secrets.values.values, isNot(contains('Draft A')));
      expect(value.secrets.values.values, isNot(contains('Draft B')));

      await tester.pumpWidget(const SizedBox.shrink());
      value.scope.dispose();
      value.session.dispose();
    },
  );

  testWidgets(
    'reopening a chat clears an acknowledged draft without resending',
    (tester) async {
      final server = AttachmentServer();
      final value = await fixture((request) async {
        final response = await server.handle(request);
        if (request.method == 'POST' &&
            request.url.path.endsWith('/messages')) {
          throw http.ClientException('Lost reply after acceptance');
        }
        return response;
      });
      await tester.runAsync(value.scope.refresh);
      Widget chat() =>
          testApp(ChatScreen(scope: value.scope, conversationId: 'chat-a'));
      await tester.pumpWidget(chat());
      await waitForComposer(tester);
      await tester.enterText(find.byType(TextField), '  Sent draft  ');
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await waitFor(tester, () => server.messages.isNotEmpty);
      expect(value.scope.chatDraft('chat-a'), '  Sent draft  ');

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(chat());
      await waitForComposer(tester);
      expect(composerText(tester), isEmpty);
      expect(value.scope.chatDraft('chat-a'), isEmpty);
      expect(
        server.requests.where((request) => request.method == 'POST'),
        hasLength(1),
      );

      await tester.pumpWidget(const SizedBox.shrink());
      value.scope.dispose();
      value.session.dispose();
    },
  );
}
