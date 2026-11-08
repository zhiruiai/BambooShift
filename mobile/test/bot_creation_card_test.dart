import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/widgets/common.dart';

import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

Json _draft() => {
  'id': 'bot-draft',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'status': 'done',
  'kind': 'creation_preview',
  'metadata': {
    'requesterUserId': 'user-a',
    'inputMessageId': 'input-a',
    'runId': 'run-a',
    'creationPreview': {
      'kind': 'bot',
      'profile': {
        'name': 'Archive reviewer',
        'role': 'Records',
        'description': 'Summarize public notes.',
        'instructions': 'Cite the source of each finding.',
        'avatar': 'leaf',
        'color': '#76568d',
        'avatarImageId': null,
      },
    },
  },
};

Future<void> _advanceUntil(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready(), isTrue);
}

void main() {
  testWidgets('chat Bot draft reviews the original run before explicit save', (
    tester,
  ) async {
    final message = _draft();
    final original = teamSnapshot(messages: [message, proposalInput()]);
    final posts = <Json>[];
    final createdAgent = {...profile('new-bot'), 'name': 'Edited reviewer'};
    final newChat = {
      'id': 'new-chat',
      'title': 'Edited reviewer',
      'isGroup': false,
      'agentIds': ['new-bot'],
    };
    var checkedAccount = 0;
    final f = await fixture((request) async {
      if (request.url.path.endsWith('/account/session')) {
        checkedAccount++;
        return jsonResponse(account());
      }
      if (request.url.path.endsWith('/bootstrap')) {
        return jsonResponse({
          ...original,
          if (posts.isNotEmpty) ...{
            'agents': [...original['agents'] as List, createdAgent],
            'conversations': [...original['conversations'] as List, newChat],
          },
        });
      }
      if (request.method == 'POST' &&
          request.url.path.endsWith('/creation-requests')) {
        final body = jsonDecode(request.body) as Json;
        posts.add(body);
        return jsonResponse({
          'requestId': body['requestId'],
          'kind': 'bot',
          'status': 'created',
          'workspaceId': 'space-a',
          'userId': 'user-a',
          'conversationId': 'new-chat',
          'agentIds': ['new-bot'],
          'agents': [createdAgent],
          'conversation': newChat,
        });
      }
      return jsonResponse({'messages': []});
    });
    f.scope.data = original;
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ChatMessage(scope: f.scope, message: message),
        ),
      ),
    );
    expect(find.text('New Bot draft'), findsOneWidget);
    await tester.tap(find.text('Review and edit'));
    await _advanceUntil(
      tester,
      () => find.byType(CreateScreen).evaluate().isNotEmpty,
    );
    await tester.pump(const Duration(milliseconds: 450));
    expect(checkedAccount, 1);
    expect(posts, isEmpty);
    final name = find.widgetWithText(TextFormField, 'Archive reviewer');
    expect(name, findsOneWidget);
    await tester.enterText(name, 'Edited reviewer');
    final create = find.widgetWithText(FilledButton, 'Create');
    await tester.scrollUntilVisible(
      create,
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(create);
    await _advanceUntil(
      tester,
      () => find.byType(ChatScreen).evaluate().isNotEmpty,
    );
    expect(posts, hasLength(1));
    expect(posts.single['profile']['name'], 'Edited reviewer');
    expect(
      posts.single['profile']['instructions'],
      'Cite the source of each finding.',
    );
    expect(
      tester.widget<ChatScreen>(find.byType(ChatScreen)).conversationId,
      'new-chat',
    );
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'a draft tied to a different reply thread cannot open an editor',
    (tester) async {
      final message = {..._draft(), 'threadRootId': 'thread-a'};
      final stale = teamSnapshot(
        messages: [
          message,
          {...proposalInput(), 'threadRootId': 'thread-b'},
        ],
      );
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') writes++;
        return jsonResponse(
          request.url.path.endsWith('/account/session') ? account() : stale,
        );
      });
      f.scope.data = stale;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ChatMessage(scope: f.scope, message: message),
          ),
          locale: const Locale('zh'),
        ),
      );
      expect(find.text('新 Bot 草稿'), findsOneWidget);
      await tester.tap(find.text('核对并编辑'));
      await _advanceUntil(
        tester,
        () => find.byType(Notice).evaluate().isNotEmpty,
      );
      expect(find.byType(CreateScreen), findsNothing);
      expect(writes, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
