import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_library_data.dart';

import 'chat_library_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

final projectKey = '1' * 64;

Json _website(String version, String title) => {
  'id': 'project-$version',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'kind': 'website_project',
  'metadata': {
    'websiteProject': {
      'id': version * 64,
      'projectKey': projectKey,
      'title': title,
      'entry': 'index.html',
      'fileCount': 1,
      'totalBytes': 32,
    },
  },
};

Json _fileMessage(String id) => {
  'id': 'message-$id',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'kind': 'file',
  'metadata': {'fileId': id},
};

Json _file(String id, String name, String type) => {
  'id': id,
  'name': name,
  'type': type,
  'size': 100,
  'conversationId': 'chat-a',
};

const link = {
  'id': 'source',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'content': '[Read the source](https://research.example.test)',
};

void main() {
  testWidgets(
    'pins persist across reopening and follow the latest website version',
    (tester) async {
      final pins = <Json>[];
      final writes = <Json>[];
      final f = await fixture((request) async {
        expect(
          request.url.path,
          '/api/workspaces/space-a/conversations/chat-a/library/pins',
        );
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'PUT') {
          final data = jsonDecode(request.body) as Json;
          writes.add(data);
          pins.removeWhere((pin) => pin['target'] == data['target']);
          if (data['pinned'] == true) {
            pins.insert(0, {
              'kind': data['kind'],
              'target': data['target'],
              'pinnedAt': '2026-11-15T12:00:00Z',
            });
          }
        } else {
          expect(request.method, 'GET');
        }
        return jsonResponse({'pins': pins});
      });
      Json records(Json current) => {
        ...bootstrap(
          messages: [
            _website('a', 'Old title'),
            current,
            _fileMessage('photo'),
            link,
          ],
        ),
        'files': [
          _file('photo', 'garden.png', 'image/png'),
          _file('notes', 'notes.md', 'text/markdown'),
        ],
      };
      f.scope.data = records(_website('b', 'Current title'));
      await tester.pumpWidget(
        testApp(
          Scaffold(
            appBar: AppBar(actions: [libraryActionButton(f.scope, 'chat-a')]),
          ),
        ),
      );
      Future<void> filter(String label) async {
        final chip = find.widgetWithText(ChoiceChip, label);
        await tester.ensureVisible(chip);
        await tester.tap(chip);
        await tester.pump();
      }

      Future<void> waitForPinAction(String label) => waitFor(tester, () {
        return find
            .byWidgetPredicate(
              (widget) =>
                  widget is IconButton &&
                  widget.tooltip == label &&
                  widget.onPressed != null,
            )
            .evaluate()
            .isNotEmpty;
      });

      await tester.tap(find.byTooltip('Conversation library'));
      await tester.pumpAndSettle();
      await filter('Media');
      expect(find.text('garden.png'), findsOneWidget);
      expect(find.text('notes.md'), findsNothing);
      await filter('Files');
      expect(find.text('notes.md'), findsOneWidget);
      expect(find.text('garden.png'), findsNothing);
      await filter('Websites');
      expect(find.text('Current title'), findsOneWidget);
      expect(find.text('Old title'), findsNothing);
      await waitForPinAction('Pin to library');
      await tester.tap(find.byTooltip('Pin to library'));
      await waitForPinAction('Unpin from library');
      expect(writes.single, {
        'kind': 'website',
        'target': projectKey,
        'pinned': true,
      });

      await filter('All');
      expect(find.text('Pinned items'), findsOneWidget);
      expect(
        tester.getCenter(find.text('Current title')).dy,
        lessThan(tester.getCenter(find.text('Read the source')).dy),
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      f.scope.data = records(_website('c', 'New title'));
      await tester.tap(find.byTooltip('Conversation library'));
      await tester.pumpAndSettle();
      await filter('Pinned');
      await waitForPinAction('Unpin from library');
      expect(find.text('New title'), findsOneWidget);
      expect(find.text('Read the source'), findsNothing);
      await tester.tap(find.byTooltip('Unpin from library'));
      await waitFor(
        tester,
        () => find.text('No pinned items yet.').evaluate().isNotEmpty,
      );
      expect(writes.last, {
        'kind': 'website',
        'target': projectKey,
        'pinned': false,
      });
      expect(find.text('No pinned items yet.'), findsOneWidget);

      await filter('Links');
      await tester.tap(find.byTooltip('Pin to library'));
      await waitForPinAction('Unpin from library');
      expect(writes.last, {
        'kind': 'link',
        'target': 'https://research.example.test/',
        'pinned': true,
        'messageId': 'source',
      });
      await filter('Files');
      await tester.tap(find.byTooltip('Pin to library'));
      await waitForPinAction('Unpin from library');
      expect(writes.last, {'kind': 'file', 'target': 'notes', 'pinned': true});
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'unsafe or duplicate links do not create untrusted pin targets',
    () async {
      final f = await fixture(
        (_) async => throw StateError('Local projection only'),
      );
      f.scope.data = bootstrap(
        messages: [
          link,
          {
            ...link,
            'id': 'same',
            'content': '[Latest](https://research.example.test/)',
          },
          {
            ...link,
            'id': 'unsafe',
            'content': '[Unsafe](http://u:p@research.example.test/)',
          },
          {...link, 'id': 'another-chat', 'conversationId': 'chat-b'},
        ],
      );
      final item = conversationLibraryItems(f.scope, 'chat-a').single;
      expect(item.key, (
        kind: LibraryItemKind.link,
        target: 'https://research.example.test/',
      ));
      expect(item.link?.messageId, 'same');
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
