import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/bot_library/template_manager_screen.dart';
import 'package:openbot_mobile/features/bot_library/live_sharing_screen.dart';
import 'template_support.dart';
import 'sharing_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;
import 'library_widgets_test.dart' show libraryReach, waitForLibrary;

void main() {
  testWidgets(
    '390px draft edit review cannot publish before explicit save and publication confirmation',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = TemplateServer();
      final f = await fixture(server.handle);
      await tester.pumpWidget(testApp(TemplateManagerScreen(scope: f.scope)));
      await waitForLibrary(
        tester,
        () => find.text('Research Bot').evaluate().length == 2,
      );
      await tester.tap(find.text('Research Bot').last);
      await waitForLibrary(
        tester,
        () => find.text('Edit template draft').evaluate().isNotEmpty,
      );
      await libraryReach(tester, find.text('Edit template draft'));
      await tester.tap(find.text('Edit template draft'));
      await tester.pumpAndSettle();
      expect(server.mutations, isEmpty);
      final role = find.widgetWithText(TextFormField, 'Role');
      await tester.enterText(role, 'Careful reviewer');
      await libraryReach(tester, find.text('Review changes'));
      await tester.tap(find.text('Review changes'));
      await tester.pumpAndSettle();
      expect(server.mutations, isEmpty);
      expect(find.text('Careful reviewer'), findsOneWidget);
      expect(find.text('Publish reviewed draft'), findsNothing);
      await libraryReach(tester, find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(server.mutations, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitForLibrary(tester, () => server.mutations.isNotEmpty);
      expect(server.mutations.single.method, 'PATCH');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'Chinese live sharing shows unavailable selections and submits only after confirmation',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = SharingServer();
      final f = await fixture(server.handle);
      await tester.pumpWidget(
        testApp(
          LiveSharingScreen(scope: f.scope, agentId: 'bot-a'),
          locale: const Locale('zh'),
        ),
      );
      await waitForLibrary(
        tester,
        () => find.text('实时共享已启用').evaluate().isNotEmpty,
      );
      expect(server.writes, isEmpty);
      await libraryReach(tester, find.text('Review.txt').first);
      expect(find.textContaining('来源已删除'), findsOneWidget);
      await libraryReach(tester, find.text('撤销实时共享'));
      await tester.tap(find.text('撤销实时共享'));
      await tester.pumpAndSettle();
      expect(server.writes, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, '完成'));
      await waitForLibrary(tester, () => server.writes.isNotEmpty);
      expect(server.writes.single.url.path.endsWith('/revoke'), true);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
