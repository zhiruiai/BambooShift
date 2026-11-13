import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/computer/cloud_computer_card.dart';
import 'package:openbot_mobile/features/computer/computer_connection_card.dart';
import 'package:openbot_mobile/features/computer/cloud_computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_screen.dart';
import 'computer_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets('phone $language discovers both execution modes from chat', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final png = await tester.runAsync(computerPng);
      final s = ComputerServer(png!);
      final f = await fixture(s.handle);
      f.scope.data = s.data;
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: Locale(language),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip(language == 'en' ? 'Computer' : '电脑'));
      final local = find.text(language == 'en' ? 'Local execution' : '本地执行');
      final cloud = find.text(language == 'en' ? 'Cloud execution' : '云端执行');
      final setup = find.textContaining(
        language == 'en'
            ? 'No managed cloud computer is configured'
            : '尚未配置托管云电脑',
      );
      for (var attempt = 0; attempt < 100; attempt++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();
        final card = find.byType(ComputerConnectionCard);
        if (card.evaluate().isNotEmpty) {
          final c = tester.widget<ComputerConnectionCard>(card).controller;
          if (!c.loading && !c.computer.busy) break;
        }
      }
      await tester.pump(const Duration(milliseconds: 400));
      expect(local.hitTestable(), findsOneWidget);
      await tester.scrollUntilVisible(
        cloud,
        200,
        scrollable: find
            .descendant(
              of: find.byType(ComputerScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      await tester.pump(const Duration(milliseconds: 400));
      expect(setup, findsOneWidget);
      await Scrollable.ensureVisible(tester.element(cloud), alignment: .3);
      await tester.pump(const Duration(milliseconds: 400));
      expect(cloud.hitTestable(), findsOneWidget);
      expect(
        find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Start or resume and connect' : '启动或恢复并连接',
        ),
        findsNothing,
      );
      expect(s.cloudStarts, 0);
      expect(s.starts, 0);
      expect(s.inputs, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });

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
