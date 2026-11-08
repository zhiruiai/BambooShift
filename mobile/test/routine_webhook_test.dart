import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/routines/routine_editor.dart';
import 'package:openbot_mobile/features/routines/routine_webhook_data.dart';
import 'package:openbot_mobile/features/routines/routine_webhook_screen.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'routines_test.dart' show data, routine;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _management = '/api/workspaces/space-a/routines/routine-a/webhook';
const _endpoint = '/api/routine-webhooks/space-a/routine-a';
const _rev1 = '00000000-0000-4000-8000-000000000001';
const _rev2 = '00000000-0000-4000-8000-000000000002';
const _rev3 = '00000000-0000-4000-8000-000000000003';
final _key1 = List.filled(43, 'A').join();
final _key2 = '${List.filled(42, 'b').join()}E';

Json _status([String? revision]) => {
  'enabled': revision != null,
  'revision': revision ?? 'unset',
  if (revision != null) 'path': _endpoint,
};

RoutineWebhookScreen _screen(WorkspaceController scope) => RoutineWebhookScreen(
  scope: scope,
  routineId: 'routine-a',
  agentId: 'bot-a',
  conversationId: 'chat-a',
);

Future<void> _tap(WidgetTester tester, String label) async {
  final target = await _show(tester, label);
  await tester.tap(target);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 320));
}

Future<Finder> _show(WidgetTester tester, String label) async {
  final matches = find.text(label);
  if (matches.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      matches,
      120,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
  }
  final target = matches.last;
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  return target;
}

void main() {
  test(
    'Webhook receipts bind to the exact endpoint and validate the one-time secret',
    () {
      expect(parseRoutineWebhook(_status(_rev1), _endpoint).secret, isNull);
      final valid = {..._status(_rev1), 'secret': _key1};
      expect(
        parseRoutineWebhook(valid, _endpoint, writtenEnabled: true).secret,
        _key1,
      );
      expect(
        () => parseRoutineWebhook(valid, _endpoint),
        throwsA(isA<ApiException>()),
      );
      for (final changed in [
        {'path': 'https://elsewhere.example.test$_endpoint'},
        {'path': '$_endpoint?include=secrets'},
        {'revision': 'unset'},
        {'secret': _key1.replaceRange(42, 43, 'B')},
        {'secret': _key1.replaceRange(0, 1, '\n')},
      ]) {
        expect(
          () => parseRoutineWebhook(
            {...valid, ...changed},
            _endpoint,
            writtenEnabled: true,
          ),
          throwsA(isA<ApiException>()),
        );
      }
    },
  );

  testWidgets('320px owner confirms issue, rotates and revokes exact keys', (
    tester,
  ) async {
    tester.view
      ..devicePixelRatio = 1
      ..physicalSize = const Size(320, 640);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final clipboard = <String>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (event) async {
      if (event.method == 'Clipboard.setData') {
        clipboard.add((event.arguments as Map)['text'] as String);
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    final writes = <(String, Json)>[];
    var visible = _status();
    final f = await fixture((request) async {
      expect(request.url.path, _management);
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.method == 'GET') return jsonResponse(visible);
      writes.add((request.method, jsonDecode(request.body) as Json));
      if (request.method == 'DELETE') {
        visible = {'enabled': false, 'revision': _rev3};
        return jsonResponse(visible);
      }
      final first = writes.length == 1;
      visible = _status(first ? _rev1 : _rev2);
      return jsonResponse({...visible, 'secret': first ? _key1 : _key2});
    });
    f.scope.data = data();
    await tester.pumpWidget(
      testApp(_screen(f.scope), locale: const Locale('zh')),
    );
    await waitFor(tester, () => find.text('创建密钥').evaluate().isNotEmpty);
    await _tap(tester, '创建密钥');
    expect(writes, isEmpty);
    await _tap(tester, '完成');
    await waitFor(
      tester,
      () => find.text('已创建 Webhook 密钥。').evaluate().isNotEmpty,
    );
    await _show(tester, _key1);
    expect(clipboard, isEmpty);
    for (final label in ['复制地址', '复制密钥', '复制 Authorization 请求头']) {
      await _tap(tester, label);
    }
    expect(clipboard, [
      'https://api.example.test$_endpoint',
      _key1,
      'Authorization: Bearer $_key1',
    ]);
    expect(
      f.secrets.values.values.any((value) => value.contains(_key1)),
      isFalse,
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(find.text(_key1), findsNothing);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await waitFor(tester, () => find.text('轮换密钥').evaluate().isNotEmpty);
    expect(find.text(_key1), findsNothing);
    await _tap(tester, '轮换密钥');
    expect(writes, hasLength(1));
    await _tap(tester, '完成');
    await waitFor(
      tester,
      () => find.text('已创建 Webhook 密钥。').evaluate().isNotEmpty,
    );
    await _show(tester, _key2);
    expect(find.text(_key1), findsNothing);
    await _tap(tester, '撤销密钥');
    await _tap(tester, '完成');
    await waitFor(
      tester,
      () => find.text('已撤销 Webhook 密钥。').evaluate().isNotEmpty,
    );
    expect(writes.map((write) => write.$1), ['PUT', 'PUT', 'DELETE']);
    expect(writes.map((write) => write.$2), [
      {'expectedRevision': 'unset'},
      {'expectedRevision': _rev1},
      {'expectedRevision': _rev2},
    ]);
    expect(find.text(_key2), findsNothing);
    expect(find.text('复制地址'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'a receipt arriving across background is read back without revealing its key',
    (tester) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      final incoming = Completer<http.Response>();
      final events = <String>[];
      final f = await fixture((request) async {
        events.add(request.method);
        if (request.method == 'PUT') return incoming.future;
        return jsonResponse(events.length > 1 ? _status(_rev1) : _status());
      });
      f.scope.data = data();
      await tester.pumpWidget(testApp(_screen(f.scope)));
      await waitFor(
        tester,
        () => find.text('Create key').evaluate().isNotEmpty,
      );
      await _tap(tester, 'Create key');
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pump(const Duration(milliseconds: 280));
      expect(events, ['GET', 'PUT']);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(find.text('Copy key'), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(events, ['GET', 'PUT']);
      incoming.complete(jsonResponse({..._status(_rev1), 'secret': _key1}));
      await waitFor(
        tester,
        () => find.text('Webhook key is active').evaluate().isNotEmpty,
      );
      expect(events, ['GET', 'PUT', 'GET']);
      expect(find.text(_key1), findsNothing);
      expect(find.text('Copy key'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('ambiguous issuance refreshes status and never retries a write', (
    tester,
  ) async {
    final events = <String>[];
    final f = await fixture((request) async {
      events.add(request.method);
      if (request.method == 'PUT') {
        throw http.ClientException('Synthetic interruption');
      }
      return jsonResponse(events.length > 1 ? _status(_rev1) : _status());
    });
    f.scope.data = data();
    await tester.pumpWidget(testApp(_screen(f.scope)));
    await waitFor(tester, () => find.text('Create key').evaluate().isNotEmpty);
    await _tap(tester, 'Create key');
    await _tap(tester, 'Done');
    await waitFor(
      tester,
      () => find.text('Webhook key is active').evaluate().isNotEmpty,
    );
    expect(events, ['GET', 'PUT', 'GET']);
    expect(find.text('Copy key'), findsNothing);
    f.session.selectWorkspace(null);
    await tester.pumpAndSettle();
    expect(find.text('Copy endpoint'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'routine list labels webhook history and hides owner actions from members',
    (tester) async {
      final events = <String>[];
      final f = await fixture((request) async {
        events.add(request.method);
        expect(request.url.path.endsWith('/runs'), isTrue);
        return jsonResponse({
          'routineId': 'routine-a',
          'runs': [
            {
              'runId': 'webhook-run',
              'status': 'completed',
              'trigger': 'webhook',
            },
            {'runId': 'manual-run', 'status': 'completed', 'trigger': 'manual'},
          ],
        });
      });
      f.session.workspace!
        ..['kind'] = 'team'
        ..['role'] = 'member';
      final eventOnly = routine()
        ..['schedule'] = 'webhook'
        ..['nextRunAt'] = '';
      f.scope.data = data()..['routines'] = [eventOnly];
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Webhook only'), findsOneWidget);
      expect(find.text('Webhook'), findsNothing);
      expect(find.textContaining('Next run'), findsNothing);
      expect(find.text('Run now'), findsNothing);
      await _tap(tester, 'Recent runs');
      await waitFor(
        tester,
        () => find.text('Completed · Webhook').evaluate().isNotEmpty,
      );
      expect(find.text('Completed · Webhook'), findsOneWidget);
      expect(find.text('Completed · Manual'), findsOneWidget);
      expect(events, ['GET']);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    '390px editor saves webhook-only schedule without a time or extra write',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(390, 740);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final operations = <(String, Json)>[];
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(data());
        expect(request.url.path, '/api/workspaces/space-a/routines/routine-a');
        final body = jsonDecode(request.body) as Json;
        operations.add((request.method, body));
        return jsonResponse({...routine(), ...body, 'nextRunAt': ''});
      });
      f.scope.data = data();
      await tester.pumpWidget(
        testApp(
          RoutineEditor(scope: f.scope, agentId: 'bot-a', routine: routine()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await _tap(tester, 'Webhook only');
      expect(operations, isEmpty);
      expect(find.text('Time'), findsNothing);
      await _tap(tester, 'Save');
      await waitFor(tester, () => operations.isNotEmpty);
      expect(operations.single.$1, 'PATCH');
      expect(operations.single.$2['schedule'], 'webhook');
      expect(operations.single.$2.containsKey('nextRunAt'), isFalse);
      expect(operations.single.$2.containsKey('secret'), isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
