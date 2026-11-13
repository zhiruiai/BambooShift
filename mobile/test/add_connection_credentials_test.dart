import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/connection_details.dart';

import 'apps_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const oldUrl = 'https://first.example.test/mcp';
const newUrl = 'https://second.example.test/mcp';
const oldToken = 'synthetic-first-credential';
const newToken = 'synthetic-second-credential';
Finder field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);
final consent = find.byType(CheckboxListTile);
final submit = find.widgetWithText(FilledButton, 'Save connection');

Future<void> tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pump();
}

Future<void> draft(WidgetTester tester) async {
  await waitFor(
    tester,
    () => find.widgetWithText(ActionChip, 'GitHub').evaluate().isNotEmpty,
  );
  await tap(tester, find.widgetWithText(ActionChip, 'GitHub'));
  await tester.enterText(field('App name'), 'Synthetic connection');
  await tester.enterText(field('MCP endpoint (HTTPS)'), oldUrl);
  await tester.enterText(field('Access token'), oldToken);
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await tap(tester, consent);
  expect(tester.widget<CheckboxListTile>(consent).value, isTrue);
}

void main() {
  setUp(() => rootBundle.evict('assets/apps/providers.json'));
  testWidgets(
    'editing endpoint drops its credential and requires new consent',
    (tester) async {
      final writes = <Json>[];
      final saved = connectedApp(auth: 'bearer', name: 'Renamed connection')
        ..['url'] = newUrl;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes.add(jsonDecode(request.body) as Json);
          return jsonResponse(saved);
        }
        if (request.url.path.endsWith('/tools')) return jsonResponse([]);
        return jsonResponse(writes.isEmpty ? [] : [saved]);
      });
      final controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(testApp(AddConnection(controller: controller)));
      await draft(tester);
      await tester.enterText(field('App name'), 'Renamed connection');
      expect(
        tester.widget<TextField>(field('Access token')).controller!.text,
        oldToken,
      );
      expect(tester.widget<CheckboxListTile>(consent).value, isTrue);
      final capturedSubmit = tester.widget<FilledButton>(submit).onPressed!;
      await tester.enterText(field('MCP endpoint (HTTPS)'), newUrl);
      await tester.pump();
      expect(
        tester.widget<TextField>(field('Access token')).controller!.text,
        isEmpty,
      );
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      capturedSubmit();
      await tester.pumpAndSettle();
      expect(writes, isEmpty);
      await tester.enterText(field('Access token'), newToken);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tap(tester, consent);
      await tap(tester, submit);
      await waitFor(
        tester,
        () => find.byType(ConnectionDetails).evaluate().isNotEmpty,
      );
      expect(writes, [
        {
          'name': 'Renamed connection',
          'url': newUrl,
          'authType': 'bearer',
          'shared': true,
          'token': newToken,
        },
      ]);
      expect(f.secrets.values.values.join(), isNot(contains(oldToken)));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('cancelled draft has no request or retained credential', (
    tester,
  ) async {
    var writes = 0;
    final f = await fixture((request) async {
      if (request.method != 'GET') writes++;
      return jsonResponse([]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await tester.runAsync(controller.initialize);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: Builder(
            builder: (context) => FilledButton(
              onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute(
                  builder: (_) => AddConnection(controller: controller),
                ),
              ),
              child: const Text('Open connection draft'),
            ),
          ),
        ),
      ),
    );
    await tap(tester, find.text('Open connection draft'));
    await draft(tester);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(writes, 0);
    expect(f.secrets.values.values.join(), isNot(contains(oldToken)));
    await tap(tester, find.text('Open connection draft'));
    await waitFor(tester, () => field('App name').evaluate().isNotEmpty);
    expect(
      tester.widget<TextField>(field('App name')).controller!.text,
      isEmpty,
    );
    expect(
      tester.widget<TextField>(field('MCP endpoint (HTTPS)')).controller!.text,
      isEmpty,
    );
    expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
    expect(writes, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'losing owner permission revokes entered credential and consent',
    (tester) async {
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method != 'GET') writes++;
        return jsonResponse([]);
      });
      final controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(testApp(AddConnection(controller: controller)));
      await draft(tester);
      final capturedSubmit = tester.widget<FilledButton>(submit).onPressed!;
      f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
      await tester.pump();
      expect(
        tester.widget<TextField>(field('Access token')).controller!.text,
        isEmpty,
      );
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      capturedSubmit();
      await tester.pumpAndSettle();
      expect(writes, 0);
      f.session.selectWorkspace({...f.session.workspace!, 'role': 'owner'});
      await tester.pump();
      await tester.scrollUntilVisible(
        submit,
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('workspace change invalidates an already captured submit', (
    tester,
  ) async {
    var writes = 0;
    final f = await fixture((request) async {
      if (request.method != 'GET') writes++;
      return jsonResponse([]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await tester.runAsync(controller.initialize);
    await tester.pumpWidget(testApp(AddConnection(controller: controller)));
    await draft(tester);
    final token = tester.widget<TextField>(field('Access token')).controller!;
    final capturedSubmit = tester.widget<FilledButton>(submit).onPressed!;
    final next = {...f.session.workspace!, 'id': 'space-b'};
    f.session.workspaces.add(next);
    f.session.selectWorkspace(next);
    await tester.pump();
    expect(token.text, isEmpty);
    capturedSubmit();
    await tester.pumpAndSettle();
    expect(writes, 0);
    expect(find.byType(TextField), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('pending submission locks target, credential and consent', (
    tester,
  ) async {
    final response = Completer<http.Response>();
    final writes = <Json>[];
    final saved = connectedApp(auth: 'bearer', name: 'Synthetic connection')
      ..['url'] = oldUrl;
    final f = await fixture((request) async {
      if (request.method == 'POST') {
        writes.add(jsonDecode(request.body) as Json);
        return response.future;
      }
      if (request.url.path.endsWith('/tools')) return jsonResponse([]);
      return jsonResponse(writes.isEmpty ? [] : [saved]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      if (!response.isCompleted) response.complete(jsonResponse(saved));
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await tester.runAsync(controller.initialize);
    await tester.pumpWidget(testApp(AddConnection(controller: controller)));
    await draft(tester);
    await tap(tester, submit);
    for (var attempt = 0; attempt < 30 && writes.isEmpty; attempt++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
    }
    expect(writes.length, 1);
    expect(
      tester.widget<TextField>(field('MCP endpoint (HTTPS)')).enabled,
      isFalse,
    );
    expect(tester.widget<TextField>(field('Access token')).enabled, isFalse);
    expect(tester.widget<CheckboxListTile>(consent).onChanged, isNull);
    await tester.scrollUntilVisible(
      submit,
      100,
      scrollable: find.byType(Scrollable).first,
    );
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    response.complete(jsonResponse(saved));
    await waitFor(
      tester,
      () => find.byType(ConnectionDetails).evaluate().isNotEmpty,
    );
    expect(writes.single['url'], oldUrl);
    expect(writes.single['token'], oldToken);
    expect(writes.length, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'fixed proposal endpoint stays locked and edits require review again',
    (tester) async {
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method != 'GET') writes++;
        return jsonResponse([]);
      });
      final controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(
        testApp(
          AddConnection(
            controller: controller,
            initialCustomMcp: (name: 'first.example.test', url: oldUrl),
            onConnected: (_) => fail('This test never authorizes a connection'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(field('MCP endpoint (HTTPS)')).readOnly,
        isTrue,
      );
      await tap(tester, consent);
      await tester.enterText(field('App name'), 'Reviewed new label');
      await tester.pump();
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tap(tester, consent);
      await tap(tester, find.byType(DropdownButtonFormField<String>));
      await tap(tester, find.text('Access token').last);
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      expect(
        tester.widget<TextField>(field('Access token')).controller!.text,
        isEmpty,
      );
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tap(tester, consent);
      await tester.enterText(field('Access token'), newToken);
      await tester.pump();
      expect(tester.widget<CheckboxListTile>(consent).value, isFalse);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      expect(
        tester
            .widget<TextField>(field('MCP endpoint (HTTPS)'))
            .controller!
            .text,
        oldUrl,
      );
      expect(writes, 0);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
