import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor_controller.dart';
import 'package:openbot_mobile/features/bots/skill_file_import.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _skill = '''
---
name: " Research brief "
description: >-
  Summarize evidence
  with source links.
allowed-tools: Read Bash
metadata:
  version: '1.0'
---
# Prepare the brief

Check the original sources.
''';

XFile _file(String body, {String name = 'SKILL.md'}) => XFile.fromData(
  Uint8List.fromList(utf8.encode(body)),
  path: name,
  name: name,
);

Finder _field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);

String _value(WidgetTester tester, String label) =>
    tester.widget<TextField>(_field(label)).controller!.text;

Future<void> _awaitImport(WidgetTester tester, Finder button) => waitFor(
  tester,
  () =>
      button.evaluate().isNotEmpty &&
      tester.widget<OutlinedButton>(button).onPressed != null,
);

void main() {
  test('reads strict UTF-8 BOM and CRLF, only returning the three fields', () {
    final bytes = utf8.encode('\ufeff${_skill.replaceAll('\n', '\r\n')}');
    expect(parseSkillMarkdown(bytes), (
      name: 'Research brief',
      description: 'Summarize evidence with source links.',
      content: '# Prepare the brief\n\nCheck the original sources.',
    ));
    expect(
      parseSkillMarkdown(
        utf8.encode(_skill.replaceFirst('Read Bash', '"*literal &literal"')),
      ).name,
      'Research brief',
    );
  });

  test('rejects invalid YAML, expansion and out-of-range fields', () {
    final documents = [
      _skill.replaceFirst('---\n', '-- \n'),
      _skill.replaceFirst('---\n#', '--- \n#'),
      _skill.replaceFirst('name: " Research brief "', 'name: true'),
      _skill.replaceFirst('name: " Research brief "', 'name: "A\\nB"'),
      _skill.replaceFirst('name: " Research brief "', 'name: ${'x' * 101}'),
      _skill.replaceFirst('name: " Research brief "', 'name: ${'🐣' * 51}'),
      _skill.replaceFirst('name: " Research brief "', 'name: A\n"name": B'),
      _skill
          .replaceFirst('name: " Research brief "', 'name: &label A')
          .replaceFirst('allowed-tools: Read Bash', 'allowed-tools: *label'),
      _skill.replaceFirst(
        'allowed-tools: Read Bash',
        'allowed-tools: [*label]',
      ),
      '---\n- name: test\n---\nTest',
      '---\nname: test\ndescription: test\n---\n',
      '---\nname: test\ndescription: [a]\n---\nTest',
      '---\nname: test\ndescription: ${'x' * 1001}\n---\nTest',
      '---\nname: test\ndescription: test\n---\n${'x' * 16001}',
    ];
    for (final document in documents) {
      expect(
        () => parseSkillMarkdown(utf8.encode(document)),
        throwsFormatException,
      );
    }
    expect(() => parseSkillMarkdown([0xff]), throwsFormatException);
    expect(
      () => parseSkillMarkdown(List.filled(skillFileMaxBytes + 1, 0x61)),
      throwsFormatException,
    );
    final body = 'x' * 16000;
    expect(
      parseSkillMarkdown(
        utf8.encode('---\nname: test\ndescription: test\n---\n$body'),
      ).content,
      body,
    );
  });

  for (final language in ['en', 'zh']) {
    testWidgets('320dp $language import edits a draft before a proposed save', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final english = language == 'en';
      final snapshot = bootstrap(
        agents: [
          {'id': 'bot-a'},
        ],
      );
      final posts = <Json>[];
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(snapshot);
        expect(request.method, 'POST');
        expect(request.url.path, '/api/workspaces/space-a/skills');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        final body = jsonDecode(request.body) as Json;
        posts.add(body);
        return jsonResponse({...body, 'id': 'skill-a', 'status': 'proposed'});
      });
      f.scope.data = snapshot;
      await tester.pumpWidget(
        testApp(
          Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.push<void>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => KnowledgeEditor(
                      scope: f.scope,
                      agentId: 'bot-a',
                      kind: 'skills',
                      pickSkillFile: () async => _file(_skill),
                    ),
                  ),
                ),
                child: const Text('Open editor'),
              ),
            ),
          ),
          locale: Locale(language),
        ),
      );
      await tester.tap(find.text('Open editor'));
      final import = find.widgetWithText(
        OutlinedButton,
        english ? 'Import SKILL.md' : '导入 SKILL.md',
      );
      await _awaitImport(tester, import);
      final name = english ? 'Skill name' : '技能名称';
      final description = english ? 'About this Bot' : '关于这个 Bot';
      await tester.tap(import);
      final preview = find.textContaining(
        english ? 'Review the imported name' : '提交前请核对导入的',
      );
      await waitFor(tester, () => preview.evaluate().isNotEmpty);
      expect(import, findsNothing);
      await tester.scrollUntilVisible(
        _field(description),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(_value(tester, name), 'Research brief');
      expect(
        _value(tester, description),
        'Summarize evidence with source links.',
      );
      expect(posts, isEmpty);
      await tester.ensureVisible(_field(name));
      await tester.enterText(_field(name), 'Edited research brief');
      await tester.pumpAndSettle();
      expect(_value(tester, name), 'Edited research brief');
      final submit = find.widgetWithText(
        FilledButton,
        english ? 'Submit for review' : '提交审核',
      );
      final model =
          (tester.state(find.byType(KnowledgeEditor)) as dynamic).model
              as KnowledgeEditorController;
      expect(submit.hitTestable(), findsOneWidget);
      expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
      await tester.tap(submit);
      await waitFor(
        tester,
        () => (model.accepted != null && !model.busy) || model.error != null,
      );
      expect(model.error, isNull);
      expect(find.byType(KnowledgeEditor), findsNothing);
      expect(posts, [
        {
          'agentId': 'bot-a',
          'name': 'Edited research brief',
          'description': 'Summarize evidence with source links.',
          'content': '# Prepare the brief\n\nCheck the original sources.',
        },
      ]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }

  testWidgets(
    'cancel, read failure and late import preserve the manual draft',
    (tester) async {
      final f = await fixture((_) async {
        fail('Opening a local document must not send a request.');
      });
      f.scope.data = bootstrap(
        agents: [
          {'id': 'bot-a'},
        ],
      );
      final pending = Completer<XFile?>();
      var count = 0;
      await tester.pumpWidget(
        testApp(
          KnowledgeEditor(
            scope: f.scope,
            agentId: 'bot-a',
            kind: 'skills',
            pickSkillFile: () async {
              switch (++count) {
                case 1:
                  return null;
                case 2:
                  throw StateError('Synthetic file read failure');
                default:
                  return pending.future;
              }
            },
          ),
        ),
      );
      final import = find.widgetWithText(OutlinedButton, 'Import SKILL.md');
      await _awaitImport(tester, import);
      await tester.tap(import);
      await _awaitImport(tester, import);
      expect(_value(tester, 'Skill name'), isEmpty);
      await tester.tap(import);
      await _awaitImport(tester, import);
      expect(
        find.text('This skill file could not be read. Choose it again.'),
        findsOneWidget,
      );
      await tester.tap(import);
      await tester.pumpAndSettle();
      await tester.enterText(_field('Skill name'), 'Keep my draft');
      expect(_value(tester, 'Skill name'), 'Keep my draft');
      pending.complete(_file(_skill));
      await tester.pumpAndSettle();
      expect(_value(tester, 'Skill name'), 'Keep my draft');
      expect(import, findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('workspace changes discard an outstanding file selection', (
    tester,
  ) async {
    final f = await fixture((_) async {
      fail('Stale local selection must not send a request.');
    });
    final workspace = f.session.workspace;
    f.scope.data = bootstrap(
      agents: [
        {'id': 'bot-a'},
      ],
    );
    final pending = Completer<XFile?>();
    await tester.pumpWidget(
      testApp(
        KnowledgeEditor(
          scope: f.scope,
          agentId: 'bot-a',
          kind: 'skills',
          pickSkillFile: () => pending.future,
        ),
      ),
    );
    final import = find.widgetWithText(OutlinedButton, 'Import SKILL.md');
    await _awaitImport(tester, import);
    await tester.tap(import);
    f.session.selectWorkspace(null);
    f.session.selectWorkspace(workspace);
    pending.complete(_file(_skill));
    await _awaitImport(tester, import);
    expect(_value(tester, 'Skill name'), isEmpty);
    f.session.workspace!['role'] = 'member';
    f.session.selectWorkspace(workspace);
    await tester.pumpAndSettle();
    expect(import, findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
