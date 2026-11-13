import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/computer/computer_connection_card.dart';
import 'package:openbot_mobile/features/computer/computer_connection_controller.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'computer_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'small phone $language connects locally only after confirmation',
      (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final png = await tester.runAsync(computerPng);
        final s = ComputerServer(png!)..available = false;
        final f = await fixture(s.handle);
        f.scope.data = s.data;
        final computer = ComputerController(f.scope, 'bot-a');
        final c = ComputerConnectionController(computer);
        await tester.runAsync(c.refresh);
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: SingleChildScrollView(
                child: ComputerConnectionCard(controller: c),
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        final connect = find.text(
          language == 'en' ? 'Connect service computer' : '连接服务所在电脑',
        );
        expect(connect.hitTestable(), findsOneWidget);
        await tester.tap(connect);
        await tester.pumpAndSettle();
        expect(s.connections, 0);
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(TextButton),
          ),
        );
        await tester.pumpAndSettle();
        expect(s.connections, 0);
        await tester.tap(connect);
        await tester.pumpAndSettle();
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(FilledButton),
          ),
        );
        await waitFor(
          tester,
          () =>
              s.connections == 1 && !c.changing && !computer.busy && !c.loading,
        );
        expect(connect, findsNothing);
        expect(
          find.text(language == 'en' ? 'Disconnect' : '断开连接'),
          findsOneWidget,
        );
        expect(s.starts, 0);
        expect(s.inputs, isEmpty);
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
        await tester.pumpAndSettle();
        expect(
          find.text(language == 'en' ? 'Disconnect' : '断开连接'),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        computer.dispose();
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets('pairing credential clears on background and owner loss', (
    tester,
  ) async {
    final png = await tester.runAsync(computerPng);
    final s = ComputerServer(png!);
    final f = await fixture(s.handle);
    f.scope.data = s.data;
    final computer = ComputerController(f.scope, 'bot-a');
    final c = ComputerConnectionController(computer);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: SingleChildScrollView(
            child: ComputerConnectionCard(controller: c),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pair another computer'));
    await tester.pumpAndSettle();
    final field = find.byKey(const ValueKey('worker-token'));
    await tester.ensureVisible(field);
    await tester.enterText(field, 'synthetic-token');
    expect(tester.widget<TextField>(field).obscureText, true);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.enterText(field, 'synthetic-token');
    final input = tester.widget<TextField>(field).controller!;
    f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
    await tester.pumpAndSettle();
    expect(input.text, isEmpty);
    expect(field, findsNothing);
    expect(s.connections, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    computer.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
