import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/apps/app_catalog.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/connections_list.dart';
import 'package:openbot_mobile/features/apps/oauth_flow.dart';
import 'package:openbot_mobile/features/apps/pending_check.dart';

import 'apps_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  setUp(() => rootBundle.evict('assets/apps/providers.json'));
  testWidgets(
    'provider choice only prefills and requires explicit workspace consent',
    (tester) async {
      var posts = 0;
      final f = await fixture((r) async {
        if (r.method != 'GET') posts++;
        {
          return jsonResponse([]);
        }
      });
      final c = AppsController(f.scope);
      await tester.runAsync(c.initialize);
      await tester.pumpWidget(testApp(AddConnection(controller: c)));
      await waitFor(
        tester,
        () => find.widgetWithText(ActionChip, 'GitHub').evaluate().isNotEmpty,
      );
      await tester.tap(find.widgetWithText(ActionChip, 'GitHub'));
      await tester.pumpAndSettle();
      final fields = tester
          .widgetList<TextField>(find.byType(TextField))
          .toList();
      expect(fields[0].controller!.text, 'GitHub');
      expect(
        fields[1].controller!.text,
        'https://api.githubcopilot.com/mcp/readonly',
      );
      expect(fields[2].controller!.text, isEmpty);
      expect(fields[2].obscureText, isTrue);
      await tester.scrollUntilVisible(
        find.widgetWithText(FilledButton, 'Save connection'),
        160,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Save connection'),
            )
            .onPressed,
        isNull,
      );
      expect(posts, 0);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('member list remains useful without a management action', (
    tester,
  ) async {
    final events = <String>[];
    final f = await fixture((r) async {
      events.add(r.method);
      return jsonResponse([connectedApp()]);
    });
    f.session.workspace!['role'] = 'member';
    await tester.pumpWidget(testApp(ConnectionsList(scope: f.scope)));
    await waitFor(tester, () => find.text('Example').evaluate().isNotEmpty);
    expect(find.text('Add an app'), findsNothing);
    expect(
      find.text(
        'Members can view connections and tools. Only the workspace owner can manage credentials and authorization.',
      ),
      findsOneWidget,
    );
    expect(events, ['GET']);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'app directory uses real status and opens only a connection draft',
    (tester) async {
      final events = <String>[];
      final f = await fixture((request) async {
        events.add(request.method);
        return jsonResponse([
          {
            ...connectedApp(
              name: 'Work tracker',
              auth: 'oauth',
              status: 'needs_auth',
            ),
            'url': 'https://mcp.atlassian.com/v2/mcp/',
          },
        ]);
      });
      await tester.pumpWidget(testApp(ConnectionsList(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Work tracker').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('App directory'));
      await waitFor(tester, () => find.byType(TextField).evaluate().isNotEmpty);
      await tester.enterText(find.byType(TextField), 'atlassian');
      await waitFor(tester, () => find.text('Atlassian').evaluate().isNotEmpty);
      expect(
        find.widgetWithText(ListTile, 'Atlassian').evaluate().single.widget,
        isA<ListTile>().having(
          (tile) => (tile.subtitle as Text).data,
          'status',
          contains('Authorization required'),
        ),
      );
      await tester.tap(find.widgetWithText(ChoiceChip, 'Code'));
      await tester.pumpAndSettle();
      expect(find.text('Atlassian'), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, 'No sign-in'));
      await tester.enterText(find.byType(TextField), 'aws s3');
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ListTile, 'AWS Knowledge'), findsOneWidget);
      expect(find.widgetWithText(ListTile, 'Context7'), findsNothing);
      await tester.enterText(find.byType(TextField), 'sentry');
      await tester.pumpAndSettle();
      expect(find.text('Sentry'), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Code'));
      await tester.pumpAndSettle();
      expect(find.text('GitHub'), findsNothing);
      await tester.tap(find.widgetWithText(ListTile, 'Sentry'));
      await waitFor(
        tester,
        () => find.byType(AddConnection).evaluate().isNotEmpty,
      );
      await waitFor(
        tester,
        () => find.widgetWithText(ActionChip, 'Sentry').evaluate().isNotEmpty,
      );
      final fields = tester
          .widgetList<TextField>(find.byType(TextField))
          .toList();
      expect(fields[0].controller!.text, 'Sentry');
      expect(fields[1].controller!.text, 'https://mcp.sentry.dev/mcp');
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      expect(events, ['GET']);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('unknown release needs explicit warning and only performs GET', (
    tester,
  ) async {
    final events = <String>[];
    final f = await fixture((r) async {
      events.add(r.method);
      if (r.method == 'POST') throw http.ClientException('Lost');
      {
        return jsonResponse([]);
      }
    });
    final c = AppsController(f.scope);
    await tester.runAsync(c.initialize);
    await tester.runAsync(() => c.add(appDraft()));
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: AnimatedBuilder(
            animation: c,
            builder: (_, _) => AppPendingCheck(controller: c),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard this local pending draft'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('does not cancel a remote request'),
      findsOneWidget,
    );
    expect(c.hasPending, isTrue);
    expect(events.where((m) => m == 'POST').length, 1);
    await tester.tap(find.widgetWithText(FilledButton, 'Done'));
    await waitFor(tester, () => !c.hasPending);
    expect(events.last, 'GET');
    expect(events.where((m) => m == 'POST').length, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'callback read never exchanges until the confirmation button is pressed',
    (tester) async {
      var finishes = 0;
      var status = 'callback_received';
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/finish')) {
          finishes++;
          status = 'complete';
          return jsonResponse(oauthFlow(status: status));
        }
        if (r.url.path.endsWith('/oauth')) {
          return jsonResponse(oauthFlow(status: status));
        }
        return jsonResponse([connectedApp(auth: 'oauth')]);
      });
      final c = AppsController(f.scope);
      await tester.runAsync(c.initialize);
      await tester.runAsync(() => c.refresh('app-a'));
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SingleChildScrollView(
              child: AnimatedBuilder(
                animation: c,
                builder: (_, _) =>
                    OAuthFlowPanel(controller: c, connectionId: 'app-a'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(finishes, 0);
      await tester.tap(
        find.widgetWithText(FilledButton, 'Confirm and save authorization'),
      );
      await waitFor(tester, () => c.flows['app-a']?['status'] == 'complete');
      expect(finishes, 1);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'bundled provider data is exact repository catalog and both languages match',
    () {
      expect(
        jsonDecode(File('assets/apps/providers.json').readAsStringSync()),
        jsonDecode(File('../shared/app-providers.json').readAsStringSync()),
      );
      final bundled =
          jsonDecode(File('assets/apps/providers.json').readAsStringSync())
              as List;
      expect(bundled.map((row) => row['id']).toSet(), appProviderIds);
      expect(bundled.where((row) => row['id'] == 'gmail'), isEmpty);
      expect(
        bundled.singleWhere(
          (row) => row['id'] == 'microsoft-learn',
        )['authType'],
        'none',
      );
      expect(
        bundled.singleWhere((row) => row['id'] == 'gitlab')['authType'],
        'oauth',
      );
      final en =
          jsonDecode(File('assets/l10n/apps_en.arb').readAsStringSync()) as Map;
      final zh =
          jsonDecode(File('assets/l10n/apps_zh.arb').readAsStringSync()) as Map;
      expect(en.keys.toSet(), zh.keys.toSet());
      for (final id in appProviderIds) {
        expect(en['mobileAppsProvider_$id'], isA<String>());
      }
      expect(
        en.keys
            .where((k) => !k.startsWith('@'))
            .every((k) => k.startsWith('mobileApps')),
        isTrue,
      );
      expect(en.values.every((v) => v is String && v.isNotEmpty), isTrue);
      expect(zh.values.every((v) => v is String && v.isNotEmpty), isTrue);
    },
  );
  testWidgets(
    'chat catalog entry only prefills a known provider without granting consent',
    (tester) async {
      final events = <String>[];
      final f = await fixture((r) async {
        events.add(r.method);
        return jsonResponse([]);
      });
      await tester.pumpWidget(
        testApp(ConnectionsList(scope: f.scope, initialProviderId: 'github')),
      );
      await waitFor(
        tester,
        () => find.byType(AddConnection).evaluate().isNotEmpty,
      );
      await waitFor(
        tester,
        () => tester
            .widgetList<TextField>(find.byType(TextField))
            .any((field) => field.controller?.text == 'GitHub'),
      );
      final fields = tester
          .widgetList<TextField>(find.byType(TextField))
          .toList();
      expect(fields[0].controller!.text, 'GitHub');
      expect(
        fields[1].controller!.text,
        'https://api.githubcopilot.com/mcp/readonly',
      );
      expect(fields[2].controller!.text, isEmpty);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      expect(events, ['GET']);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
