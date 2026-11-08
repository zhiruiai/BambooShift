import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/bot_creation_preview.dart';
import 'package:openbot_mobile/features/bots/bot_draft_screen.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';

import 'creation_controller_test.dart' show receipt;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _profile = {
  'name': 'Draft reviewer',
  'role': 'Review reports',
  'description': 'Check report claims against the supplied sources.',
  'instructions': 'Return a list of issues with the source for each issue.',
  'avatar': 'leaf',
  'color': '#496FAB',
  'avatarImageId': null,
};
const _draft = {'kind': 'bot', 'profile': _profile};

Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  test(
    'Bot previews accept only a valid profile without an uploaded image',
    () {
      expect(botCreationPreview(_draft)?['color'], '#496fab');
      for (final value in [
        {..._draft, 'instructions': 'extra envelope key'},
        {'kind': 'theme', 'profile': _profile},
        for (final invalid in [
          {'name': ' '},
          {'avatar': 'unknown'},
          {'color': 'red'},
          {'avatarImageId': 'foreign-asset'},
          {'instructions': '\x00'},
          {
            'tools': ['shell'],
          },
        ])
          {
            'kind': 'bot',
            'profile': {..._profile, ...invalid},
          },
      ]) {
        expect(botCreationPreview(value), isNull);
      }
    },
  );

  for (final labels in [
    (
      language: 'en',
      title: 'Draft a Bot with AI',
      brief: 'Review work reports',
      generate: 'Generate preview',
      instructions: 'Working instructions',
      use: 'Edit this draft',
      replace: 'Replace the unsaved Bot profile with this draft?',
      done: 'Done',
      create: 'Create',
    ),
    (
      language: 'zh-CN',
      title: '智能起草 Bot',
      brief: '审阅工作报告',
      generate: '生成预览',
      instructions: '工作方式',
      use: '编辑这份草稿',
      replace: '用这份草稿替换尚未保存的 Bot 资料？',
      done: '完成',
      create: '创建',
    ),
  ]) {
    testWidgets('narrow ${labels.language} Bot draft edits before creation', (
      tester,
    ) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(320, 620);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final previews = <Json>[];
      final creates = <Json>[];
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'GET') {
          expect(request.url.path, '/api/workspaces/space-a/bootstrap');
          return jsonResponse(bootstrap());
        }
        final body = jsonDecode(request.body) as Json;
        switch (request.url.path) {
          case '/api/workspaces/space-a/creation-preview':
            previews.add(body);
            return jsonResponse(_draft);
          case '/api/workspaces/space-a/creation-requests':
            creates.add(body);
            return jsonResponse(receipt(body));
        }
        throw StateError('Unexpected request: ${request.url.path}');
      });
      f.session.api.language = labels.language;
      f.scope.data!['settings'] = {'configured': true};
      String? conversation;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  conversation = await Navigator.push<String>(
                    context,
                    MaterialPageRoute<String>(
                      builder: (_) => CreateScreen(scope: f.scope, kind: 'bot'),
                    ),
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
          locale: Locale(labels.language == 'en' ? 'en' : 'zh'),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final name = find.byType(TextFormField).first;
      await tester.enterText(name, 'Previous unsaved name');
      await _tap(tester, find.text(labels.title));
      expect(previews, isEmpty);
      await tester.enterText(find.byType(TextField), labels.brief);
      await tester.pump();
      await tester.tap(find.text(labels.generate));
      await waitFor(
        tester,
        () => find.text('Draft reviewer').evaluate().isNotEmpty,
      );
      expect(previews, [
        {'kind': 'bot', 'brief': labels.brief, 'language': labels.language},
      ]);
      expect(creates, isEmpty);
      await _tap(tester, find.text(labels.instructions));
      expect(find.text(_profile['instructions']!), findsOneWidget);
      await _tap(tester, find.text(labels.use));
      expect(find.text(labels.replace), findsOneWidget);
      await tester.tap(find.text(labels.done));
      await tester.pumpAndSettle();
      expect(find.text('Previous unsaved name'), findsNothing);
      expect(find.text('Draft reviewer'), findsOneWidget);
      expect(creates, isEmpty);
      await tester.enterText(name, 'Reviewed name');
      await _tap(tester, find.text(labels.create));
      await waitFor(tester, () => conversation != null);
      expect(conversation, 'new-chat');
      expect(creates.single['profile'], {
        ..._profile,
        'color': '#496fab',
        'name': 'Reviewed name',
      });
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }

  testWidgets('no preview request runs without model or workspace ownership', (
    tester,
  ) async {
    var calls = 0;
    final f = await fixture((_) async {
      calls++;
      return jsonResponse(_draft);
    });
    await tester.pumpWidget(testApp(BotDraftScreen(scope: f.scope)));
    await tester.enterText(find.byType(TextField), 'Create a reviewer');
    await tester.pump();
    final generate = find.widgetWithText(OutlinedButton, 'Generate preview');
    expect(tester.widget<OutlinedButton>(generate).onPressed, isNull);
    expect(
      find.text(
        'Connect a model in this workspace to generate a profile draft.',
      ),
      findsOneWidget,
    );
    f.session.workspace!['role'] = 'member';
    f.session.notifyListeners();
    await tester.pumpAndSettle();
    expect(generate, findsNothing);
    expect(calls, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('an in-flight draft is invalidated by loss of ownership', (
    tester,
  ) async {
    final gate = Completer<http.Response>();
    var requested = false;
    final f = await fixture((_) {
      requested = true;
      return gate.future;
    });
    f.scope.data!['settings'] = {'configured': true};
    await tester.pumpWidget(testApp(BotDraftScreen(scope: f.scope)));
    await tester.enterText(find.byType(TextField), 'Create a reviewer');
    await tester.pump();
    await tester.tap(find.text('Generate preview'));
    for (var i = 0; i < 100 && !requested; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
    }
    expect(requested, isTrue);
    f.session.workspace!['role'] = 'member';
    f.session.notifyListeners();
    gate.complete(jsonResponse(_draft));
    await tester.runAsync(() => gate.future);
    await tester.pumpAndSettle();
    expect(find.text('Draft reviewer'), findsNothing);
    expect(find.text('Edit this draft'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
