import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_library_links.dart';
import 'package:openbot_mobile/features/chat/chat_project_library.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

Json chatLinkMessage(
  String id,
  String label,
  String host, {
  String chat = 'chat-a',
  String? thread,
}) => {
  'id': id,
  'conversationId': chat,
  'role': 'user',
  'content': '[$label](https://$host)',
  'threadRootId': ?thread,
};

void main() {
  testWidgets(
    'Chinese conversation library lists latest link once and opens its original thread',
    (tester) async {
      tester.view.physicalSize = const Size(360, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final requests = <String>[];
      final f = await fixture((request) async {
        requests.add(request.url.path);
        return jsonResponse(bootstrap());
      });
      final root = {
        'id': 'root',
        'conversationId': 'chat-a',
        'role': 'assistant',
        'content': 'Review source material.',
      };
      f.scope.data = bootstrap(
        messages: [
          root,
          chatLinkMessage('old-link', 'Earlier label', 'research.example.test'),
          chatLinkMessage(
            'new-link',
            '最新链接',
            'research.example.test',
            thread: 'root',
          ),
          chatLinkMessage(
            'other-link',
            '另一会话',
            'other.example.test',
            chat: 'chat-b',
          ),
        ],
      );
      await tester.pumpWidget(
        testApp(
          Scaffold(
            appBar: AppBar(actions: [ChatProjectLibrary(f.scope, 'chat-a')]),
          ),
          locale: const Locale('zh'),
        ),
      );
      await tester.tap(find.byTooltip('会话资料库'));
      await tester.pumpAndSettle();
      expect(find.text('链接'), findsOneWidget);
      expect(find.text('https://research.example.test'), findsOneWidget);
      expect(find.text('Earlier label'), findsNothing);
      expect(find.text('另一会话'), findsNothing);
      await tester.tap(find.text('最新链接'));
      await tester.pumpAndSettle();
      final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
      expect(chat.initialMessageId, 'new-link');
      expect(chat.threadRootId, 'root');
      expect(requests, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'external link action is explicit and rechecks current message scope',
    (tester) async {
      final f = await fixture((_) async => jsonResponse(bootstrap()));
      final records = [
        for (var i = 0; i < 13; i++)
          chatLinkMessage('link-$i', 'Source $i', 'example.test/source/$i'),
      ];
      f.scope.data = bootstrap(messages: records);
      final opened = <Uri>[];
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ListView(
              children: [
                ChatLibraryLinks(
                  scope: f.scope,
                  conversationId: 'chat-a',
                  links: conversationLibraryLinks(records),
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
      await tester.pumpAndSettle();
      expect(find.text('Source 0'), findsNothing);
      final more = find.text('Show more links');
      await tester.drag(find.byType(ListView), const Offset(0, -500));
      await tester.pumpAndSettle();
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(find.text('Source 0'), findsOneWidget);
      expect(opened, isEmpty);
      final first = find.widgetWithText(ListTile, 'Source 0');
      final external = find.descendant(
        of: first,
        matching: find.byTooltip('Open link in browser'),
      );
      await tester.ensureVisible(external);
      await tester.pumpAndSettle();
      await tester.tap(external);
      await tester.pumpAndSettle();
      final uri = Uri.parse('https://example.test/source/0');
      expect(opened, [uri]);
      f.scope.data = bootstrap(messages: records.skip(1).toList());
      await tester.tap(external);
      await tester.pumpAndSettle();
      expect(opened, [uri]);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
