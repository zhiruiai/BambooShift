import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/bots/bot_settings.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_screen.dart';

import 'computer_support.dart';
import 'model_profiles_layout_test.dart' show expectReadableText;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

ComputerController current(WidgetTester tester) =>
    (tester.state(find.byType(ComputerScreen)) as dynamic).controller
        as ComputerController;

Future<void> reach(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    180,
    scrollable: find
        .descendant(
          of: find.byType(ListView),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'phone $language requires explicit takeover and sends only clicked controls',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final png = await tester.runAsync(computerPng);
        final s = ComputerServer(png!);
        final f = await fixture(s.handle);
        f.scope.data = s.data;
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
        f.session.avatarTheme = language == 'en' ? 'pandas' : 'dinosaurs';
        await tester.pumpWidget(
          testApp(
            ComputerScreen(scope: f.scope, agentId: 'bot-a'),
            locale: Locale(language),
          ),
        );
        final c = current(tester);
        await waitFor(tester, () => c.frame != null && !c.busy);
        expect(s.starts, 0);
        expect(s.inputs, isEmpty);
        final start = find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Take control' : '开始接管',
        );
        await reach(tester, start);
        await tester.tap(start);
        await tester.pumpAndSettle();
        expect(s.starts, 0);
        final dialog = find.byType(AlertDialog);
        final confirm = find.descendant(
          of: dialog,
          matching: find.byType(FilledButton),
        );
        await tester.tap(confirm);
        await waitFor(tester, () => c.canInput);
        expect(s.starts, 1);
        final picture = find.byKey(const ValueKey('computer-frame'));
        await reach(tester, picture);
        await tester.pumpAndSettle();
        await tester.tapAt(tester.getTopLeft(picture) + const Offset(12, 2));
        await tester.pump();
        expect(s.inputs, isEmpty);
        await tester.tapAt(tester.getCenter(picture));
        await waitFor(tester, () => s.inputs.length == 1 && !c.busy);
        expect(s.inputs.first['type'], 'click');
        expect(s.inputs.first['x'], 400);
        expect(s.inputs.first['y'], 200);
        final text = find.byKey(const ValueKey('computer-text'));
        await reach(tester, text);
        expect(tester.widget<TextField>(text).obscureText, true);
        expect(
          tester.widget<TextField>(text).enableIMEPersonalizedLearning,
          false,
        );
        await tester.enterText(text, 'Synthetic phone text');
        final show = find.byTooltip(
          language == 'en' ? 'Show typed text' : '显示输入内容',
        );
        await tester.tap(show);
        await tester.pump();
        expect(tester.widget<TextField>(text).obscureText, false);
        expect(s.inputs.length, 1);
        final send = find.byKey(const ValueKey('computer-send-text'));
        await reach(tester, send);
        await tester.tap(send);
        await waitFor(tester, () => s.inputs.length == 2 && !c.busy);
        expect(s.inputs.last['text'], 'Synthetic phone text');
        expect(tester.widget<TextField>(text).controller!.text, isEmpty);
        expect(tester.widget<TextField>(text).obscureText, true);
        expect(
          s.requests.where((r) => r.url.path.endsWith('/takeover/screenshot')),
          isNotEmpty,
        );
        for (final p in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(p.text);
        }
        final end = find.widgetWithText(
          OutlinedButton,
          language == 'en' ? 'Release control' : '结束接管',
        );
        await reach(tester, end);
        await tester.tap(end);
        await waitFor(tester, () => c.lease == null && !c.busy);
        expect(s.ends, 1);
        expect(s.active, false);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
  testWidgets(
    'zoom and pan are inspection only, fit restores verified tap coordinates',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final png = await tester.runAsync(computerPng);
      final s = ComputerServer(png!);
      final f = await fixture(s.handle);
      f.scope.data = s.data;
      await tester.pumpWidget(
        testApp(ComputerScreen(scope: f.scope, agentId: 'bot-a')),
      );
      final c = current(tester);
      await waitFor(tester, () => c.canStart);
      await tester.runAsync(c.start);
      await waitFor(tester, () => c.canInput);
      final picture = find.byKey(const ValueKey('computer-frame'));
      await reach(tester, picture);
      final viewer = tester.widget<InteractiveViewer>(
        find.byType(InteractiveViewer),
      );
      viewer.transformationController!.value = Matrix4.diagonal3Values(2, 2, 1);
      await tester.pumpAndSettle();
      await tester.drag(find.byType(InteractiveViewer), const Offset(-35, -20));
      await tester.pumpAndSettle();
      expect(s.inputs, isEmpty);
      final fit = find.widgetWithText(TextButton, 'Fit to view');
      await reach(tester, fit);
      await tester.tap(fit);
      await tester.pumpAndSettle();
      expect(viewer.transformationController!.value.getMaxScaleOnAxis(), 1);
      await reach(tester, picture);
      await tester.tapAt(tester.getCenter(picture));
      await waitFor(tester, () => s.inputs.length == 1 && !c.busy);
      expect(s.inputs.single['x'], 400);
      expect(s.inputs.single['y'], 200);
      expect(tester.takeException(), isNull);
      await tester.runAsync(c.end);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'leaving foreground clears typed text and releases original lease without input',
    (tester) async {
      final png = await tester.runAsync(computerPng);
      final s = ComputerServer(png!);
      final actual = await fixture(s.handle);
      actual.scope.data = s.data;
      await tester.pumpWidget(
        testApp(ComputerScreen(scope: actual.scope, agentId: 'bot-a')),
      );
      final c = current(tester);
      await waitFor(tester, () => c.canStart);
      await tester.runAsync(c.start);
      await tester.pumpAndSettle();
      final text = find.byKey(const ValueKey('computer-text'));
      await waitFor(tester, () => c.canInput);
      await tester.scrollUntilVisible(
        text,
        220,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await reach(tester, text);
      await tester.pumpAndSettle();
      await tester.enterText(text, 'Never sent');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await waitFor(tester, () => s.ends == 1 && c.lease == null);
      expect(s.inputs, isEmpty);
      expect(c.frame, isNull);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(c.canInput, false);
      await tester.pumpWidget(const SizedBox());
      actual.scope.dispose();
      actual.session.dispose();
    },
  );
  testWidgets(
    'Bot settings links to the real computer screen without allocating',
    (tester) async {
      final png = await tester.runAsync(computerPng);
      final s = ComputerServer(png!);
      final f = await fixture(s.handle);
      f.scope.data = s.data;
      await tester.pumpWidget(
        testApp(
          BotSettings(scope: f.scope, bot: f.scope.items('agents').first),
        ),
      );
      final entry = find.widgetWithText(ListTile, 'Computer');
      await tester.scrollUntilVisible(
        entry,
        250,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await reach(tester, entry);
      await tester.pumpAndSettle();
      await tester.tap(entry);
      await waitFor(
        tester,
        () =>
            find.byType(ComputerScreen).evaluate().isNotEmpty &&
            !current(tester).busy &&
            current(tester).frame != null,
      );
      expect(s.starts, 0);
      expect(s.requests.where((r) => r.method != 'GET'), isEmpty);
      expect(jsonEncode(f.secrets.values), isNot(contains('lease-original')));
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
