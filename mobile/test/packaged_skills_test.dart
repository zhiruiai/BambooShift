import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/connections_list.dart';
import 'package:openbot_mobile/features/apps/packaged_skills_screen.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor.dart';
import 'package:openbot_mobile/features/bots/knowledge_screen.dart';
import 'package:openbot_mobile/features/bots/skill_recipe_picker.dart';
import 'package:openbot_mobile/features/chat/chat_markdown.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

const _local = {'id': 'bot-a', 'name': 'Local Fixture Bot'};
const _shared = {
  'id': 'bot-shared',
  'name': 'Shared Fixture Bot',
  'sharedBot': {'status': 'active'},
};

void _narrow(WidgetTester tester, double width) {
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = Size(width, 670);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

Finder _choice() => find.byType(DropdownButtonFormField<String>);

Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pump();
  await tester.tap(target);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 360));
}

Future<void> waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 150 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready(), isTrue);
  await tester.pump(const Duration(milliseconds: 360));
}

bool _canPress(WidgetTester tester, Finder button) =>
    button.evaluate().isNotEmpty &&
    tester.widget<FilledButton>(button).onPressed != null;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('both locales load the same complete workflow catalog', () async {
    final en = await loadSkillRecipes('en'), zh = await loadSkillRecipes('zh');
    final ids = en.map((item) => item['id']).toSet();
    expect(ids.length, 13);
    expect(
      ids,
      containsAll([
        'product-spec',
        'team-handoff',
        'react-performance',
        'agent-desktop',
      ]),
    );
    expect(zh.map((item) => item['id']), en.map((item) => item['id']));
    for (final recipe in [...en, ...zh]) {
      for (final field in ['name', 'description', 'content']) {
        expect(recipe[field], isA<String>());
        expect((recipe[field] as String).trim(), isNotEmpty);
      }
      expect((recipe['content'] as String).length, greaterThan(100));
    }
  });

  testWidgets('320px apps catalog preview submits only an edited proposal', (
    tester,
  ) async {
    _narrow(tester, 320);
    final recipe = await tester.runAsync(
      () async => (await loadSkillRecipes(
        'zh',
      )).singleWhere((item) => item['id'] == 'issue-triage'),
    );
    final writes = <(String, Json)>[];
    final scopeData = bootstrap(agents: [_local, _shared]);
    final f = await fixture((request) async {
      if (request.method == 'GET') {
        return jsonResponse(
          request.url.path.endsWith('/apps') ? [] : scopeData,
        );
      }
      expect(request.method, 'POST');
      expect(request.url.path, '/api/workspaces/space-a/skills');
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      final body = jsonDecode(request.body) as Json;
      writes.add((request.url.path, body));
      final proposed = {
        ...body,
        'id': 'skill-fixture',
        'status': 'proposed',
        'version': 1,
      };
      scopeData['skills'] = [proposed];
      return jsonResponse(proposed, status: 201);
    });
    f.scope.data = scopeData;
    await tester.pumpWidget(
      testApp(ConnectionsList(scope: f.scope), locale: const Locale('zh')),
    );
    await waitFor(tester, () => find.text('内置技能').evaluate().isNotEmpty);
    await _tap(tester, find.text('内置技能'));
    await waitFor(tester, () => find.byType(TextField).evaluate().isNotEmpty);
    expect(find.text('搜索内置技能'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'no-synthetic-match');
    await tester.pump();
    expect(find.text('没有符合搜索条件的内置技能。'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'issue-triage');
    await tester.pump();
    expect(find.text('系统化排障'), findsNothing);
    await _tap(tester, find.widgetWithText(ListTile, '问题分诊'));
    expect(find.text('预览指令'), findsOneWidget);
    expect(find.text('执行步骤'), findsOneWidget);
    expect(find.text('## 执行步骤'), findsNothing);
    expect(find.textContaining('关闭外部问题前先征求确认。'), findsOneWidget);
    final preview = tester.widget<ChatMarkdown>(find.byType(ChatMarkdown));
    expect(preview.text, recipe!['content']);
    expect(preview.canOpenLink(), isFalse);
    expect(writes, isEmpty);
    final edit = find.widgetWithText(FilledButton, '编辑技能草稿');
    expect(_canPress(tester, edit), isFalse);
    expect(find.text('选择 Bot'), findsOneWidget);
    await _tap(tester, _choice());
    expect(find.text('Shared Fixture Bot'), findsNothing);
    await _tap(tester, find.text('Local Fixture Bot').last);
    expect(_canPress(tester, edit), isTrue);
    await _tap(tester, edit);
    final submit = find.widgetWithText(FilledButton, '提交审核');
    await waitFor(tester, () => _canPress(tester, submit));
    final fields = find.byType(TextField);
    expect(
      tester.widget<TextField>(fields.at(0)).controller!.text,
      recipe['name'],
    );
    expect(
      tester.widget<TextField>(fields.at(1)).controller!.text,
      recipe['description'],
    );
    expect(
      tester.widget<TextField>(fields.at(2)).controller!.text,
      recipe['content'],
    );
    expect(writes, isEmpty);
    await tester.enterText(fields.first, '已核对的工作方式');
    await _tap(tester, submit);
    await waitFor(
      tester,
      () =>
          find.byType(KnowledgeScreen).evaluate().isNotEmpty &&
          find.byType(KnowledgeEditor).evaluate().isEmpty,
    );
    expect(find.byType(KnowledgeEditor), findsNothing);
    expect(find.text('已核对的工作方式'), findsOneWidget);
    expect(writes.single.$2, {
      'agentId': 'bot-a',
      'name': '已核对的工作方式',
      'description': recipe['description'],
      'content': recipe['content'],
    });
    expect((f.scope.items('skills').single)['status'], 'proposed');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    '390px member can read full instructions and stale scope hides it',
    (tester) async {
      _narrow(tester, 390);
      var calls = 0;
      final f = await fixture((_) async {
        calls++;
        return jsonResponse({});
      });
      f.session.workspace = {...f.session.workspace!, 'role': 'member'};
      f.scope.data = bootstrap(agents: [_local]);
      await tester.pumpWidget(testApp(PackagedSkillsScreen(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Systematic debugging').evaluate().isNotEmpty,
      );
      await _tap(tester, find.text('Systematic debugging'));
      expect(find.text('Preview instructions'), findsOneWidget);
      expect(find.text('Workflow'), findsOneWidget);
      expect(find.text('## Workflow'), findsNothing);
      expect(
        find.textContaining(
          'Report the observed result, exact checks and remaining uncertainty.',
        ),
        findsOneWidget,
      );
      expect(
        find.text('Only the workspace owner can submit a skill draft.'),
        findsOneWidget,
      );
      expect(find.text('Edit skill draft'), findsNothing);
      expect(_choice(), findsNothing);
      f.session.user = {'id': 'user-b'};
      f.session.notifyListeners();
      await tester.pump();
      expect(find.byType(ChatMarkdown), findsNothing);
      expect(
        find.text(
          'Your account or space has changed. Open it again to continue.',
        ),
        findsWidgets,
      );
      expect(calls, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('a removed Bot during verification cannot open an editor', (
    tester,
  ) async {
    _narrow(tester, 390);
    final gate = Completer<http.Response>();
    var reads = 0;
    final f = await fixture((request) {
      expect(request.method, 'GET');
      expect(request.url.path.endsWith('/bootstrap'), isTrue);
      reads++;
      return gate.future;
    });
    f.scope.data = bootstrap(agents: [_local]);
    await tester.pumpWidget(testApp(PackagedSkillsScreen(scope: f.scope)));
    await waitFor(
      tester,
      () => find.text('Systematic debugging').evaluate().isNotEmpty,
    );
    await _tap(tester, find.text('Systematic debugging'));
    await _tap(tester, _choice());
    await _tap(tester, find.text('Local Fixture Bot').last);
    final edit = find.widgetWithText(FilledButton, 'Edit skill draft');
    await _tap(tester, edit);
    expect(_canPress(tester, edit), isFalse);
    gate.complete(jsonResponse(bootstrap(agents: [_shared])));
    await waitFor(
      tester,
      () => find
          .text(
            'The Bot could not be verified. Check the current Bot and try again.',
          )
          .evaluate()
          .isNotEmpty,
    );
    expect(find.byType(KnowledgeEditor), findsNothing);
    expect(
      find.text('Create a local Bot in this workspace to use this skill.'),
      findsOneWidget,
    );
    expect(reads, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
