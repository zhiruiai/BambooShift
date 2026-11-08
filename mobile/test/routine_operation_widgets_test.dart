import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/routines/routine_editor.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'routine_operation_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json screenData() =>
    bootstrap(
        agents: [
          {'id': 'bot-a', 'name': 'Example'},
        ],
      )
      ..['routines'] = [routineFixture()]
      ..['workspaceTimeZone'] = {'timeZone': 'Asia/Kathmandu'};

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
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
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pumpAndSettle();
  await tester.tap(finder);
}

void main() {
  testWidgets(
    'create saves once then reopening the list restores its receipt',
    (tester) async {
      Json? submitted;
      var writes = 0, reads = 0;
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(screenData());
        }
        if (request.method == 'GET') {
          reads++;
          return jsonResponse(operationReceipt(submitted!));
        }
        writes++;
        expect(request.url.path, '/api/workspaces/space-a/routine-operations');
        submitted = jsonDecode(request.body) as Json;
        throw http.ClientException(
          'Synthetic accepted creation with lost reply',
        );
      });
      f.scope.data = screenData();
      await tester.pumpWidget(
        testApp(RoutineEditor(scope: f.scope, agentId: 'bot-a')),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextFormField>(find.byType(TextFormField).first)
                .enabled ==
            true,
      );
      await tester.enterText(
        find.byType(TextFormField).at(0),
        'Persisted task',
      );
      await tester.enterText(
        find.byType(TextFormField).at(1),
        'Synthetic saved prompt',
      );
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save'));
      await waitFor(tester, () => submitted != null);
      expect(submitted!['kind'], 'create');
      expect(submitted!['timeZone'], 'Asia/Kathmandu');
      expect(f.secrets.values, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await waitFor(
        tester,
        () => find.text('The routine was created.').evaluate().isNotEmpty,
      );
      expect(reads, 1);
      expect(writes, 1);
      expect(find.text('Persisted task'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
      await tapVisible(tester, find.widgetWithText(TextButton, 'Done'));
      await waitFor(tester, () => f.secrets.values.isEmpty);
      expect(writes, 1);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'unknown run stays locked across remount until an explicit fence',
    (tester) async {
      final requests = <Json>[];
      final cancellations = <String>[];
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(screenData());
        }
        if (request.url.path.endsWith('/cancel')) {
          final id =
              request.url.pathSegments[request.url.pathSegments.length - 2];
          cancellations.add(id);
          return jsonResponse({
            'status': 'not_submitted',
            'requestId': id,
            'userId': 'user-a',
            'workspaceId': 'space-a',
          });
        }
        if (request.method == 'GET') {
          return jsonResponse({
            'code': 'ROUTINE_OPERATION_NOT_FOUND',
            'error': 'Synthetic not found',
          }, status: 404);
        }
        requests.add(jsonDecode(request.body) as Json);
        throw http.ClientException('Synthetic lost request');
      });
      f.scope.data = screenData();
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextButton>(find.widgetWithText(TextButton, 'Run now'))
                .onPressed !=
            null,
      );
      await tester.tap(find.widgetWithText(TextButton, 'Run now'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => requests.length == 1);
      final id = requests.single['requestId'];
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await waitFor(
        tester,
        () => find.text('End this check').evaluate().isNotEmpty,
      );
      expect(requests, hasLength(1));
      await tapVisible(
        tester,
        find.widgetWithText(TextButton, 'End this check'),
      );
      await tester.pumpAndSettle();
      expect(cancellations, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => f.secrets.values.isEmpty);
      expect(cancellations, [id]);
      await tapVisible(tester, find.widgetWithText(TextButton, 'Run now'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => requests.length == 2);
      expect(requests.last['requestId'], isNot(id));
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'Chinese recovery shows accepted work rather than claiming cancellation',
    (tester) async {
      Json? submitted;
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(screenData());
        }
        if (request.url.path.endsWith('/cancel')) {
          return jsonResponse(operationReceipt(submitted!));
        }
        submitted = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic accepted run with lost reply');
      });
      f.scope.data = screenData();
      await tester.pumpWidget(
        testApp(
          RoutinesScreen(scope: f.scope, agentId: 'bot-a'),
          locale: const Locale('zh'),
        ),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextButton>(find.widgetWithText(TextButton, '立即运行'))
                .onPressed !=
            null,
      );
      await tester.tap(find.widgetWithText(TextButton, '立即运行'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '完成'));
      await waitFor(tester, () => submitted != null);
      await tapVisible(tester, find.widgetWithText(TextButton, '结束本次核对'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '完成'));
      await waitFor(
        tester,
        () => find.text('运行已接纳，正在处理。核对只会读取原结果。').evaluate().isNotEmpty,
      );
      expect(find.text('结束本次核对'), findsNothing);
      expect(f.secrets.values, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
