import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/features/bot_library/library_screen.dart';
import 'package:openbot_mobile/features/collaboration/team_editor.dart';
import 'package:openbot_mobile/features/collaboration/team_pending.dart';
import 'package:openbot_mobile/features/collaboration/team_plans_screen.dart';

import 'collaboration_support.dart' show originalRequest, plan, revision2;
import 'library_support.dart';
import 'library_widgets_test.dart' show waitForLibrary;
import 'support.dart';
import 'widgets_test.dart' show testApp;

const _workspace = '/api/workspaces/space-a';
const _templates = '$_workspace/bot-team-templates';
const _plans = '$_workspace/bot-team-plans';

class _LibraryTeamServer {
  _LibraryTeamServer({this.member = false, this.teamSpace = false});

  final bool member, teamSpace;
  final library = LibraryServer();
  final requests = <http.Request>[];
  final catalog =
      jsonDecode(
            File('../shared/team-starter-templates.json').readAsStringSync(),
          )
          as Json;
  Future<void>? delayCatalog;
  Json? saved;

  List<http.Request> get writes =>
      requests.where((request) => request.method == 'POST').toList();

  List<Json> rows(String language) => (catalog[language] as List).cast<Json>();

  Json get account {
    final result = libraryAccount();
    final workspaces = (result['workspaces'] as List).cast<Json>();
    return {
      ...result,
      'workspaces': [
        {
          ...workspaces.first,
          'kind': teamSpace || member ? 'team' : 'personal',
          'role': member ? 'member' : 'owner',
        },
        ...workspaces.skip(1),
      ],
    };
  }

  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    final path = request.url.path;
    if (path == '/api/account/session') return jsonResponse(account);
    if (path == _templates && request.method == 'GET') {
      final language = request.headers['accept-language']!;
      await delayCatalog;
      return jsonResponse(rows(language));
    }
    if (path == _plans && request.method == 'GET') {
      final id = request.url.queryParameters['requestId'];
      return jsonResponse([
        if (saved != null && (id == null || id == saved!['requestId'])) saved,
      ]);
    }
    if (path == _plans && request.method == 'POST') {
      final body = jsonDecode(request.body) as Json;
      final selection = body['template'] as Json;
      final starter = rows(
        selection['language'] as String,
      ).singleWhere((row) => row['id'] == selection['id']);
      saved = {
        ...plan(),
        'requestId': body['requestId'],
        'goal': body['goal'],
        'draft': starter['draft'],
      };
      return jsonResponse(saved!, status: 202);
    }
    return library.handle(request);
  }
}

void _viewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _until(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready(), isTrue);
}

Future<void> _openLibraryTemplates(WidgetTester tester, String label) async {
  final entry = find.descendant(
    of: find.byType(BotLibraryScreen),
    matching: find.widgetWithText(OutlinedButton, label),
  );
  await waitForLibrary(
    tester,
    () =>
        entry.evaluate().isNotEmpty &&
        tester.widget<OutlinedButton>(entry).onPressed != null,
  );
  await tester.ensureVisible(entry);
  await tester.tap(entry);
  await tester.pump();
}

void main() {
  for (final english in [false, true]) {
    final language = english ? 'en' : 'zh-CN';
    final locale = Locale(english ? 'en' : 'zh');
    final width = english ? 390.0 : 320.0;
    final entry = english ? 'Team templates' : '团队模板';
    final load = english ? 'Load plan and edit' : '载入方案并编辑';
    testWidgets(
      '$width $language library previews and loads only an editable team draft',
      (tester) async {
        _viewport(tester, Size(width, english ? 844 : 600));
        final server = _LibraryTeamServer(teamSpace: !english);
        final f = await fixture(server.handle);
        await f.session.preferences(language: locale);
        await tester.pumpWidget(
          testApp(BotLibraryScreen(scope: f.scope), locale: locale),
        );

        await _openLibraryTemplates(tester, entry);
        final chooser = find.byType(AlertDialog);
        final rows = server.rows(language);
        final starter = rows.firstWhere((row) => row['id'] == 'launch');
        final draft = starter['draft'] as Json;
        final title = draft['title'] as String;
        final summary = draft['summary'] as String;
        final option = find.descendant(of: chooser, matching: find.text(title));
        await waitForLibrary(tester, () => option.evaluate().isNotEmpty);
        expect(tester.getSize(chooser).width, lessThanOrEqualTo(width));
        for (final row in rows) {
          expect(
            find.descendant(
              of: chooser,
              matching: find.text(row['draft']['title'] as String),
            ),
            findsOneWidget,
          );
        }
        expect(server.writes, isEmpty);

        await tester.tap(option);
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: chooser, matching: find.text(summary)),
          findsOneWidget,
        );
        for (final member in (draft['members'] as List).cast<Json>()) {
          expect(
            find.descendant(
              of: chooser,
              matching: find.text(member['name'] as String),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: chooser,
              matching: find.text(member['assignment'] as String),
            ),
            findsOneWidget,
          );
        }
        expect(server.writes, isEmpty);
        final loadButton = find.descendant(
          of: chooser,
          matching: find.widgetWithText(FilledButton, load),
        );
        await tester.ensureVisible(loadButton);
        await tester.tap(loadButton);

        final editor = find.byType(TeamEditor);
        await waitForLibrary(tester, () => editor.evaluate().isNotEmpty);
        final read = server.requests.singleWhere(
          (request) => request.url.path == _templates,
        );
        expect(read.headers['x-openbot-expected-user'], 'user-a');
        expect(read.headers['accept-language'], language);
        final write = server.writes.single;
        expect(write.url.path, _plans);
        expect(write.headers['x-openbot-expected-user'], 'user-a');
        final body = jsonDecode(write.body) as Json;
        expect(isRequestId(body['requestId']), isTrue);
        expect(body['goal'], summary);
        expect(body['template'], {'id': starter['id'], 'language': language});
        expect(server.saved?['draft'], draft);
        expect(server.saved?['status'], 'ready');

        final groupName = find.descendant(
          of: editor,
          matching: find.byWidgetPredicate(
            (widget) => widget is TextFormField && widget.initialValue == title,
          ),
        );
        await tester.ensureVisible(groupName);
        await tester.enterText(groupName, '$title 2');
        await tester.pump();
        expect(
          find.descendant(of: editor, matching: find.text('$title 2')),
          findsOneWidget,
        );
        expect(server.writes, [write]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets(
    'member in the current space cannot enter templates using ownership elsewhere',
    (tester) async {
      final server = _LibraryTeamServer(member: true);
      final f = await fixture(server.handle);
      f.session.workspaces = (server.account['workspaces'] as List)
          .cast<Json>();
      f.session.selectWorkspace(f.session.workspaces.first);
      await tester.pumpWidget(testApp(BotLibraryScreen(scope: f.scope)));
      await waitForLibrary(
        tester,
        () => server.requests.any(
          (request) => request.url.path == '/api/bot-template-gallery',
        ),
      );

      expect(f.scope.owner, isFalse);
      expect(
        f.session.workspaces.any((workspace) => workspace['role'] == 'owner'),
        isTrue,
      );
      expect(find.text('Team templates'), findsNothing);
      expect(
        server.requests.where(
          (request) => request.url.path.startsWith('$_workspace/bot-team-'),
        ),
        isEmpty,
      );
      expect(server.writes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('switching workspaces discards a delayed team template catalog', (
    tester,
  ) async {
    final delayed = Completer<void>();
    final server = _LibraryTeamServer()..delayCatalog = delayed.future;
    final f = await fixture(server.handle);
    await tester.pumpWidget(testApp(BotLibraryScreen(scope: f.scope)));
    await _openLibraryTemplates(tester, 'Team templates');
    await _until(
      tester,
      () => server.requests.any((request) => request.url.path == _templates),
    );
    expect(find.byType(AlertDialog), findsOneWidget);

    f.session.selectWorkspace(
      f.session.workspaces.singleWhere(
        (workspace) => workspace['id'] == 'space-b',
      ),
    );
    await tester.pump();
    delayed.complete();
    await tester.pumpAndSettle();
    expect(f.scope.active, isFalse);
    expect(find.text('Product Launch Team'), findsNothing);
    expect(find.text('Load plan and edit'), findsNothing);
    expect(server.writes, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('changing language invalidates the opened template preview', (
    tester,
  ) async {
    final server = _LibraryTeamServer();
    final f = await fixture(server.handle);
    await f.session.preferences(language: const Locale('en'));
    await tester.pumpWidget(testApp(BotLibraryScreen(scope: f.scope)));
    await _openLibraryTemplates(tester, 'Team templates');
    final chooser = find.byType(AlertDialog);
    final english = find.descendant(
      of: chooser,
      matching: find.text('Product Launch Team'),
    );
    await waitForLibrary(tester, () => english.evaluate().isNotEmpty);
    await tester.tap(english);
    await tester.pumpAndSettle();
    expect(find.text('Load plan and edit'), findsOneWidget);

    await f.session.preferences(language: const Locale('zh'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'The language changed. Reopen team templates to preview them again.',
      ),
      findsOneWidget,
    );
    expect(english, findsNothing);
    expect(find.text('Load plan and edit'), findsNothing);
    expect(server.writes, isEmpty);

    await tester.tap(
      find.descendant(of: chooser, matching: find.text('Cancel')),
    );
    await tester.pumpAndSettle();
    final team = find.byType(TeamPlansScreen);
    await tester.tap(
      find.descendant(
        of: team,
        matching: find.widgetWithText(OutlinedButton, 'Team templates'),
      ),
    );
    final chinese = find.descendant(of: chooser, matching: find.text('产品发布小组'));
    await waitForLibrary(tester, () => chinese.evaluate().isNotEmpty);
    expect(
      server.requests
          .where((request) => request.url.path == _templates)
          .map((request) => request.headers['accept-language']),
      ['en', 'zh-CN'],
    );
    expect(server.writes, isEmpty);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'library team entry checks unresolved creation before offering a new template',
    (tester) async {
      final server = _LibraryTeamServer();
      final f = await fixture(server.handle);
      final key = TeamPending(f.scope).key;
      final marker = jsonEncode({
        'version': 1,
        'kind': 'start',
        'operationId': revision2,
        'requestId': originalRequest,
      });
      f.secrets.values[key] = marker;
      await tester.pumpWidget(testApp(BotLibraryScreen(scope: f.scope)));
      await _openLibraryTemplates(tester, 'Team templates');
      await waitForLibrary(
        tester,
        () => server.requests.any(
          (request) =>
              request.method == 'GET' &&
              request.url.path == _plans &&
              request.url.queryParameters['requestId'] == originalRequest,
        ),
      );

      expect(find.byType(TeamPlansScreen), findsOneWidget);
      expect(
        find.textContaining('The submission is unconfirmed.'),
        findsWidgets,
      );
      expect(find.byType(AlertDialog), findsNothing);
      expect(
        server.requests.where((request) => request.url.path == _templates),
        isEmpty,
      );
      expect(server.writes, isEmpty);
      expect(f.secrets.values[key], marker);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
