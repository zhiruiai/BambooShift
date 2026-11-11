import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_project_library.dart';
import 'package:openbot_mobile/features/chat/file_card.dart';
import 'package:openbot_mobile/features/chat/file_preview_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json _record(String id, String name, {String? chat = 'chat-a'}) => {
  'id': id,
  'name': name,
  'size': 34,
  'conversationId': chat,
};

Json _message(
  String id,
  String file, {
  String chat = 'chat-a',
  String? thread,
}) => {
  'id': id,
  'conversationId': chat,
  'threadRootId': ?thread,
  'kind': 'file',
  'role': 'assistant',
  'metadata': {'fileId': file},
};

void main() {
  testWidgets('files-only Chinese library previews its own registered files', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final reads = <String>[];
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      reads.add(request.url.path);
      return http.Response(
        '''
# Local Markdown

Verified preview.

| Site | Result | Next |
| --- | --- | --- |
| North | Ready | Review |

![Remote illustration](https://outside.example.test/image.png)
[Private route](/api/account/session)
''',
        200,
        headers: {
          'content-type': 'text/markdown',
          'content-disposition': 'attachment; filename="report.md"',
        },
      );
    });
    f.scope.data = {
      ...bootstrap(
        messages: [
          _message('older', 'registered'),
          _message('latest', 'registered', thread: 'root'),
          _message('another-chat', 'other', chat: 'chat-b'),
          _message('wrong-chat-record', 'other'),
          _message('removed-file', 'deleted'),
        ],
      ),
      'files': [
        _record('registered', 'report.md'),
        _record('other', 'cross-chat.md', chat: 'chat-b'),
        _record('not-shared', 'unattached.md', chat: null),
      ],
    };
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
    expect(find.text('文件'), findsOneWidget);
    expect(find.text('report.md'), findsOneWidget);
    expect(find.text('cross-chat.md'), findsNothing);
    expect(find.text('unattached.md'), findsNothing);
    expect(find.byType(ChatFileCard), findsOneWidget);
    expect(
      tester.widget<ChatFileCard>(find.byType(ChatFileCard)).message['id'],
      'latest',
    );
    expect(reads, isEmpty);
    await tester.tap(find.text('report.md'));
    await waitFor(
      tester,
      () => find.textContaining('Verified preview.').evaluate().isNotEmpty,
    );
    expect(find.byType(FilePreviewScreen), findsOneWidget);
    expect(find.text('Local Markdown'), findsOneWidget);
    expect(find.text('# Local Markdown'), findsNothing);
    expect(find.byType(Table), findsOneWidget);
    expect(find.text('Remote illustration'), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    await tester.tapOnText(find.textRange.ofSubstring('Private route'));
    expect(reads, ['/api/workspaces/space-a/files/registered/download']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('large conversation file list reveals more on request', (
    tester,
  ) async {
    final f = await fixture((_) async {
      fail(
        'Listing already authorized file cards should not fetch file bytes.',
      );
    });
    f.scope.data = {
      ...bootstrap(
        messages: [for (var i = 0; i < 13; i++) _message('m-$i', 'f-$i')],
      ),
      'files': [for (var i = 0; i < 13; i++) _record('f-$i', 'Note $i.txt')],
    };
    await tester.pumpWidget(
      testApp(
        Scaffold(
          appBar: AppBar(actions: [ChatProjectLibrary(f.scope, 'chat-a')]),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Conversation library'));
    await tester.pumpAndSettle();
    expect(find.byType(ChatFileCard), findsNWidgets(12));
    expect(find.text('Note 0.txt'), findsNothing);
    final more = find.text('Show more files');
    await tester.ensureVisible(more);
    await tester.pumpAndSettle();
    await tester.tap(more);
    await tester.pumpAndSettle();
    expect(find.text('Note 0.txt'), findsOneWidget);
    expect(more, findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
