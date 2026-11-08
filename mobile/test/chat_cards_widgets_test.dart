import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/action_card.dart';
import 'package:openbot_mobile/features/chat/action_data.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/chat/file_preview_data.dart';
import 'package:openbot_mobile/features/chat/file_preview_screen.dart';

import 'action_card_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json registeredFile() => {
  'id': 'file-a',
  'name': 'synthetic.html',
  'size': 500,
  'conversationId': 'chat-a',
};
const source =
    '<html><script>fetch("https://outside.example.test")</script><a href="https://outside.example.test">Report</a></html>';

void main() {
  testWidgets(
    'chat renders file and shared action cards without dispatching anything',
    (tester) async {
      var calls = 0;
      final message = actionMessage(requester: 'peer');
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      f.scope.data = bootstrap(
        messages: [
          {
            'id': 'file-message',
            'kind': 'file',
            'conversationId': 'chat-a',
            'role': 'assistant',
            'agentId': 'bot-a',
            'metadata': {'fileId': 'file-a'},
          },
          message,
        ],
        agents: [
          {'id': 'bot-a', 'name': 'Example'},
        ],
      )..['files'] = [registeredFile()];
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
      );
      await tester.pumpAndSettle();
      expect(find.text('synthetic.html'), findsOneWidget);
      expect(find.textContaining('Shared researcher'), findsOneWidget);
      expect(
        find.text('Only the requester of this task can decide.'),
        findsOneWidget,
      );
      expect(find.text('Approve action'), findsNothing);
      expect(calls, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'requester explicitly approves once and unknown results only offer checking',
    (tester) async {
      var writes = 0;
      final message = actionMessage();
      final data = bootstrap(messages: [message]);
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'POST') {
          writes++;
          throw http.ClientException('synthetic lost reply');
        }
        return jsonResponse(data);
      });
      f.scope.data = data;
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SingleChildScrollView(
              child: ActionCard(
                scope: f.scope,
                message: message,
                action: ChatAction.fromMessage(message)!,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(writes, 0);
      await tester.tap(find.widgetWithText(FilledButton, 'Approve action'));
      await waitFor(
        tester,
        () => find.text('Approve action').evaluate().isEmpty,
      );
      expect(writes, 1);
      await tester.tap(
        find.widgetWithText(TextButton, 'Check original action'),
      );
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(find.textContaining('will not be sent again'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'HTML shows literal source through the fixed file API and no external resource',
    (tester) async {
      final paths = <String>[];
      final f = await fixture((request) async {
        paths.add(request.url.path);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        return http.Response(
          source,
          200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': 'attachment; filename="synthetic.html"',
          },
        );
      });
      f.scope.data!['files'] = [registeredFile()];
      await tester.pumpWidget(
        testApp(
          FilePreviewScreen(
            scope: f.scope,
            file: const ChatFile('file-a', 'synthetic.html', 500),
          ),
        ),
      );
      await waitFor(
        tester,
        () => find.byType(SelectableText).evaluate().isNotEmpty,
      );
      expect(
        tester.widget<SelectableText>(find.byType(SelectableText)).data,
        source,
      );
      expect(
        find.text(
          'HTML is shown as source only. Scripts and external resources do not run.',
        ),
        findsOneWidget,
      );
      expect(paths, ['/api/workspaces/space-a/files/file-a/download']);
      expect(find.byType(Image), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'closing a preview or switching accounts never exposes a late file',
    (tester) async {
      for (final switchAccount in [false, true]) {
        final late = Completer<http.Response>();
        final f = await fixture((_) => late.future);
        f.scope.data!['files'] = [registeredFile()];
        await tester.pumpWidget(
          testApp(
            FilePreviewScreen(
              scope: f.scope,
              file: const ChatFile('file-a', 'synthetic.html', 500),
            ),
          ),
        );
        await tester.pump();
        if (switchAccount) {
          f.session.user = {'id': 'other-user'};
        } else {
          await tester.pumpWidget(const SizedBox());
        }
        late.complete(
          http.Response(
            source,
            200,
            headers: {
              'content-type': 'text/html',
              'content-disposition': 'attachment; filename="synthetic.html"',
            },
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
        expect(find.byType(SelectableText), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  testWidgets(
    'large and unsupported files do not trigger a download or OS file permissions',
    (tester) async {
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      f.scope.data!['files'] = [registeredFile()];
      for (final file in [
        const ChatFile('file-a', 'large.txt', 3 * 1024 * 1024),
        const ChatFile('file-a', 'sheet.xlsx', 200),
      ]) {
        await tester.pumpWidget(
          testApp(
            FilePreviewScreen(
              key: ValueKey(file.name),
              scope: f.scope,
              file: file,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(SelectableText), findsNothing);
      }
      expect(calls, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
