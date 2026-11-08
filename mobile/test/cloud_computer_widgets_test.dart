import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/computer/cloud_computer_card.dart';
import 'package:openbot_mobile/features/computer/cloud_computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'computer_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'cloud $language phone owner confirms exactly once; member has no start action',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final png = await tester.runAsync(computerPng);
        final s = ComputerServer(png!)..cloudConfigured = true;
        final f = await fixture(s.handle);
        f.scope.data = s.data;
        final computer = ComputerController(f.scope, 'bot-a');
        final cloud = CloudComputerController(computer);
        await tester.runAsync(() async {
          await computer.refresh();
          await cloud.refresh();
        });
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: SingleChildScrollView(
                child: CloudComputerCard(controller: cloud),
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        final start = find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Start or resume and connect' : '启动或恢复并连接',
        );
        expect(start, findsOneWidget);
        await tester.tap(start);
        await tester.pumpAndSettle();
        expect(s.cloudStarts, 0);
        final cancel = find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(TextButton),
        );
        await tester.tap(cancel);
        await tester.pumpAndSettle();
        expect(s.cloudStarts, 0);
        await tester.tap(start);
        await tester.pumpAndSettle();
        final accept = find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(FilledButton),
        );
        await tester.tap(accept);
        await waitFor(
          tester,
          () => s.cloudStarts == 1 && !cloud.starting && !computer.busy,
        );
        expect(s.starts, 0);
        expect(s.inputs, isEmpty);
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
        await tester.pumpAndSettle();
        expect(start, findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        cloud.dispose();
        computer.dispose();
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
}
