import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/teaching/teaching_controller.dart';
import 'package:openbot_mobile/features/teaching/teaching_panel.dart';

import 'computer_support.dart';
import 'model_profiles_layout_test.dart' show expectReadableText;
import 'support.dart';
import 'teaching_support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'teaching review fits a phone and requires explicit save in $language',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final png = await tester.runAsync(computerPng);
        final server = TeachingServer(ComputerServer(png!));
        final record = teachingExample();
        server.records[record['id']] = record;
        final f = await fixture(server.handle);
        f.scope.data = server.computer.data;
        final computer = ComputerController(f.scope, 'bot-a');
        final c = TeachingController(computer);
        unawaited(c.initialize());
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: SingleChildScrollView(child: TeachingPanel(controller: c)),
            ),
            locale: Locale(language),
          ),
        );
        await waitFor(tester, () => c.ready && !c.busy);
        unawaited(c.select(record));
        await waitFor(tester, () => c.record?['id'] == record['id'] && !c.busy);
        expect(server.reviews, 0);
        expect(server.generates, 0);
        final goal = find.byType(TextFormField).first;
        await tester.ensureVisible(goal);
        await tester.enterText(goal, 'Synthetic phone teaching goal');
        final save = find.widgetWithText(
          OutlinedButton,
          language == 'en' ? 'Save reviewed steps' : '保存核对后的步骤',
        );
        await tester.ensureVisible(save);
        await tester.pumpAndSettle();
        expect(server.reviews, 0);
        await tester.tap(save);
        await waitFor(tester, () => server.reviews == 1 && !c.busy);
        expect(c.dirty, false);
        final dropdown = find.byType(DropdownButtonFormField<String>);
        await tester.ensureVisible(dropdown);
        await tester.tap(dropdown);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Synthetic test model').last);
        await tester.pumpAndSettle();
        final generate = find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Generate a skill draft' : '生成技能草稿',
        );
        await tester.ensureVisible(generate);
        await tester.pumpAndSettle();
        expect(tester.widget<FilledButton>(generate).onPressed, isNotNull);
        await tester.tap(generate);
        await tester.pumpAndSettle();
        expect(
          server.generates,
          0,
          reason: 'Confirmation is a separate action',
        );
        final dialog = find.byType(AlertDialog);
        await tester.tap(
          find.descendant(of: dialog, matching: find.byType(TextButton)),
        );
        await tester.pumpAndSettle();
        expect(server.generates, 0);
        await tester.tap(generate);
        await tester.pumpAndSettle();
        final revision = requestId();
        server.records[record['id']]!['revision'] = revision;
        unawaited(c.check());
        await waitFor(
          tester,
          () => c.record?['revision'] == revision && !c.busy,
        );
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(FilledButton),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          server.generates,
          0,
          reason: 'A changed review invalidates the open confirmation',
        );
        for (final paragraph in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(paragraph.text);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        computer.dispose();
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
  testWidgets('members see the owner explanation without requesting records', (
    tester,
  ) async {
    var requests = 0;
    final f = await fixture((_) async {
      requests++;
      return jsonResponse({});
    });
    f.scope.data = bootstrap(
      agents: [
        {'id': 'bot-a'},
      ],
    );
    f.session.workspace!['role'] = 'member';
    final computer = ComputerController(f.scope, 'bot-a');
    final teaching = TeachingController(computer);
    unawaited(teaching.initialize());
    await tester.pumpWidget(
      testApp(Scaffold(body: TeachingPanel(controller: teaching))),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Only the workspace owner can record a teaching session.'),
      findsOneWidget,
    );
    expect(find.byType(FilledButton), findsNothing);
    expect(requests, 0);
    await tester.pumpWidget(const SizedBox());
    teaching.dispose();
    computer.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
