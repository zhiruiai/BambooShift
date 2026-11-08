import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/file_card.dart';
import 'package:openbot_mobile/features/chat/file_preview_data.dart';
import 'package:openbot_mobile/features/chat/file_preview_screen.dart';
import 'package:openbot_mobile/features/files/file_export_button.dart';
import 'package:openbot_mobile/features/files/file_export_controller.dart';

import 'file_export_support.dart';
import 'model_profiles_layout_test.dart' show expectReadableText;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'non-preview PDF retains explicit save and share at 390px in $language',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final server = ExportServer();
        final f = await fixture(server.handle);
        f.scope.data = server.data;
        final destination = ExportDestination();
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: ChatFileCard(
                scope: f.scope,
                message: {
                  'kind': 'file',
                  'conversationId': 'chat-a',
                  'metadata': {'fileId': 'file-a'},
                },
                exportDestination: destination,
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('report.pdf'), findsOneWidget);
        expect(find.byType(FileExportButton), findsOneWidget);
        expect(server.requests, isEmpty);
        expect(destination.calls, 0);
        final button = find.byTooltip(
          language == 'en' ? 'Save or share file' : '保存或分享文件',
        );
        await tester.tap(button);
        final model =
            (tester.state(find.byType(FileExportButton)) as dynamic).controller
                as FileExportController;
        await waitFor(tester, () => destination.calls == 1 && !model.busy);
        expect(destination.received?.bytes, server.content);
        expect(tester.takeException(), isNull);
        for (final paragraph in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(paragraph.text);
        }
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
  testWidgets(
    'preview keeps export explicit and pinned to its original conversation',
    (tester) async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination();
      await tester.pumpWidget(
        testApp(
          FilePreviewScreen(
            scope: f.scope,
            file: ChatFile('file-a', server.name, server.content.length),
            exportDestination: destination,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(FileExportButton), findsOneWidget);
      expect(server.requests, isEmpty);
      expect(destination.calls, 0);
      await tester.tap(find.byTooltip('Save or share file'));
      final model =
          (tester.state(find.byType(FileExportButton)) as dynamic).controller
              as FileExportController;
      await waitFor(tester, () => destination.calls == 1 && !model.busy);
      expect(destination.received?.bytes, server.content);
      server.conversationId = 'chat-b';
      f.scope.data = server.data;
      await tester.pump();
      await tester.tap(find.byTooltip('Save or share file'));
      await tester.pump();
      expect(destination.calls, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'unavailable platform disables the outlet without requesting bytes',
    (tester) async {
      final server = ExportServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final destination = ExportDestination()..supported = false;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: FileExportButton(
              scope: f.scope,
              conversationId: 'chat-a',
              file: ChatFile('file-a', 'report.pdf', server.content.length),
              destination: destination,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<IconButton>(find.byType(IconButton)).onPressed,
        isNull,
      );
      expect(server.requests, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
