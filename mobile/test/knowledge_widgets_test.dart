import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor_controller.dart';
import 'package:openbot_mobile/features/bots/knowledge_screen.dart';
import 'package:openbot_mobile/features/bots/memory_import_controller.dart';
import 'package:openbot_mobile/features/bots/memory_import_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;
import 'model_profiles_layout_test.dart' show expectReadableText;

void phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void readable(WidgetTester tester) {
  expect(tester.takeException(), isNull);
  for (final paragraph in tester.renderObjectList<RenderParagraph>(
    find.byType(RichText),
  )) {
    expectReadableText(paragraph.text);
  }
}

void main() {
  testWidgets(
    'a workflow fills the skill editor and submits only a proposed version',
    (tester) async {
      phone(tester);
      final writes = <String>[];
      final snapshot = bootstrap(
        agents: [
          {'id': 'bot-a'},
        ],
      );
      final value = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(snapshot);
        writes.add(request.url.path);
        final draft = jsonDecode(request.body) as Json;
        expect(draft['agentId'], 'bot-a');
        expect(draft['name'], 'Issue triage');
        expect(draft['content'], contains('Ask before creating'));
        return jsonResponse({
          ...draft,
          'id': 'skill-a',
          'status': 'proposed',
          'version': 1,
        });
      });
      value.scope.data = snapshot;
      await tester.pumpWidget(
        testApp(
          KnowledgeScreen(scope: value.scope, agentId: 'bot-a', kind: 'skills'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add'));
      final template = find.widgetWithText(
        OutlinedButton,
        'Start from a workflow template',
      );
      await waitFor(
        tester,
        () =>
            template.evaluate().isNotEmpty &&
            tester.widget<OutlinedButton>(template).onPressed != null,
      );
      await tester.tap(template);
      await waitFor(
        tester,
        () => find.text('Systematic debugging').evaluate().isNotEmpty,
      );
      final sheet = find.byType(BottomSheet);
      await tester.scrollUntilVisible(
        find.text('Issue triage'),
        120,
        scrollable: find.descendant(
          of: sheet,
          matching: find.byType(Scrollable),
        ),
      );
      await tester.tap(find.text('Issue triage'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        'Issue triage',
      );
      expect(writes, isEmpty);
      final submit = find.widgetWithText(FilledButton, 'Submit for review');
      await tester.pumpAndSettle();
      final model =
          (tester.state(find.byType(KnowledgeEditor)) as dynamic).model
              as KnowledgeEditorController;
      await tester.tap(submit);
      await waitFor(tester, () => model.accepted != null && !model.busy);
      expect(find.byType(KnowledgeEditor), findsNothing);
      expect(writes, ['/api/workspaces/space-a/skills']);
      readable(tester);
      await tester.pumpWidget(const SizedBox());
      value.scope.dispose();
      value.session.dispose();
    },
  );

  for (final language in ['en', 'zh']) {
    testWidgets(
      'memory editor fits a phone and explicitly saves in $language',
      (tester) async {
        phone(tester);
        Json? submitted;
        final value = await fixture((request) async {
          if (request.method == 'GET') {
            return jsonResponse(
              bootstrap(
                agents: [
                  {'id': 'bot-a'},
                ],
              ),
            );
          }
          submitted = jsonDecode(request.body) as Json;
          return jsonResponse({...submitted!, 'id': 'memory-a'});
        });
        value.scope.data = bootstrap(
          agents: [
            {'id': 'bot-a'},
          ],
        );
        await tester.pumpWidget(
          testApp(
            KnowledgeScreen(
              scope: value.scope,
              agentId: 'bot-a',
              kind: 'memories',
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip(language == 'en' ? 'Add' : '新增'));
        await waitFor(
          tester,
          () => find.byType(KnowledgeEditor).evaluate().isNotEmpty,
        );
        final model =
            (tester.state(find.byType(KnowledgeEditor)) as dynamic).model
                as KnowledgeEditorController;
        await waitFor(tester, () => model.ready);
        expect(submitted, isNull);
        await tester.enterText(
          find.byType(TextField),
          'Synthetic reviewed preference',
        );
        final save = find.widgetWithText(
          FilledButton,
          language == 'en' ? 'Save' : '保存',
        );
        await tester.ensureVisible(save);
        await tester.pumpAndSettle();
        readable(tester);
        await tester.tap(save);
        await waitFor(tester, () => model.accepted != null && !model.busy);
        expect(find.byType(KnowledgeEditor), findsNothing);
        expect(submitted?['agentId'], 'bot-a');
        expect(submitted?['content'], 'Synthetic reviewed preference');
        readable(tester);
        await tester.pumpWidget(const SizedBox());
        value.scope.dispose();
        value.session.dispose();
      },
    );

    testWidgets('import stays unavailable without a model in $language', (
      tester,
    ) async {
      phone(tester);
      var posts = 0;
      final value = await fixture((request) async {
        if (request.method == 'POST') posts++;
        return jsonResponse({
          'available': false,
          'primary': {'agentId': null, 'revision': 'unset'},
          'reason': 'primary_required',
          'modelConfigured': false,
        });
      });
      await tester.pumpWidget(
        testApp(
          MemoryImportScreen(scope: value.scope),
          locale: Locale(language),
        ),
      );
      final model =
          (tester.state(find.byType(MemoryImportScreen)) as dynamic).model
              as MemoryImportController;
      await waitFor(tester, () => model.ready && !model.busy);
      final submit = find.widgetWithText(
        FilledButton,
        language == 'en' ? 'Review and import' : '核对并导入',
      );
      await tester.ensureVisible(submit);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, false);
      expect(posts, 0);
      readable(tester);
      await tester.pumpWidget(const SizedBox());
      value.scope.dispose();
      value.session.dispose();
    });
  }
}
