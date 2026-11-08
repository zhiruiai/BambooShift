import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/apps/connection_details.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';

import 'apps_support.dart';
import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

const _learn = 'https://learn.microsoft.com/api/mcp';
const _notion = 'https://mcp.notion.com/mcp';

Json _proposal(String provider) =>
    appCard()..['metadata']['appConnectionProposal']['providerId'] = provider;

Json _snapshot(Json proposal, [List<Json> apps = const []]) =>
    teamSnapshot(messages: [proposal, proposalInput()])..['apps'] = apps;

Widget _chat(WorkspaceController scope, Json message, {Locale? locale}) =>
    testApp(
      Scaffold(
        body: ListView(
          padding: const EdgeInsets.all(12),
          children: [ChatMessage(scope: scope, message: message)],
        ),
      ),
      locale: locale ?? const Locale('en'),
    );

bool _settledDetails() =>
    find.byType(ConnectionDetails).evaluate().isNotEmpty &&
    find.byType(LinearProgressIndicator).evaluate().isEmpty;

Future<void> waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready(), isTrue);
}

Future<void> _tap(WidgetTester tester, Finder target) async {
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      160,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .last,
    );
  }
  await tester.ensureVisible(target);
  await tester.pump();
  await tester.tap(target);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 360));
}

void main() {
  setUp(() => rootBundle.evict('assets/apps/providers.json'));
  testWidgets(
    '320px chat opens exact OAuth connection and resumes pending authorization',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(320, 640);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final proposal = _proposal('notion');
      final app = connectedApp(
        name: 'Notion',
        auth: 'oauth',
        status: 'needs_auth',
        revision: 'rev-b',
      )..['url'] = _notion;
      final requests = <String>[];
      final f = await fixture((request) async {
        requests.add('${request.method} ${request.url.path}');
        expect(request.method, 'GET');
        if (request.url.path.endsWith('/session')) {
          return jsonResponse(account());
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(_snapshot(proposal, [app]));
        }
        if (request.url.path.endsWith('/apps/app-a/oauth')) {
          return jsonResponse(oauthFlow());
        }
        expect(request.url.path.endsWith('/apps'), isTrue);
        return jsonResponse([app]);
      });
      f.scope.data = _snapshot(proposal, [app]);
      await tester.pumpWidget(
        _chat(f.scope, proposal, locale: const Locale('zh')),
      );
      await waitFor(tester, () => find.text('继续授权').evaluate().isNotEmpty);
      expect(find.text('建议连接 Notion'), findsOneWidget);
      expect(find.text('需要授权'), findsOneWidget);
      expect(find.bySemanticsLabel('建议连接 Notion'), findsOneWidget);
      expect(find.bySemanticsLabel('需要授权'), findsOneWidget);
      expect(requests, isEmpty);
      await _tap(tester, find.text('继续授权'));
      await waitFor(tester, () => find.text('在浏览器打开授权').evaluate().isNotEmpty);
      expect(find.byType(ConnectionDetails), findsOneWidget);
      expect(find.byType(AddConnection), findsNothing);
      expect(requests.any((value) => value.endsWith('/oauth')), isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    '390px explicit consent checks for a concurrent connection and updates chat on return',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(390, 740);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final proposal = _proposal('microsoft-learn');
      final real = connectedApp(name: 'Microsoft Learn')..['url'] = _learn;
      final similarName = connectedApp(id: 'spoof', name: 'Microsoft Learn');
      var listed = 0;
      final writes = <String>[];
      final f = await fixture((request) async {
        if (request.method != 'GET') writes.add(request.method);
        if (request.url.path.endsWith('/session')) {
          return jsonResponse(account());
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(
            _snapshot(proposal, listed >= 2 ? [real] : [similarName]),
          );
        }
        expect(request.url.path.endsWith('/apps'), isTrue);
        listed++;
        return jsonResponse(listed >= 2 ? [real] : [similarName]);
      });
      f.scope.data = _snapshot(proposal, [similarName]);
      await tester.pumpWidget(_chat(f.scope, proposal));
      await waitFor(
        tester,
        () => find.text('Review and connect').evaluate().isNotEmpty,
      );
      expect(find.text('Not configured'), findsOneWidget);
      await _tap(tester, find.text('Review and connect'));
      await waitFor(
        tester,
        () => tester
            .widgetList<TextField>(find.byType(TextField))
            .any((field) => field.controller?.text == _learn),
      );
      expect(find.byType(AddConnection), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).at(1)).readOnly,
        isTrue,
      );
      final save = find.widgetWithText(FilledButton, 'Save connection');
      expect(tester.widget<FilledButton>(save).onPressed, isNull);
      expect(writes, isEmpty);
      await _tap(tester, find.byType(CheckboxListTile));
      await _tap(tester, save);
      await waitFor(tester, _settledDetails);
      expect(writes, isEmpty);
      await tester.pageBack();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 360));
      await waitFor(
        tester,
        () =>
            find.text('Open connection').evaluate().isNotEmpty &&
            find.byType(ConnectionDetails).evaluate().isEmpty,
      );
      expect(find.text('Connected'), findsOneWidget);
      expect(find.bySemanticsLabel('Connected'), findsOneWidget);
      expect(find.bySemanticsLabel('Not configured'), findsNothing);
      expect(find.byType(ConnectionDetails), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'review retries an unknown connection list before permitting setup',
    (tester) async {
      final proposal = _proposal('microsoft-learn');
      final app = connectedApp(name: 'Microsoft Learn')..['url'] = _learn;
      var reads = 0;
      final f = await fixture((request) async {
        expect(request.method, 'GET');
        if (request.url.path.endsWith('/session')) {
          return jsonResponse(account());
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(_snapshot(proposal));
        }
        reads++;
        if (reads == 1) throw http.ClientException('Synthetic list failure');
        return jsonResponse([app]);
      });
      f.scope.data = _snapshot(proposal);
      await tester.pumpWidget(_chat(f.scope, proposal));
      await waitFor(
        tester,
        () => find.text('Review and connect').evaluate().isNotEmpty,
      );
      await _tap(tester, find.text('Review and connect'));
      await waitFor(tester, () => find.text('Retry').evaluate().isNotEmpty);
      expect(find.byType(AddConnection), findsNothing);
      expect(reads, 1);
      await _tap(tester, find.text('Retry'));
      await waitFor(tester, _settledDetails);
      expect(find.byType(AddConnection), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'confirmed app setup posts one exact request and returns directly to chat',
    (tester) async {
      final proposal = _proposal('microsoft-learn');
      final app = connectedApp(name: 'Microsoft Learn')..['url'] = _learn;
      final writes = <Json>[];
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/session')) {
          return jsonResponse(account());
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(_snapshot(proposal, writes.isEmpty ? [] : [app]));
        }
        expect(request.url.path.endsWith('/apps'), isTrue);
        if (request.method == 'POST') {
          writes.add(jsonDecode(request.body) as Json);
          return jsonResponse(app);
        }
        return jsonResponse(writes.isEmpty ? [] : [app]);
      });
      f.scope.data = _snapshot(proposal);
      await tester.pumpWidget(_chat(f.scope, proposal));
      await waitFor(
        tester,
        () => find.text('Review and connect').evaluate().isNotEmpty,
      );
      await _tap(tester, find.text('Review and connect'));
      await waitFor(
        tester,
        () => tester
            .widgetList<TextField>(find.byType(TextField))
            .any((field) => field.controller?.text == _learn),
      );
      expect(writes, isEmpty);
      await _tap(tester, find.byType(CheckboxListTile));
      expect(writes, isEmpty);
      await _tap(tester, find.widgetWithText(FilledButton, 'Save connection'));
      await waitFor(tester, _settledDetails);
      expect(writes, [
        {
          'name': 'Microsoft Learn',
          'url': _learn,
          'authType': 'none',
          'shared': true,
        },
      ]);
      await tester.pageBack();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 360));
      await waitFor(
        tester,
        () =>
            find.text('Open connection').evaluate().isNotEmpty &&
            find.byType(ConnectionDetails).evaluate().isEmpty,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('team member sees connection status without authority to act', (
    tester,
  ) async {
    final proposal = _proposal('notion');
    final app = connectedApp(name: 'Notion', auth: 'oauth')..['url'] = _notion;
    var requests = 0;
    final f = await fixture((_) async {
      requests++;
      return jsonResponse({});
    });
    f.session.workspace!
      ..['kind'] = 'team'
      ..['role'] = 'member';
    f.scope.data = _snapshot(proposal, [app]);
    await tester.pumpWidget(_chat(f.scope, proposal));
    await waitFor(tester, () => find.text('Connected').evaluate().isNotEmpty);
    expect(find.text('Open connection'), findsNothing);
    expect(find.textContaining('owner who requested'), findsOneWidget);
    expect(requests, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
