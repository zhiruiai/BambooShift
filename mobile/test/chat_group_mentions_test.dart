import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_controller.dart';
import 'package:openbot_mobile/features/chat/chat_mentions.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'chat_interactions_test.dart' show snapshot;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _bots = ['bot-a', 'bot-b'];

Json _receipt(Json body, Json mentions) => {
  'id': 'received-message',
  'conversationId': 'chat-a',
  'role': 'user',
  'userId': 'user-a',
  'content': body['content'],
  'delivery': {'clientId': body['clientId']},
  'mentions': mentions,
};

void main() {
  test('group receipts bind to the requested mode and explicit ordering', () {
    final explicit = {'agentIds': _bots};
    expect(groupMentionReceiptMatches(explicit, explicit), isTrue);
    expect(
      groupMentionReceiptMatches({
        'agentIds': _bots.reversed.toList(),
      }, explicit),
      isFalse,
    );
    expect(
      groupMentionReceiptMatches({
        'agentIds': _bots,
        'everyone': true,
      }, explicit),
      isFalse,
    );
    expect(
      groupMentionReceiptMatches(
        {'agentIds': _bots, 'everyone': true},
        {'everyone': true},
      ),
      isTrue,
    );
    expect(
      groupMentionReceiptMatches(
        {
          'agentIds': ['bot-a', 'bot-a'],
          'everyone': true,
        },
        {'everyone': true},
      ),
      isFalse,
    );
    expect(
      chatGroupMentionRequest({'agentIds': _bots, 'everyone': true}),
      isNull,
    );
  });

  test(
    'incompatible choices stay hidden and leave their selected app or Bots intact',
    () async {
      final f = await fixture((_) async => jsonResponse(snapshot([])));
      f.scope.data = snapshot([]);
      final all = chatMentions(
        f.scope,
        f.scope.find('conversations', 'chat-a'),
      );
      final app = all.firstWhere((choice) => choice.app != null);
      final first = all.firstWhere((choice) => choice.id == 'bot-a');
      final second = all.firstWhere((choice) => choice.id == 'bot-b');
      final withApp = addChatMention(
        addChatMention(emptyChatOptions, first),
        app,
      );
      expect(
        availableChatMentions(all, withApp).any((choice) => choice.everyone),
        isFalse,
      );
      final retargeted = addChatMention(withApp, second);
      expect(retargeted.agentId, 'bot-b');
      expect(retargeted.app, withApp.app);
      expect(retargeted.mentions, isNull);
      final multi = addChatMention(
        addChatMention(emptyChatOptions, first),
        second,
      );
      expect(
        availableChatMentions(all, multi).any((choice) => choice.app != null),
        isFalse,
      );
      expect(removeChatMention(multi, 'bot-a').agentId, 'bot-b');
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'unknown everyone delivery keeps exact body through restart and retry',
    () async {
      final requests = <Json>[];
      final rows = <Json>[];
      final f = await fixture((request) async {
        if (request.method != 'POST') return jsonResponse(snapshot(rows));
        final body = jsonDecode(request.body) as Json;
        requests.add(body);
        if (requests.length == 1) throw http.ClientException('Lost network');
        final message = _receipt(body, {'agentIds': _bots, 'everyone': true});
        rows.add(message);
        return jsonResponse({'message': message}, status: 202);
      });
      f.scope.data = snapshot(rows);
      var chat = ChatController(f.scope, 'chat-a');
      await chat.initialize();
      expect(
        await chat.send(
          'Group update',
          mentions: const ChatGroupMentions.everyone(),
        ),
        isFalse,
      );
      expect(chat.pending?['mentions'], {'everyone': true});
      chat.dispose();
      chat = ChatController(f.scope, 'chat-a');
      await chat.initialize();
      expect(requests, hasLength(1));
      await chat.retry();
      expect(requests, hasLength(2));
      expect(requests.last, requests.first);
      expect(chat.pending, isNull);
      expect(f.secrets.values, isEmpty);
      chat.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'known roster rejection frees pending intent and preserves the draft',
    () async {
      final f = await fixture(
        (request) async => jsonResponse({
          'error': 'Unavailable',
          'code': 'CHAT_MENTION_UNAVAILABLE',
        }, status: 409),
      );
      final mentions = ChatGroupMentions.bots(_bots);
      f.scope.data = snapshot([]);
      f.scope.saveChatDraft('chat-a', 'A retained draft');
      f.scope.saveChatOptions('chat-a', (
        agentId: null,
        replyId: null,
        app: null,
        mentions: mentions,
      ));
      final chat = ChatController(f.scope, 'chat-a');
      await chat.initialize();
      expect(await chat.send('A retained draft', mentions: mentions), isFalse);
      expect(chat.pending, isNull);
      expect(chat.error, 'chatMentionUnavailable');
      expect(f.scope.chatDraft('chat-a'), 'A retained draft');
      expect(f.scope.chatOptions('chat-a').mentions, mentions);
      chat.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  for (final language in ['en', 'zh']) {
    testWidgets(
      '390px $language group preserves recipients and role-specific text on remount',
      (tester) async {
        tester.view.physicalSize = const Size(390, 760);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final writes = <Json>[];
        final rows = <Json>[];
        final f = await fixture((request) async {
          if (request.method != 'POST') return jsonResponse(snapshot(rows));
          final body = jsonDecode(request.body) as Json;
          writes.add(body);
          final receipt = _receipt(body, body['mentions'] as Json);
          rows.add(receipt);
          return jsonResponse({'message': receipt}, status: 202);
        });
        f.scope.data = snapshot(rows);
        Widget chat() => testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: Locale(language),
        );
        final input = find.byType(TextField);
        bool ready() => tester.widget<TextField>(input).enabled == true;
        String text() => tester.widget<TextField>(input).controller!.text;
        await tester.pumpWidget(chat());
        await waitFor(tester, ready);
        await tester.enterText(input, '@Res');
        await tester.pumpAndSettle();
        await tester.tap(find.text('@Researcher'));
        await tester.pumpAndSettle();
        expect(text(), '@Researcher ');
        await tester.enterText(input, '@Researcher gather sources. @Coo');
        await tester.pumpAndSettle();
        await tester.tap(find.text('@Coordinator'));
        await tester.pumpAndSettle();
        final remove = language == 'en' ? 'Remove recipient' : '移除收件人';
        expect(find.byTooltip(remove), findsNWidgets(2));
        await tester.enterText(input, '${text()}summarize.');
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpWidget(chat());
        await waitFor(tester, ready);
        expect(text(), '@Researcher gather sources. @Coordinator summarize.');
        expect(find.byTooltip(remove), findsNWidgets(2));
        await tester.tap(find.byIcon(Icons.arrow_upward));
        await waitFor(tester, () => writes.isNotEmpty && ready());
        expect(writes.single['mentions'], {
          'agentIds': ['bot-b', 'bot-a'],
        });
        expect(writes.single.containsKey('agentId'), isFalse);
        expect(writes.single.containsKey('appContext'), isFalse);
        expect(
          writes.single['content'],
          '@Researcher gather sources. @Coordinator summarize.',
        );
        expect(find.text('@Researcher  ·  @Coordinator'), findsOneWidget);
        expect(text(), isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets(
    'removing the everyone chip keeps the wording without an active marker',
    (tester) async {
      final f = await fixture((_) async => jsonResponse(snapshot([])));
      f.scope.data = snapshot([]);
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: const Locale('zh'),
        ),
      );
      final input = find.byType(TextField);
      await waitFor(
        tester,
        () => tester.widget<TextField>(input).enabled == true,
      );
      await tester.enterText(input, '@所有');
      await tester.pumpAndSettle();
      await tester.tap(find.text('@所有人'));
      await tester.pumpAndSettle();
      expect(
        f.scope.chatOptions('chat-a').mentions,
        const ChatGroupMentions.everyone(),
      );
      await tester.enterText(input, '@所有人 项目更新');
      await tester.tap(find.byTooltip('移除收件人'));
      await tester.pumpAndSettle();
      expect(f.scope.chatOptions('chat-a'), emptyChatOptions);
      expect(tester.widget<TextField>(input).controller!.text, '所有人 项目更新');
      await tester.pumpWidget(const SizedBox.shrink());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
