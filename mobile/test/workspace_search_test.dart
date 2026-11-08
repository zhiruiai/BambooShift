import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/message_links.dart';
import 'package:openbot_mobile/core/safe_http_uri.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/chat/file_preview_screen.dart';
import 'package:openbot_mobile/features/files/website_project_screen.dart';
import 'package:openbot_mobile/features/routines/routine_history.dart';
import 'package:openbot_mobile/features/workspaces/workspace_search_data.dart';
import 'package:openbot_mobile/features/workspaces/workspace_search_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const fileContent = 'Search opened the workspace file.';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const oldWebsiteSource = '<h1>Original reviewed castle</h1>';

Json website(String revision, String title) => {
  'id': 'site-$revision',
  'conversationId': 'chat-a',
  'content': title,
  'role': 'assistant',
  'kind': 'website_project',
  'metadata': {
    'websiteProject': {
      'id': revision * 64,
      'projectKey': 'a' * 64,
      'title': title,
      'entry': 'index.html',
      'fileCount': 1,
      'totalBytes': oldWebsiteSource.length,
    },
  },
};

Json searchData({int unread = 1}) => {
  ...bootstrap(),
  'agents': [
    {'id': 'bot-a', 'name': '城堡研究员', 'role': 'Castle researcher'},
  ],
  'conversations': [
    {
      'id': 'chat-a',
      'title': 'Castle design',
      'agentIds': ['bot-a'],
      'unread': unread,
      'readThrough': 60,
    },
    {
      'id': 'group-a',
      'title': '城堡建造组',
      'agentIds': ['bot-a'],
      'isGroup': true,
    },
  ],
  'messages': [
    for (var i = 0; i < 60; i++)
      {
        'id': 'msg-$i',
        'conversationId': 'chat-a',
        'content': i == 4 ? '城堡秘密入口' : 'Castle planning message $i',
        'role': 'assistant',
        'agentId': 'bot-a',
        'createdAt': '2026-11-07T00:${i.toString().padLeft(2, '0')}:00Z',
      },
    {'id': 'orphan', 'conversationId': 'missing', 'content': '城堡隐藏'},
    website('b', '城堡初版网站'),
    website('c', '城堡新版网站'),
    {
      'id': 'link-source',
      'conversationId': 'chat-a',
      'threadRootId': 'msg-4',
      'role': 'assistant',
      'content': '[城堡核验来源](https://example.test/research)',
    },
  ],
  'files': [
    {
      'id': 'file-a',
      'name': '城堡说明.txt',
      'size': utf8.encode(fileContent).length,
    },
    {
      'id': 'orphan-file',
      'name': '城堡遗留.txt',
      'size': 0,
      'conversationId': 'missing',
    },
  ],
  'routines': [
    {'id': 'routine-a', 'title': '城堡巡查', 'agentId': 'bot-a'},
  ],
};

void main() {
  test(
    'all previews each content type and a category includes older matches',
    () {
      final index = WorkspaceSearchIndex(searchData());
      final all = index.search('城堡', null);
      expect(
        all.hits.map((hit) => hit.kind).toSet(),
        SearchKind.values.toSet(),
      );
      expect(all.truncated, true);
      final messages = index.search('castle', SearchKind.message);
      expect(messages.hits, hasLength(63));
      expect(messages.hits.map((hit) => hit.id), contains('msg-0'));
      expect(messages.truncated, false);
      expect(
        index.search(' ｃａｓｔｌｅ　ＰＬＡＮＮＩＮＧ ５９ ', SearchKind.message).hits.single.id,
        'msg-59',
      );
      expect(index.search('城堡隐藏', null).hits, isEmpty);
      expect(index.search('城堡遗留', null).hits, isEmpty);
      expect(index.search('城堡', SearchKind.file).hits.single.id, 'file-a');
      expect(
        index.search('城堡', SearchKind.routine).hits.single.id,
        'routine-a',
      );
    },
  );

  test(
    'indexes GFM text links once and skips untrusted or transient content',
    () {
      final content = '''
[Reference title](https://example.test/report)
[Same target](https://example.test/report)
https://public.example.test/source
[local research](http://127.0.0.1:1234/notes)
![photo](https://example.test/image)

`https://example.test/inline-code`

```html
<a href="https://example.test/fenced-code">code</a>
```

<a href="https://example.test/raw-html">HTML</a>
[relative](/api/files/private)
[credentials](https://user:pass@example.test/hidden)
[unsafe](javascript:alert%281%29)
''';
      final row = {'role': 'assistant', 'content': content};
      expect(messageLinks(row).map((link) => link.uri.toString()), [
        'https://example.test/report',
        'https://public.example.test/source',
        'http://127.0.0.1:1234/notes',
      ]);
      expect(messageLinks(row).first.label, 'Reference title');
      expect(
        messageLinks({
          'role': 'user',
          'content': 'www.example.test/report',
        }).single.uri.toString(),
        'http://www.example.test/report',
      );
      for (final overlay in [
        {'kind': 'file'},
        {'role': 'system'},
        {'status': 'running'},
      ]) {
        expect(messageLinks({...row, ...overlay}), isEmpty);
      }
      expect(safeHttpUri('https://example.test/bad\\target'), isNull);
      expect(safeHttpUri('https://example.test/bad target'), isNull);
      expect(safeHttpUri('https://example.test:99999/path'), isNull);
      expect(
        safeHttpUri('https://example.test/path%20with%20spaces'),
        isNotNull,
      );
    },
  );

  testWidgets('website search opens the exact older project in Chinese', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final paths = <String>[];
    final base = '/api/workspaces/$workspaceId/website-projects/${'b' * 64}';
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      paths.add(request.url.path);
      final bytes = utf8.encode(oldWebsiteSource);
      if (request.url.path == base) {
        final project =
            (website('b', '城堡初版网站')['metadata'] as Json)['websiteProject']
                as Json;
        return jsonResponse({
          ...project,
          'files': [
            {
              'path': 'index.html',
              'mime': 'text/html',
              'size': bytes.length,
              'sha256': sha256.convert(bytes).toString(),
            },
          ],
        });
      }
      expect(request.url.path, '$base/files/index.html');
      return http.Response.bytes(
        bytes,
        200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="index.html"',
        },
      );
    });
    f.scope.dispose();
    f.session.workspaces = [
      {...f.session.workspaces.single, 'id': workspaceId},
    ];
    f.session.selectWorkspace(f.session.workspaces.single);
    final scope = WorkspaceController(f.session)..data = searchData();
    await tester.pumpWidget(
      testApp(WorkspaceSearchScreen(scope: scope), locale: const Locale('zh')),
    );
    await tester.enterText(find.byType(TextField), '初版网站');
    final websites = find.widgetWithText(ChoiceChip, '网站');
    await tester.ensureVisible(websites);
    await tester.tap(websites);
    await tester.pumpAndSettle();
    expect(paths, isEmpty);
    await tester.tap(find.byKey(const ValueKey('website:site-b')));
    await waitFor(
      tester,
      () =>
          paths.length == 2 &&
          find.byType(CircularProgressIndicator).evaluate().isEmpty,
    );
    final preview = tester.widget<WebsiteProjectScreen>(
      find.byType(WebsiteProjectScreen),
    );
    expect(preview.client.project.title, '城堡初版网站');
    expect(paths, [base, '$base/files/index.html']);
    await tester.tap(find.text('源码'));
    await tester.pumpAndSettle();
    expect(find.text(oldWebsiteSource), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    scope.dispose();
    f.session.dispose();
  }, variant: const TargetPlatformVariant({TargetPlatform.linux}));

  testWidgets(
    'link search navigates to the source thread without opening the URL',
    (tester) async {
      final paths = <String>[];
      final f = await fixture((request) async {
        paths.add(request.url.toString());
        return jsonResponse(searchData());
      });
      f.scope.data = searchData();
      await tester.pumpWidget(testApp(WorkspaceSearchScreen(scope: f.scope)));
      await tester.enterText(find.byType(TextField), 'example.test/research');
      final links = find.widgetWithText(ChoiceChip, 'Links');
      await tester.ensureVisible(links);
      await tester.tap(links);
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          const ValueKey('link:link-source:https://example.test/research'),
        ),
      );
      await tester.pumpAndSettle();
      final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
      expect(chat.initialMessageId, 'link-source');
      expect(chat.threadRootId, 'msg-4');
      expect(paths, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'a Chinese phone opens an old message without marking latest as read',
    (tester) async {
      tester.view.physicalSize = const Size(360, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var read = 0;
      final fixtureValue = await fixture((request) async {
        if (request.method == 'PATCH') {
          read++;
          expect(
            request.url.path,
            '/api/workspaces/space-a/conversations/chat-a',
          );
          return jsonResponse({});
        }
        return jsonResponse(searchData(unread: read == 0 ? 1 : 0));
      });
      fixtureValue.scope.data = searchData();
      await tester.pumpWidget(
        testApp(
          WorkspaceSearchScreen(scope: fixtureValue.scope),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '秘密入口');
      await tester.pumpAndSettle();
      final result = find.byKey(const ValueKey('message:msg-4'));
      expect(result, findsOneWidget);
      expect(read, 0);
      await tester.tap(result);
      await tester.pumpAndSettle();
      final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
      expect(chat.initialMessageId, 'msg-4');
      expect(
        find.byKey(const ValueKey('focused-chat-message')).hitTestable(),
        findsOneWidget,
      );
      expect(read, 0);
      await tester.tap(find.text('返回最新消息'));
      await waitFor(tester, () => read == 1);
      expect(
        find.byKey(const ValueKey('user-a:space-a:msg-59')).hitTestable(),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('focused-chat-message')), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      fixtureValue.scope.dispose();
      fixtureValue.session.dispose();
    },
  );

  testWidgets('files and routines open their own pages using workspace scope', (
    tester,
  ) async {
    final paths = <String>[];
    final fixtureValue = await fixture((request) async {
      paths.add(request.url.path);
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.url.path.endsWith('/files/file-a/download')) {
        return http.Response.bytes(
          utf8.encode(fileContent),
          200,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="file.txt"',
          },
        );
      }
      expect(
        request.url.path,
        '/api/workspaces/space-a/routines/routine-a/runs',
      );
      return jsonResponse({'routineId': 'routine-a', 'runs': []});
    });
    fixtureValue.scope.data = searchData();
    await tester.pumpWidget(
      testApp(WorkspaceSearchScreen(scope: fixtureValue.scope)),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '城堡');
    await tester.tap(find.widgetWithText(ChoiceChip, 'Files'));
    await tester.pumpAndSettle();
    expect(paths, isEmpty);
    expect(find.byKey(const ValueKey('routine:routine-a')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('file:file-a')));
    await waitFor(tester, () => find.text(fileContent).evaluate().isNotEmpty);
    expect(find.byType(FilePreviewScreen), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '城堡',
    );
    final routines = find.widgetWithText(ChoiceChip, 'Routines');
    await tester.ensureVisible(routines);
    await tester.tap(routines);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('routine:routine-a')));
    await waitFor(
      tester,
      () =>
          find.byType(RoutineHistory).evaluate().isNotEmpty &&
          find.byType(LinearProgressIndicator).evaluate().isEmpty,
    );
    expect(find.byType(RoutineHistory), findsOneWidget);
    expect(paths, [
      '/api/workspaces/space-a/files/file-a/download',
      '/api/workspaces/space-a/routines/routine-a/runs',
    ]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    fixtureValue.scope.dispose();
    fixtureValue.session.dispose();
  });
}
