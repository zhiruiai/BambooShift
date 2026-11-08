import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/routine_operation_controller.dart';
import 'package:openbot_mobile/core/routine_operation_data.dart';
import 'package:openbot_mobile/core/routine_public_search.dart';
import 'package:openbot_mobile/features/routines/routine_editor.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_controller.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_data.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'routine_operation_support.dart';
import 'routine_transfer_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const phrases = ['Official release notes', 'Public changelog'];

Json directData({Json? existing, bool group = false, bool shared = false}) =>
    bootstrap(
        agents: [
          {'id': 'bot-a', 'name': 'Example', if (shared) 'sharedBot': null},
        ],
      )
      ..['conversations'][0]['isGroup'] = group
      ..['routines'] = [?existing];

void phone(WidgetTester tester, {bool chinese = false}) {
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = Size(chinese ? 390 : 320, 720);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> reveal(WidgetTester tester, Finder target) async {
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      180,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
  }
  await Scrollable.ensureVisible(tester.element(target), alignment: .6);
  await tester.pumpAndSettle();
}

void main() {
  test('phrases are exact, trimmed and bounded in UTF-16 code units', () {
    expect(normalizeRoutinePublicQueries([]), isEmpty);
    expect(normalizeRoutinePublicQueries(['  Same  ', 'same']), [
      'Same',
      'same',
    ]);
    expect(normalizeRoutinePublicQueries(['😀' * 80]), ['😀' * 80]);
    for (final invalid in [
      null,
      'not an array',
      [2],
      [' '],
      ['a', ' a '],
      ['a\nb'],
      ['😀' * 81],
      ['a', 'b', 'c', 'd', 'e'],
    ]) {
      expect(normalizeRoutinePublicQueries(invalid), isNull);
    }
  });

  testWidgets(
    '320px create validates approved phrases and sends only trimmed ones',
    (tester) async {
      phone(tester);
      Json? sent;
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(directData());
        expect(request.method, 'POST');
        expect(request.url.path, '/api/workspaces/space-a/routine-operations');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        sent = jsonDecode(request.body) as Json;
        return jsonResponse(operationReceipt(sent!), status: 201);
      });
      f.scope.data = directData();
      f.session.workspace!['kind'] = 'team';
      await tester.pumpWidget(
        testApp(RoutineEditor(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Task name'),
        'Public notes',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'What to do'),
        'Summarize public release notes.',
      );
      final toggle = find.widgetWithText(
        SwitchListTile,
        'Allow public web search',
      );
      await reveal(tester, toggle);
      expect(tester.widget<SwitchListTile>(toggle).value, false);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('receives only the approved public phrases'),
        findsOneWidget,
      );
      final input = find.widgetWithText(
        TextFormField,
        'Public search phrases · one per line',
      );
      await reveal(tester, input);
      await tester.enterText(input, 'Duplicate\n Duplicate ');
      final save = find.widgetWithText(FilledButton, 'Save');
      await reveal(tester, save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(sent, isNull);
      expect(
        find.text(
          'Enter 1–4 different public phrases, up to 160 characters each.',
        ),
        findsOneWidget,
      );
      await reveal(tester, input);
      await tester.enterText(
        input,
        '  Official release notes  \n\n Public changelog ',
      );
      await reveal(tester, save);
      await tester.tap(save);
      await waitFor(tester, () => sent != null);
      expect(sent![routinePublicSearchField], phrases);
      expect(sent!.containsKey('expectedRoutine'), false);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  for (final intent in ['preserve', 'clear', 'stale']) {
    testWidgets('390px Chinese edit $intent of public search permission', (
      tester,
    ) async {
      phone(tester, chinese: true);
      final previous = {...routineFixture(), routinePublicSearchField: phrases};
      Json? sent;
      final f = await fixture((request) async {
        if (request.method == 'GET') {
          return jsonResponse(directData(existing: previous));
        }
        expect(request.method, 'PATCH');
        expect(request.url.path, '/api/workspaces/space-a/routines/routine-a');
        sent = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic unknown save');
      });
      f.scope.data = directData(existing: previous);
      await tester.pumpWidget(
        testApp(
          RoutineEditor(scope: f.scope, agentId: 'bot-a', routine: previous),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      final toggle = find.widgetWithText(SwitchListTile, '允许搜索公开网页');
      await reveal(tester, toggle);
      expect(tester.widget<SwitchListTile>(toggle).value, true);
      final input = find.widgetWithText(TextFormField, '公开检索词 · 每行一个');
      await reveal(tester, input);
      expect(find.text(phrases.join('\n')), findsOneWidget);
      if (intent != 'preserve') {
        await reveal(tester, toggle);
        await tester.tap(toggle);
        await tester.pumpAndSettle();
      }
      if (intent == 'stale') {
        f.scope.data = directData(
          existing: {
            ...previous,
            routinePublicSearchField: ['Newly approved phrase'],
          },
        );
      }
      final save = find.widgetWithText(FilledButton, '保存');
      await reveal(tester, save);
      await tester.tap(save);
      if (intent == 'stale') {
        await tester.pumpAndSettle();
        expect(sent, isNull);
        await reveal(tester, find.textContaining('已保存的例行任务发生变化'));
        expect(find.textContaining('已保存的例行任务发生变化'), findsOneWidget);
      } else {
        await waitFor(tester, () => sent != null);
        if (intent == 'clear') {
          expect(sent![routinePublicSearchField], []);
          expect(sent!['expectedRoutine'], routineConfig(previous));
        } else {
          expect(sent!.containsKey(routinePublicSearchField), false);
          expect(sent!.containsKey('expectedRoutine'), false);
        }
      }
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }

  testWidgets(
    'group, managed Bot and member editors cannot approve public search',
    (tester) async {
      for (final mode in ['group', 'managed', 'member']) {
        final previous = routineFixture();
        final f = await fixture(
          (_) async => throw StateError('Unexpected request'),
        );
        f.scope.data = directData(
          existing: previous,
          group: mode == 'group',
          shared: mode == 'managed',
        );
        if (mode == 'member') f.session.workspace!['role'] = 'member';
        await tester.pumpWidget(
          testApp(
            RoutineEditor(scope: f.scope, agentId: 'bot-a', routine: previous),
          ),
        );
        await tester.pumpAndSettle();
        await reveal(tester, find.widgetWithText(FilledButton, 'Save'));
        expect(find.text('Allow public web search'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );

  test(
    'run and transfer preserve exact expected permission snapshots',
    () async {
      final old = {...routineFixture(), routinePublicSearchField: phrases};
      Json? sent;
      var f = await fixture((request) async {
        sent = jsonDecode(request.body) as Json;
        return jsonResponse(operationReceipt(sent!));
      });
      final operation = RoutineOperationController(f.scope, 'bot-a');
      await operation.initialize();
      await operation.run(old);
      expect(sent!['expectedRoutine'][routinePublicSearchField], phrases);
      operation.dispose();
      f.scope.dispose();
      f.session.dispose();

      final server = TransferServer();
      final before = {...transferRoutine(), routinePublicSearchField: phrases};
      server.data['routines'] = [before];
      f = await fixture((request) async {
        if (request.method == 'POST') sent = jsonDecode(request.body) as Json;
        final result = await server.handle(request);
        if (request.method == 'POST' &&
            request.url.path.endsWith('/transfer')) {
          final receipt = jsonDecode(result.body) as Json;
          (receipt['routine'] as Json).remove(routinePublicSearchField);
          server.data['routines'] = [receipt['routine']];
          server.saved = receipt;
          return jsonResponse(receipt);
        }
        return result;
      });
      f.scope.data = server.data;
      final transfer = RoutineTransferController(f.scope, 'routine-a');
      await transfer.initialize();
      await transfer.start(before, transferTargets(f.scope, 'bot-a').single);
      expect(sent!['expectedRoutine'][routinePublicSearchField], phrases);
      expect(
        transfer.receipt!['routine'].containsKey(routinePublicSearchField),
        false,
      );
      transfer.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'deletion checks the reviewed list and refuses a stale confirmation',
    (tester) async {
      final old = {...routineFixture(), routinePublicSearchField: phrases};
      Json? sent;
      final f = await fixture((request) async {
        if (request.method == 'DELETE') sent = jsonDecode(request.body) as Json;
        return request.method == 'DELETE'
            ? jsonResponse({'ok': true})
            : jsonResponse(directData());
      });
      f.scope.data = directData(existing: old);
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      f.scope.data = directData(
        existing: {
          ...old,
          routinePublicSearchField: ['New phrase'],
        },
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pumpAndSettle();
      expect(sent, isNull);
      expect(find.textContaining('This routine changed'), findsOneWidget);
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => sent != null);
      expect(sent!['expectedRoutine'][routinePublicSearchField], [
        'New phrase',
      ]);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
