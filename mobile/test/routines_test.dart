import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/routines/routine_editor.dart';
import 'package:openbot_mobile/features/routines/routine_form.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json routine() => {
  'id': 'routine-a',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'title': 'Synthetic daily review',
  'prompt': 'Summarize only synthetic progress.',
  'schedule': 'weekly:1,7:09:30',
  'timeZone': 'America/New_York',
  'enabled': true,
  'nextRunAt': '2026-11-09T14:30:00Z',
};
Json data() =>
    bootstrap(
        agents: [
          {'id': 'bot-a', 'name': 'Example'},
        ],
      )
      ..['routines'] = [routine()]
      ..['workspaceTimeZone'] = {'timeZone': 'Asia/Kathmandu'};

void main() {
  testWidgets(
    'routine deletion confirms and sends only the saved configuration',
    (tester) async {
      Json? sent;
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'DELETE') {
          expect(
            request.url.path,
            '/api/workspaces/space-a/routines/routine-a',
          );
          sent = jsonDecode(request.body) as Json;
          return jsonResponse({'ok': true});
        }
        return jsonResponse(data()..['routines'] = []);
      });
      f.scope.data = data();
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      expect(sent, isNull);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(sent, isNull);
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(
        tester,
        () => find.text('No routines yet.').evaluate().isNotEmpty,
      );
      final expected = Map<String, dynamic>.of(routine())
        ..remove('id')
        ..remove('nextRunAt');
      expect(sent, {'expectedRoutine': expected});
      expect(find.text('No routines yet.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('members can read history without any mutation controls', (
    tester,
  ) async {
    final paths = <String>[];
    final f = await fixture((request) async {
      expect(request.method, 'GET');
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      paths.add(request.url.path);
      return jsonResponse({'routineId': 'routine-a', 'runs': []});
    });
    f.session.workspace!['kind'] = 'team';
    f.session.workspace!['role'] = 'member';
    f.scope.data = data();
    await tester.pumpWidget(
      testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Run now'), findsNothing);
    expect(find.text('Edit'), findsNothing);
    expect(find.byTooltip('Delete'), findsNothing);
    expect(find.byTooltip('New routine'), findsNothing);
    await tester.tap(find.widgetWithText(TextButton, 'Recent runs'));
    await waitFor(
      tester,
      () => find.text('No runs recorded yet.').evaluate().isNotEmpty,
    );
    expect(paths, ['/api/workspaces/space-a/routines/routine-a/runs']);
    expect(find.text('No runs recorded yet.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'lost manual run is not automatically sent again in the current screen',
    (tester) async {
      var calls = 0;
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(data());
        calls++;
        expect(request.method, 'POST');
        expect(request.url.path, '/api/workspaces/space-a/routine-operations');
        throw http.ClientException('Synthetic lost response');
      });
      f.scope.data = data();
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Run now'));
      await tester.pumpAndSettle();
      expect(calls, 0);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => calls == 1);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Run now'))
            .onPressed,
        isNull,
      );
      expect(
        find.text(
          'This routine request still needs checking. It can be recovered after closing; check its original result first.',
        ),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 2));
      expect(calls, 1);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('changing accounts during confirmation never dispatches a run', (
    tester,
  ) async {
    var calls = 0;
    final f = await fixture((_) async {
      calls++;
      return jsonResponse({});
    });
    f.scope.data = data();
    await tester.pumpWidget(
      testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Run now'));
    await tester.pumpAndSettle();
    f.session.user = {'id': 'other-user'};
    await tester.tap(find.widgetWithText(FilledButton, 'Done'));
    await tester.pumpAndSettle();
    expect(calls, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('editor preserves an existing zone and freezes an unknown save', (
    tester,
  ) async {
    Json? sent;
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      expect(request.method, 'PATCH');
      sent = jsonDecode(request.body) as Json;
      throw http.ClientException('Synthetic lost save');
    });
    f.scope.data = data();
    await tester.pumpWidget(
      testApp(
        RoutineEditor(scope: f.scope, agentId: 'bot-a', routine: routine()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'Revised review');
    await tester.scrollUntilVisible(
      find.widgetWithText(FilledButton, 'Save'),
      200,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await Scrollable.ensureVisible(
      tester.element(find.widgetWithText(FilledButton, 'Save')),
      alignment: 0.5,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await waitFor(tester, () => sent != null);
    expect(sent!['title'], 'Revised review');
    expect(sent!['timeZone'], 'America/New_York');
    expect(sent!['schedule'], 'weekly:1,7:09:30');
    await tester.scrollUntilVisible(
      find.widgetWithText(FilledButton, 'Save'),
      200,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
          .onPressed,
      isNull,
    );
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'weekly editor rejects no selected days and keeps Sunday as seven',
    (tester) async {
      final form = GlobalKey<FormState>();
      Json? changed;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SingleChildScrollView(
              child: Form(
                key: form,
                child: RoutineForm(
                  initial: routine(),
                  enabled: true,
                  onChanged: (v) => changed = v,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.widgetWithText(FilterChip, 'Mon'));
      await tester.tap(find.widgetWithText(FilterChip, 'Mon'));
      await tester.pump();
      expect(changed!['schedule'], 'weekly:7:09:30');
      await tester.tap(find.widgetWithText(FilterChip, 'Sun'));
      await tester.pump();
      expect(form.currentState!.validate(), isFalse);
      await tester.pump();
      expect(find.text('Select at least one day'), findsOneWidget);
    },
  );

  testWidgets(
    'late history response cannot publish another account into a stale screen',
    (tester) async {
      final reply = Completer<http.Response>();
      var called = false;
      final f = await fixture((_) {
        called = true;
        return reply.future;
      });
      f.scope.data = data();
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Recent runs'));
      await tester.pump();
      for (var i = 0; i < 10 && !called; i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(called, isTrue);
      f.session.user = {'id': 'other-user'};
      reply.complete(
        jsonResponse({
          'routineId': 'routine-a',
          'runs': [
            {
              'runId': 'foreign-run',
              'status': 'completed',
              'trigger': 'manual',
              'error': 'Must not appear',
            },
          ],
        }),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Must not appear'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
