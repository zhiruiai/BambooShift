import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/collaboration/proposal_card.dart';
import 'package:openbot_mobile/features/collaboration/team_plans_screen.dart';
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';
import 'package:openbot_mobile/features/collaboration/team_data.dart';
import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Future<void> reach(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => rootBundle.evict('assets/apps/providers.json'));
  testWidgets(
    'team template previews assignments and opens an editable plan with no configured model',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = TeamServer();
      final starter = {
        ...draft(),
        'title': 'Launch team',
        'members': [
          for (final key in ['first', 'second'])
            {
              ...(profile(key)..remove('id')),
              'key': key,
              'kind': 'create',
              'assignment': 'Check launch evidence with $key',
            },
        ],
      };
      final writes = <Map<String, dynamic>>[];
      final f = await fixture((request) async {
        final path = request.url.path;
        if (path.endsWith('/bot-team-templates')) {
          return jsonResponse([
            {'id': 'launch', 'draft': starter},
          ]);
        }
        if (request.method == 'POST' && path.endsWith('/bot-team-plans')) {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          writes.add(body);
          return jsonResponse({
            ...plan(),
            'requestId': body['requestId'],
            'goal': body['goal'],
            'draft': starter,
          }, status: 202);
        }
        return server.handle(request);
      });
      f.scope.data = {
        ...teamSnapshot(),
        'settings': {'configured': false},
      };
      await f.session.preferences(language: const Locale('en'));
      await tester.pumpWidget(testApp(TeamPlansScreen(scope: f.scope)));
      final browse = find.widgetWithText(OutlinedButton, 'Team templates');
      await waitFor(
        tester,
        () =>
            browse.evaluate().isNotEmpty &&
            tester.widget<OutlinedButton>(browse).onPressed != null,
      );
      await tester.tap(browse);
      final template = find.text('Launch team');
      await waitFor(tester, () => template.evaluate().isNotEmpty);
      await tester.tap(template);
      await tester.pumpAndSettle();
      expect(find.text('Check launch evidence with first'), findsOneWidget);
      expect(writes, isEmpty);
      final use = find.text('Load plan and edit');
      await tester.ensureVisible(use);
      await tester.tap(use);
      await waitFor(tester, () => writes.isNotEmpty);
      await tester.pumpAndSettle();
      expect(writes.single['template'], {'id': 'launch', 'language': 'en'});
      expect(find.text('Ready to review'), findsOneWidget);
      expect(server.creations, 0);
      expect(server.starts, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'phone plan editing requires explicit create confirmation and separate start',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(TeamPlansScreen(scope: f.scope, initialPlanId: planId)),
      );
      await waitFor(
        tester,
        () => find.text('Ready to review').evaluate().isNotEmpty,
      );
      expect(server.posts, isEmpty);
      final title = find.widgetWithText(TextFormField, 'Group name');
      await reach(tester, title);
      await tester.enterText(title, 'Edited on phone');
      final create = find.widgetWithText(FilledButton, 'Create team');
      await reach(tester, create);
      await tester.tap(create);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      await reach(tester, create);
      await tester.tap(create);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => server.creations == 1);
      expect(server.starts, 0);
      expect(server.current['draft']['title'], 'Edited on phone');
      await reach(tester, find.text('Start collaboration'));
      expect(find.text('Open group chat'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'back navigation protects an unsaved plan and the cancel button keeps edits',
    (tester) async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(TeamPlansScreen(scope: f.scope, initialPlanId: planId)),
      );
      await waitFor(
        tester,
        () => find.text('Ready to review').evaluate().isNotEmpty,
      );
      final field = find.widgetWithText(TextFormField, 'Group name');
      await reach(tester, field);
      await tester.enterText(field, 'Keep draft');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Keep draft'), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'members see a bilingual proposal without owner editor or planning calls',
    (tester) async {
      var reads = 0;
      final f = await fixture((_) async {
        reads++;
        return jsonResponse({});
      });
      f.scope.data = teamSnapshot();
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: CollaborationCard(scope: f.scope, message: proposal()),
          ),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('团队协作建议'), findsOneWidget);
      expect(find.text('查看并调整方案'), findsNothing);
      expect(find.text('由当前空间拥有者核对并确认方案。'), findsOneWidget);
      expect(reads, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'actual App proposal click opens the existing GitHub form with no connection POST',
    (tester) async {
      var writes = 0;
      final f = await fixture((r) async {
        if (r.method != 'GET') writes++;
        if (r.url.path.endsWith('/session')) return jsonResponse(account());
        if (r.url.path.endsWith('/bootstrap')) {
          return jsonResponse(
            teamSnapshot(messages: [appCard(), proposalInput()]),
          );
        }
        return jsonResponse([]);
      });
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ChatMessage(scope: f.scope, message: appCard()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(writes, 0);
      await tester.tap(find.text('Review and connect'));
      await waitFor(
        tester,
        () => tester
            .widgetList<TextField>(find.byType(TextField))
            .any((field) => field.controller?.text == 'GitHub'),
      );
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        'GitHub',
      );
      expect(writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'late proposal read after account change cannot open a connection form',
    (tester) async {
      final gate = Completer<http.Response>();
      var calls = 0;
      final f = await fixture((_) {
        calls++;
        return gate.future;
      });
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ChatMessage(scope: f.scope, message: appCard()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review and connect'));
      await tester.pump();
      f.session.user = {'id': 'user-b'};
      gate.complete(jsonResponse(account()));
      await waitFor(
        tester,
        () => find.byType(LinearProgressIndicator).evaluate().isEmpty,
      );
      expect(find.byType(AddConnection), findsNothing);
      expect(calls, 1);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'Create entry opens intelligent planning while preserving the manual Bot draft',
    (tester) async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(CreateScreen(scope: f.scope, kind: 'bot')),
      );
      await tester.pumpAndSettle();
      await waitFor(
        tester,
        () => find.byType(TextFormField).evaluate().isNotEmpty,
      );
      final field = find.widgetWithText(TextFormField, 'Name');
      await reach(tester, field);
      await tester.enterText(field, 'Manual draft');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position
          .jumpTo(0);
      await tester.pump();
      final planEntry = find.text('Plan a Bot team').hitTestable();
      expect(planEntry, findsOneWidget);
      await tester.tap(planEntry);
      await waitFor(
        tester,
        () => find.byType(TeamPlansScreen).evaluate().isNotEmpty,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await reach(tester, find.text('Manual draft'));
      expect(find.text('Manual draft'), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'remounted unknown commit presents saved plan and fences only after user confirmation',
    (tester) async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      final key = f.session.api.vault.key(
        f.session.api.server!.origin,
        'team-plan:user-a:space-a',
      );
      f.secrets.values[key] = canonical({
        'version': 1,
        'kind': 'commit',
        'operationId': originalRequest,
        'requestId': revision2,
        'planId': planId,
        'expectedRevision': revision1,
      });
      await tester.pumpWidget(testApp(TeamPlansScreen(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Currently saved on the server').evaluate().isNotEmpty,
      );
      expect(server.posts, isEmpty);
      final continueButton = find.text('Review and continue editing');
      await reach(tester, continueButton);
      await tester.tap(continueButton);
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => server.posts.isNotEmpty);
      expect(server.posts.single.url.path.endsWith('/revise'), true);
      expect(server.creations, 0);
      expect(server.starts, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
