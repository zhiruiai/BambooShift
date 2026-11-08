import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/computer/computer_screen.dart';
import 'computer_support.dart';
import 'computer_widgets_test.dart' show current, reach;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      '$language owner explicitly confirms screen preparation; member sees an explanation',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final png = await tester.runAsync(computerPng);
        final s = ComputerServer(png!)..assigned = false;
        final f = await fixture(s.handle);
        f.scope.data = s.data;
        await tester.pumpWidget(
          testApp(
            ComputerScreen(scope: f.scope, agentId: 'bot-a'),
            locale: Locale(language),
          ),
        );
        final c = current(tester);
        await waitFor(
          tester,
          () => c.status?.status == 'unassigned' && c.canChangeConnection,
        );
        final prepare = find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Prepare screen' : '准备画面',
        );
        await reach(tester, prepare);
        await tester.tap(prepare);
        await tester.pumpAndSettle();
        expect(s.preparations, 0);
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(TextButton),
          ),
        );
        await tester.pumpAndSettle();
        expect(s.preparations, 0);
        await tester.tap(prepare);
        await tester.pumpAndSettle();
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(FilledButton),
          ),
        );
        await waitFor(
          tester,
          () => s.preparations == 1 && c.frame != null && !c.busy,
        );
        expect(s.starts, 0);
        expect(s.inputs, isEmpty);
        s.assigned = false;
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
        await tester.runAsync(c.refresh);
        await tester.pumpAndSettle();
        final explanation = find.text(
          language == 'en'
              ? 'This Bot has no screen yet. Ask the workspace owner to prepare one; you can then preview it or take control.'
              : '此 Bot 尚未分配画面，请空间拥有者准备；完成后你可以查看和接管。',
        );
        await reach(tester, explanation);
        expect(prepare, findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
}
