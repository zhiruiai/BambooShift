import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_mentions.dart';
import 'package:openbot_mobile/features/chat/chat_message_controls.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const group = {
  'id': 'chat-a',
  'title': 'Launch group',
  'agentIds': ['bot-a', 'bot-b'],
  'isGroup': true,
};
const original = {
  'id': 'message-a',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'agentId': 'bot-a',
  'content': 'The earlier result',
};
const connection = {
  'id': 'app-a',
  'revision': 'revision-a',
  'name': 'Notion',
  'status': 'connected',
  'toolCount': 2,
};

Json snapshot(List<Json> messages) => {
  ...bootstrap(
    messages: messages,
    agents: [
      {'id': 'bot-a', 'name': 'Coordinator'},
      {'id': 'bot-b', 'name': 'Researcher'},
    ],
  ),
  'conversations': [group],
  'settings': {'configured': true},
  'apps': [
    connection,
    {
      ...connection,
      'id': 'app-b',
      'name': 'Disconnected',
      'status': 'needs_auth',
    },
  ],
};

void main() {
  test(
    'mention tokens ignore email addresses, active IME composition and selections',
    () {
      TextEditingValue value(
        String text, {
        TextRange composing = TextRange.empty,
      }) => TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
        composing: composing,
      );
      expect(chatMentionToken(value('me@openbot.dev')), isNull);
      expect(
        chatMentionToken(
          value('请给 @研', composing: const TextRange(start: 5, end: 6)),
        ),
        isNull,
      );
      expect(chatMentionToken(value('请给 @研'))?.query, '研');
      expect(chatMentionToken(value('Ask @No'))?.query, 'no');
      expect(
        chatMentionToken(
          const TextEditingValue(
            text: '@Bot',
            selection: TextSelection(baseOffset: 0, extentOffset: 4),
          ),
        ),
        isNull,
      );
    },
  );

  testWidgets(
    'group quote, explicit Bot and app are carried in a single send',
    (tester) async {
      tester.view.physicalSize = const Size(360, 760);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final rows = <Json>[original];
      final writes = <Json>[];
      final f = await fixture((request) async {
        if (request.method != 'POST') return jsonResponse(snapshot(rows));
        final body = jsonDecode(request.body) as Json;
        writes.add(body);
        final message = <String, dynamic>{
          'id': 'message-b',
          'conversationId': 'chat-a',
          'role': 'user',
          'userId': 'user-a',
          'content': body['content'],
          'replyTo': {
            'id': body['replyToMessageId'],
            'author': 'Coordinator',
            'content': original['content'],
          },
          'delivery': {
            'clientId': body['clientId'],
            'explicitAgentId': body['agentId'],
          },
          'appContext': {...body['appContext'] as Json, 'name': 'Notion'},
        };
        rows.add(message);
        return jsonResponse({'message': message}, status: 202);
      });
      f.scope.data = snapshot(rows);
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
      );
      await waitFor(
        tester,
        () => tester.widget<TextField>(find.byType(TextField)).enabled == true,
      );
      await tester.tap(find.byTooltip('Message actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reply'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Remove reply'), findsOneWidget);

      await tester.tap(find.byTooltip('Mention a Bot or an app'));
      await tester.pumpAndSettle();
      expect(find.text('Disconnected'), findsNothing);
      await tester.tap(find.text('@Researcher'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Remove recipient'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Please check @Not');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Notion'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Remove app'), findsOneWidget);
      expect(writes, isEmpty);
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await waitFor(
        tester,
        () =>
            writes.isNotEmpty &&
            find.byIcon(Icons.arrow_upward).evaluate().isNotEmpty,
      );
      expect(writes.single['content'], 'Please check');
      expect(writes.single['agentId'], 'bot-b');
      expect(writes.single['replyToMessageId'], 'message-a');
      expect(writes.single['appContext'], {
        'connectionId': 'app-a',
        'revision': 'revision-a',
      });
      expect(find.byTooltip('Remove app'), findsNothing);
      expect(find.textContaining('App · Notion'), findsOneWidget);
      final quote = find.byWidgetPredicate(
        (widget) => widget is ChatQuote && widget.title == 'Coordinator',
      );
      expect(quote, findsOneWidget);
      await tester.tap(quote);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('focused-chat-message')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'reaction controls update only the current actor with explicit state',
    (tester) async {
      final row = <String, dynamic>{
        ...original,
        'reactions': ['👍'],
        'reactionMembers': {
          '👍': ['other-user'],
        },
      };
      final operations = <Json>[];
      final f = await fixture((request) async {
        if (request.method != 'POST') return jsonResponse(snapshot([row]));
        expect(
          request.url.path,
          '/api/workspaces/space-a/messages/message-a/reactions',
        );
        final body = jsonDecode(request.body) as Json;
        operations.add(body);
        row['reactionMembers'] = {
          '👍': ['other-user', if (body['active'] == true) 'user-a'],
        };
        return jsonResponse(row);
      });
      f.scope.data = snapshot([row]);
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('👍 1'));
      await waitFor(tester, () => find.text('👍 2').evaluate().isNotEmpty);
      await tester.tap(find.text('👍 2'));
      await waitFor(
        tester,
        () => find.text('👍 1').evaluate().isNotEmpty && operations.length == 2,
      );
      expect(operations, [
        {'emoji': '👍', 'active': true},
        {'emoji': '👍', 'active': false},
      ]);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'a stale app rejection lets the user repair the draft without changing an unknown send',
    () async {
      var calls = 0;
      final f = await fixture((request) async {
        calls++;
        return jsonResponse({
          'code': 'APP_CONTEXT_UNAVAILABLE',
          'error': 'Unavailable',
        }, status: 409);
      });
      final chat = ChatController(f.scope, 'chat-a');
      await chat.initialize();
      expect(
        await chat.send(
          'Keep this draft',
          app: (connectionId: 'app-a', revision: 'revision-a'),
        ),
        false,
      );
      expect(chat.pending, isNull);
      expect(chat.error, 'chatAppChanged');
      expect(f.secrets.values, isEmpty);
      expect(calls, 1);
      chat.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
