import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'chat_drafts_widgets_test.dart' show composerText, waitForComposer;
import 'support.dart';
import 'widgets_test.dart' show testApp;

const approved = {
  'id': 'approved-v2',
  'agentId': 'bot-a',
  'name': 'Release review',
  'version': 2,
  'status': 'active',
  'content': 'Follow the approved release review instructions.',
};

class _SkillServer {
  bool revoked = false;
  bool wrongReceipt = false;
  final posts = <Json>[];
  final messages = <Json>[];

  Json get snapshot => {
    ...bootstrap(
      agents: [
        {'id': 'bot-a', 'name': 'Release reviewer'},
        {
          'id': 'bot-shared',
          'name': 'Managed alias',
          'sharedBot': {'status': 'active'},
        },
        {'id': 'bot-outside', 'name': 'Outside this chat'},
      ],
      messages: messages,
    ),
    'settings': {'configured': true},
    'skills': [
      {...approved, if (revoked) 'status': 'paused'},
      {
        ...approved,
        'id': 'proposed',
        'name': 'Unapproved',
        'status': 'proposed',
      },
      {
        ...approved,
        'id': 'managed',
        'agentId': 'bot-shared',
        'name': 'Alias skill',
      },
      {
        ...approved,
        'id': 'outside',
        'agentId': 'bot-outside',
        'name': 'Other chat skill',
      },
    ],
  };

  Future<http.Response> handle(http.Request request) async {
    if (request.method != 'POST' ||
        !request.url.path.endsWith('/conversations/chat-a/messages')) {
      return jsonResponse(snapshot);
    }
    final body = jsonDecode(request.body) as Json;
    posts.add(body);
    if (revoked) {
      return jsonResponse({
        'error': 'Unavailable',
        'code': 'SKILL_CONTEXT_UNAVAILABLE',
      }, status: 409);
    }
    final message = {
      'id': 'sent',
      'conversationId': 'chat-a',
      'role': 'user',
      'userId': 'user-a',
      'content': body['content'],
      'skillId': wrongReceipt ? 'other-skill' : body['skillId'],
      'delivery': {
        'clientId': body['clientId'],
        'explicitAgentId': body['agentId'],
      },
    };
    if (!wrongReceipt) messages.add(message);
    return jsonResponse({'message': message}, status: 202);
  }
}

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      '320dp $language selection sends the active skill and preserves the draft before Send',
      (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final server = _SkillServer();
        final account = await fixture(server.handle);
        account.scope.data = server.snapshot;
        final label = language == 'en' ? 'Use skill' : '使用技能';
        final prompt = language == 'en'
            ? 'Describe what to do with this skill'
            : '输入要用这个技能处理的任务';
        Widget chat() => testApp(
          ChatScreen(scope: account.scope, conversationId: 'chat-a'),
          locale: Locale(language),
        );
        await tester.pumpWidget(chat());
        await waitForComposer(tester);
        await tester.enterText(find.byType(TextField), 'Review my draft');
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(find.text('Release review'), findsOneWidget);
        expect(find.text('Release reviewer · v2'), findsOneWidget);
        for (final unavailable in [
          'Unapproved',
          'Alias skill',
          'Other chat skill',
        ]) {
          expect(find.text(unavailable), findsNothing);
        }
        await tester.tap(find.text('Release review'));
        await tester.pumpAndSettle();
        expect(find.text('Release review · v2'), findsOneWidget);
        expect(find.text(prompt), findsOneWidget);
        expect(composerText(tester), 'Review my draft');
        expect(server.posts, isEmpty);
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpWidget(chat());
        await waitForComposer(tester);
        expect(find.text('Release review · v2'), findsOneWidget);
        expect(composerText(tester), 'Review my draft');
        await tester.tap(find.byIcon(Icons.arrow_upward));
        for (var attempt = 0; attempt < 100; attempt++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 5)),
          );
          await tester.pump(const Duration(milliseconds: 10));
          if (account.scope.chatDraft('chat-a').isEmpty &&
              composerText(tester).isEmpty) {
            break;
          }
        }
        expect(composerText(tester), isEmpty);
        expect(server.posts, hasLength(1));
        expect(server.posts.single['content'], 'Review my draft');
        expect(server.posts.single['skillId'], approved['id']);
        expect(server.posts.single['agentId'], 'bot-a');
        expect(server.posts.single['mode'], 'followUp');
        expect(account.scope.chatOptions('chat-a'), emptyChatOptions);
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox.shrink());
        account.scope.dispose();
        account.session.dispose();
      },
    );
  }

  testWidgets('a skill revoked while the picker is open cannot be selected', (
    tester,
  ) async {
    final server = _SkillServer();
    final account = await fixture(server.handle);
    account.scope.data = server.snapshot;
    await tester.pumpWidget(
      testApp(ChatScreen(scope: account.scope, conversationId: 'chat-a')),
    );
    await waitForComposer(tester);
    await tester.enterText(find.byType(TextField), 'Keep this draft');
    await tester.tap(find.text('Use skill'));
    await tester.pumpAndSettle();
    server.revoked = true;
    await tester.runAsync(account.scope.refresh);
    await tester.pump();
    await tester.tap(find.text('Release review'));
    await tester.pumpAndSettle();
    expect(account.scope.chatOptions('chat-a'), emptyChatOptions);
    expect(composerText(tester), 'Keep this draft');
    expect(server.posts, isEmpty);
    expect(
      find.text(
        'This skill was updated or disabled. Remove it and choose an approved version.',
      ),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox.shrink());
    account.scope.dispose();
    account.session.dispose();
  });

  test('a mismatched receipt keeps the exact skill through recovery', () async {
    final server = _SkillServer()..wrongReceipt = true;
    final account = await fixture(server.handle);
    account.scope.data = server.snapshot;
    final first = ChatController(account.scope, 'chat-a');
    await first.initialize();
    expect(
      await first.send('Review', agentId: 'bot-a', skillId: 'approved-v2'),
      isFalse,
    );
    expect(first.pending?['skillId'], 'approved-v2');
    expect(first.lastReceipt, isNull);
    first.dispose();

    final second = ChatController(account.scope, 'chat-a');
    await second.initialize();
    expect(server.posts, hasLength(1));
    expect(second.pending?['skillId'], 'approved-v2');
    server.wrongReceipt = false;
    await second.retry();
    expect(server.posts, hasLength(2));
    expect(server.posts.last, server.posts.first);
    expect(second.lastReceipt?['skillId'], 'approved-v2');
    expect(second.pending, isNull);

    server.revoked = true;
    account.scope.saveChatDraft('chat-a', 'Keep a rejected draft');
    expect(
      await second.send(
        'Keep a rejected draft',
        agentId: 'bot-a',
        skillId: 'approved-v2',
      ),
      isFalse,
    );
    expect(second.pending, isNull);
    expect(second.error, 'chatSkillChanged');
    expect(account.scope.chatDraft('chat-a'), 'Keep a rejected draft');
    second.dispose();
    account.scope.dispose();
    account.session.dispose();
  });
}
