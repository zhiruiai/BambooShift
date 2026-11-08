import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/chat/attachment_controller.dart';
import 'package:openbot_mobile/features/chat/attachment_panel.dart';
import 'package:openbot_mobile/features/chat/attachment_selection.dart';

import 'attachment_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  testWidgets(
    '390px native chat chooses, uploads, then explicitly sends without losing text',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = AttachmentServer();
      final f = await fixture(server.handle);
      await tester.runAsync(f.scope.refresh);
      var picks = 0;
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: f.scope,
            conversationId: 'chat-a',
            attachmentPicker: () async {
              picks++;
              return selectedFile();
            },
          ),
        ),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextButton>(
                  find.widgetWithText(TextButton, 'Choose file'),
                )
                .onPressed !=
            null,
      );
      await tester.enterText(find.byType(TextField), 'Keep this draft');
      expect(picks, 0);
      await tester.tap(find.text('Choose file'));
      await tester.pumpAndSettle();
      expect(picks, 1);
      expect(find.text('note.txt'), findsOneWidget);
      expect(server.requests.where((r) => r.method == 'POST'), isEmpty);
      expect(
        tester
            .widget<FilledButton>(
              find.ancestor(
                of: find.byIcon(Icons.arrow_upward),
                matching: find.byType(FilledButton),
              ),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(
        find.widgetWithText(FilledButton, 'Upload selected file'),
      );
      await waitFor(
        tester,
        () =>
            server.files.length == 1 &&
            !tester
                .widget<AttachmentPanel>(find.byType(AttachmentPanel))
                .controller
                .busy &&
            find.text('Uploaded; send to ask the Bot').evaluate().isNotEmpty,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Keep this draft',
      );
      expect(server.messages.single['kind'], 'file');
      expect(
        server.requests.where((r) => r.url.path.endsWith('/messages')),
        isEmpty,
      );
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await waitFor(
        tester,
        () => tester
            .widget<TextField>(find.byType(TextField))
            .controller!
            .text
            .isEmpty,
      );
      final sent = server.messages.last['content'] as String;
      expect(sent, contains('Keep this draft'));
      expect(sent, contains('/api/workspaces/space-a/files/file-1/download'));
      expect(find.text('Uploaded; send to ask the Bot'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'unknown upload requires explicit confirmation and does not retry on reopen',
    (tester) async {
      final server = AttachmentServer()
        ..loseUpload = true
        ..acceptUpload = false;
      final f = await fixture(server.handle);
      var c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      await tester.runAsync(c.initialize);
      await tester.runAsync(c.choose);
      await tester.runAsync(c.upload);
      c.dispose();
      c = AttachmentController(f.scope, 'chat-a');
      await tester.runAsync(c.initialize);
      await tester.pumpWidget(
        testApp(Scaffold(body: AttachmentPanel(controller: c))),
      );
      await tester.pumpAndSettle();
      expect(c.pending, isNotNull);
      final abandon = find.text('Discard local upload check');
      await tester.ensureVisible(abandon);
      await tester.tap(abandon);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('does not cancel the remote upload'),
        findsOneWidget,
      );
      expect(c.pending, isNotNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => c.pending == null);
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'changing chats discards a late picker result and preserves the new draft',
    (tester) async {
      final picked = Completer<SelectedAttachment?>();
      final server = AttachmentServer();
      final f = await fixture(server.handle);
      f.scope.data!['conversations'] = [
        ...f.scope.items('conversations'),
        {
          'id': 'chat-b',
          'agentIds': ['bot-a'],
          'title': 'Other',
          'isGroup': false,
        },
      ];
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: f.scope,
            conversationId: 'chat-a',
            attachmentPicker: () => picked.future,
          ),
        ),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextButton>(
                  find.widgetWithText(TextButton, 'Choose file'),
                )
                .onPressed !=
            null,
      );
      await tester.tap(find.text('Choose file'));
      await tester.pump();
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-b')),
      );
      await tester.pumpAndSettle();
      picked.complete(selectedFile());
      await tester.pumpAndSettle();
      expect(find.text('note.txt'), findsNothing);
      expect(server.requests.where((r) => r.method == 'POST'), isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'file translations have matching keys and describe the no-cancellation boundary',
    () {
      final en =
          jsonDecode(File('assets/l10n/files_en.arb').readAsStringSync())
              as Map;
      final zh =
          jsonDecode(File('assets/l10n/files_zh.arb').readAsStringSync())
              as Map;
      expect(en.keys.toSet(), zh.keys.toSet());
      expect(en['mobileFilesAbandonConfirm'], contains('does not cancel'));
      expect(zh['mobileFilesAbandonConfirm'], contains('不会取消'));
    },
  );
}
