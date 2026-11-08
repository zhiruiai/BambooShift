import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/chat/web_research_card.dart';
import 'package:openbot_mobile/features/chat/web_research_data.dart';
import 'package:openbot_mobile/features/roster/roster_conversation.dart';

import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

const _page = 'https://docs.example.com/library';
const _search = 'https://research.example.org/notes?q=current';

Json _message({
  String id = 'report-a',
  String? thread,
  List<String> issues = const ['search_task_limit', 'upstream_rate_limit'],
}) => {
  'id': id,
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'threadRootId': ?thread,
  'kind': 'web_research',
  'role': 'assistant',
  'status': 'done',
  'content': '',
  'metadata': {
    'webResearch': <String, dynamic>{
      'version': 1,
      'provider': 'Exa',
      'searches': 2,
      'cachedSearches': 3,
      'emptySearches': 1,
      'pagesRead': 1,
      'issues': issues,
      'sources': [
        {'title': 'Published manual', 'url': _page, 'kind': 'page'},
        {'title': 'Public source result', 'url': _search, 'kind': 'search'},
      ],
    },
  },
};

Json _details(Json message) => message['metadata']['webResearch'] as Json;

void _narrow(WidgetTester tester, double width) {
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = Size(width, 700);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pump();
  await tester.tap(target);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 350));
}

void main() {
  test(
    'bounded contract keeps cached searches separate and validates public links',
    () {
      final parsed = WebResearch.fromMessage(_message())!;
      expect(parsed.searches, 2);
      expect(parsed.cachedSearches, 3);
      expect(parsed.emptySearches, 1);
      expect(parsed.sources.first.uri, Uri.parse(_page));
      expect(parsed.sources.last.page, isFalse);
      for (final patch in <Json>[
        {'emptySearches': 3},
        {'searches': 10000},
        {'cachedSearches': -1},
        {'pagesRead': 1.5},
        {'provider': 'other'},
        {
          'issues': ['made_up'],
        },
        {
          'sources': List.filled(13, {
            'title': 'X',
            'url': _page,
            'kind': 'page',
          }),
        },
        {
          'sources': List.filled(2, {
            'title': 'X',
            'url': _page,
            'kind': 'page',
          }),
        },
        {
          'sources': [
            {'title': 'X' * 241, 'url': _page, 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {'title': 'X', 'url': 'javascript:alert(1)', 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {
              'title': 'X',
              'url': 'https://user@docs.example.com',
              'kind': 'page',
            },
          ],
        },
        {
          'sources': [
            {'title': 'X', 'url': 'http://127.0.0.1:3001', 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {'title': 'X', 'url': 'http://work.internal/', 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {'title': 'X', 'url': 'http://work.local../', 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {'title': 'X', 'url': 'http://0x7f.0.0.1/', 'kind': 'page'},
          ],
        },
        {
          'sources': [
            {'title': 'Link \u202Etitle', 'url': _page, 'kind': 'page'},
          ],
        },
      ]) {
        final message = _message();
        _details(message).addAll(patch);
        expect(WebResearch.fromMessage(message), isNull);
      }
      expect(WebResearch.fromMessage({..._message(), 'role': 'user'}), isNull);
      expect(
        WebResearch.fromMessage({..._message(), 'status': 'running'}),
        isNull,
      );
    },
  );

  testWidgets(
    '320px blank-content cards appear in their original chat or thread',
    (tester) async {
      _narrow(tester, 320);
      final root = {
        'id': 'thread-root',
        'role': 'user',
        'userId': 'user-a',
        'conversationId': 'chat-a',
        'content': 'Discuss one source',
      };
      final data = teamSnapshot(
        messages: [
          root,
          _message(id: 'root-report', issues: const ['search_retry_limit']),
          _message(
            id: 'thread-report',
            thread: 'thread-root',
            issues: const ['fetch_task_limit'],
          ),
        ],
      );
      final f = await fixture((_) async => jsonResponse(data));
      f.scope.data = data;
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(WebResearchCard), findsOneWidget);
      expect(find.text('公开网页检索'), findsOneWidget);
      expect(find.textContaining('重复搜索次数已达上限'), findsOneWidget);
      expect(find.textContaining('本次任务的网页读取次数已达上限'), findsNothing);
      await _tap(tester, find.text('公开网页检索'));
      expect(find.text('来源'), findsOneWidget);
      expect(find.text('Published manual'), findsOneWidget);
      expect(find.text('已读网页 · docs.example.com'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: f.scope,
            conversationId: 'chat-a',
            threadRootId: 'thread-root',
          ),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(WebResearchCard), findsOneWidget);
      expect(find.textContaining('本次任务的网页读取次数已达上限'), findsOneWidget);
      expect(find.textContaining('重复搜索次数已达上限'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'research records do not replace roster previews or count as replies',
    (tester) async {
      _narrow(tester, 320);
      final rows = <Json>[
        {
          'id': 'bot-reply',
          'role': 'assistant',
          'conversationId': 'chat-a',
          'threadRootId': 'thread-root',
          'content': 'The actual Bot reply',
        },
        _message(thread: 'thread-root'),
      ];
      expect(chatThreadCounts(rows, 'chat-a'), {'thread-root': 1});
      final data = teamSnapshot(messages: rows);
      final f = await fixture((_) async => jsonResponse(data));
      f.scope.data = data;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: RosterConversation(
              scope: f.scope,
              conversation: f.scope.find('conversations', 'chat-a')!,
            ),
          ),
        ),
      );
      expect(find.text('The actual Bot reply'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    '390px source only opens on a tap for a current research message',
    (tester) async {
      _narrow(tester, 390);
      final card = _message();
      final opened = <Uri>[];
      var requests = 0;
      final f = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      f.scope.data = teamSnapshot(messages: [card]);
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ListView(
              children: [
                WebResearchCard(
                  scope: f.scope,
                  message: card,
                  research: WebResearch.fromMessage(card)!,
                  launcher: (uri) async {
                    opened.add(uri);
                    return true;
                  },
                ),
              ],
            ),
          ),
        ),
      );
      expect(find.text('Public web research'), findsOneWidget);
      expect(
        find.textContaining(
          'Exa · Searches 2 · Cached 3 · No results 1 · Pages read 1',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('Search limit for this task reached'),
        findsOneWidget,
      );
      expect(find.text('Published manual'), findsNothing);
      expect(opened, isEmpty);
      await _tap(tester, find.text('Public web research'));
      expect(find.text('Search provider rate limited'), findsOneWidget);
      expect(find.text('Search result · research.example.org'), findsOneWidget);
      expect(opened, isEmpty);
      await _tap(tester, find.text('Published manual'));
      expect(opened, [Uri.parse(_page)]);
      f.scope.data = teamSnapshot(messages: [_message(thread: 'other-thread')]);
      await _tap(tester, find.text('Public source result'));
      expect(opened, [Uri.parse(_page)]);
      expect(requests, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
