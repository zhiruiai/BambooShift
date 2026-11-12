import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/voice/voice_transport.dart';

import 'attachment_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

class _SupportedVoice extends VoiceTransport {
  @override
  bool get supported => true;
}

String composerText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

Future<void> waitForComposer(WidgetTester tester) => waitFor(
  tester,
  () => tester.widget<TextField>(find.byType(TextField)).enabled == true,
);

void main() {
  testWidgets(
    '320dp group chat keeps its title and composer clear at large text',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const title = 'Release planning team';
      final server = AttachmentServer();
      final snapshot = {
        ...bootstrap(
          agents: [
            {'id': 'bot-a', 'name': 'Reviewer', 'status': 'idle'},
            {'id': 'bot-b', 'name': 'Writer', 'status': 'idle'},
          ],
          messages: [
            {
              'id': 'source',
              'conversationId': 'chat-a',
              'role': 'assistant',
              'content': '[Review guide](https://example.test/review)',
            },
          ],
        ),
        'conversations': [
          {
            'id': 'chat-a',
            'title': title,
            'agentIds': ['bot-a', 'bot-b'],
            'isGroup': true,
          },
        ],
        'settings': {'configured': true},
      };
      final f = await fixture((request) async {
        if (!request.url.path.endsWith('/bootstrap')) {
          return server.handle(request);
        }
        return jsonResponse({
          ...snapshot,
          'messages': [...(snapshot['messages'] as List), ...server.messages],
        });
      });
      f.scope.data = snapshot;
      Widget layout({double keyboardHeight = 0}) => testApp(
        MediaQuery(
          data: MediaQueryData.fromView(tester.view).copyWith(
            textScaler: const TextScaler.linear(1.3),
            viewInsets: EdgeInsets.only(bottom: keyboardHeight),
          ),
          child: ChatScreen(
            scope: f.scope,
            conversationId: 'chat-a',
            voiceTransport: _SupportedVoice(),
          ),
        ),
      );
      await tester.pumpWidget(layout());
      await waitForComposer(tester);
      final text = find.byType(TextField);
      expect(find.bySemanticsLabel(title), findsOneWidget);
      expect(tester.getSize(find.text(title)).width, greaterThan(140));
      expect(tester.getSize(text).width, greaterThan(260));

      await tester.tap(find.byTooltip('Conversation actions'));
      await tester.pumpAndSettle();
      expect(find.text('Computer'), findsOneWidget);
      expect(find.text('Group settings'), findsOneWidget);
      expect(find.text('Refresh'), findsOneWidget);
      await tester.tap(find.text('Conversation library'));
      await tester.pumpAndSettle();
      expect(find.text('Review guide'), findsOneWidget);
      Navigator.of(tester.element(find.text('Conversation library'))).pop();
      await tester.pumpAndSettle();

      final send = find.descendant(
        of: find.byTooltip('Send'),
        matching: find.byType(FilledButton),
      );
      expect(tester.widget<FilledButton>(send).onPressed, isNull);
      await tester.enterText(text, 'Review the release notes.');
      await tester.pumpWidget(layout(keyboardHeight: 350));
      await tester.pump();
      expect(tester.widget<TextField>(text).focusNode!.hasFocus, isTrue);
      expect(tester.getSize(text).width, greaterThan(260));
      expect(tester.getSize(send).shortestSide, greaterThanOrEqualTo(48));
      await tester.tap(send);
      await waitFor(
        tester,
        () => server.messages.isNotEmpty && composerText(tester).isEmpty,
      );
      expect(server.messages.single['content'], 'Review the release notes.');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      f.scope.dispose();
      f.session.dispose();
    },
  );

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
      await tester.pump();
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
