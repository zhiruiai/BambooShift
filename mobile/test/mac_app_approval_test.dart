import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/action_card.dart';
import 'package:openbot_mobile/features/chat/action_data.dart';

import 'action_card_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json _openRequest({String status = 'pending'}) {
  final message = actionMessage(kind: 'computer', status: status);
  (message['metadata']['action'] as Json).addAll({
    'type': macAppOpenAction,
    'payload': {'type': macAppOpenAction, 'bundleId': 'com.apple.calculator'},
    'target': {'app': 'Calculator', 'bundleId': 'com.apple.Calculator'},
    if (status == 'done') 'result': {'ok': true},
  });
  return message;
}

const _replacement = '  Session note\t🚀\n\n  With spacing  ';
final _snapshot = 'a' * 64;

Json _controlRequest(String type, {String status = 'pending'}) {
  final message = actionMessage(kind: 'computer', status: status);
  (message['metadata']['action'] as Json).addAll({
    'type': type,
    'payload': <String, dynamic>{
      'type': type,
      'snapshotToken': _snapshot,
      'elementId': 'element-7',
      if (type == macAppSetTextAction) 'text': _replacement,
    },
    'target': <String, dynamic>{
      'app': 'TextEdit',
      'windowTitle': 'QA Bulletin',
      'role': type == macAppSetTextAction ? 'AXTextArea' : 'AXButton',
      'label': type == macAppSetTextAction ? 'Draft note' : 'Show Toolbar',
    },
    if (status == 'done') 'result': {'ok': true},
  });
  return message;
}

void main() {
  for (final chinese in [false, true]) {
    testWidgets(
      'Mac approval and receipt show the confirmed app in ${chinese ? 'zh' : 'en'}',
      (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);

        final message = _openRequest();
        var writes = 0;
        final f = await fixture((request) async {
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          if (request.method == 'POST') {
            expect(
              request.url.path,
              '/api/workspaces/space-a/computer/actions/$actionId/approve',
            );
            expect(jsonDecode(request.body), isEmpty);
            writes++;
            return jsonResponse({'id': actionId, 'status': 'running'});
          }
          expect(request.url.path, '/api/workspaces/space-a/bootstrap');
          return jsonResponse(
            bootstrap(
              messages: [writes == 0 ? message : _openRequest(status: 'done')],
            ),
          );
        });
        f.scope.data = bootstrap(messages: [message]);
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: ActionCard(
                scope: f.scope,
                message: message,
                action: ChatAction.fromMessage(message)!,
              ),
            ),
            locale: Locale(chinese ? 'zh' : 'en'),
          ),
        );
        await tester.pumpAndSettle();

        void expectTarget() {
          expect(
            find.text(chinese ? '打开 Mac 应用' : 'Open Mac app'),
            findsOneWidget,
          );
          expect(find.text('Calculator'), findsOneWidget);
          expect(find.text('com.apple.Calculator'), findsOneWidget);
          expect(find.byType(ExpansionTile), findsNothing);
        }

        expectTarget();
        expect(writes, 0);
        await tester.tap(
          find.widgetWithText(
            FilledButton,
            chinese ? '批准此操作' : 'Approve action',
          ),
        );
        await waitFor(
          tester,
          () => find
              .text(chinese ? '已返回结果' : 'Result received')
              .evaluate()
              .isNotEmpty,
        );
        expect(writes, 1);
        expectTarget();
        expect(find.byType(FilledButton), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets('a mismatched Mac bundle ID disables only approval', (
    tester,
  ) async {
    final message = _openRequest();
    message['metadata']['action']['target']['bundleId'] = 'com.apple.Notes';
    final f = await fixture(
      (_) async => throw StateError('Unexpected request'),
    );
    f.scope.data = bootstrap(messages: [message]);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ActionCard(
            scope: f.scope,
            message: message,
            action: ChatAction.fromMessage(message)!,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Approve action'),
          )
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widget<OutlinedButton>(
            find.widgetWithText(OutlinedButton, 'Reject action'),
          )
          .onPressed,
      isNotNull,
    );
    expect(
      find.text('Ask the Bot to look up the installed app again.'),
      findsOneWidget,
    );
    expect(find.text('com.apple.Notes'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  test('fresh or newly displayed app target changes block approval', () async {
    final message = _openRequest();
    final changed = _openRequest();
    changed['metadata']['action']['target']['app'] = 'Renamed Calculator';
    final missing = _openRequest();
    (missing['metadata']['action'] as Json).remove('target');
    final mismatch = _openRequest();
    mismatch['metadata']['action']['payload']['bundleId'] = 'com.apple.Notes';
    var fresh = message;
    final requests = <String>[];
    final f = await fixture((request) async {
      requests.add(request.method);
      return jsonResponse(bootstrap(messages: [fresh]));
    });
    f.scope.data = bootstrap(messages: [message]);
    final c = controller(f.scope, message);
    await c.initialize();
    final visible = c.current!.fingerprint;
    for (final replacement in [changed, missing, mismatch]) {
      fresh = replacement;
      await c.decide(true, visibleMacAppFingerprint: visible);
      expect(c.error, 'mobileChatActionChanged');
      expect(f.secrets.values, isEmpty);
    }
    expect(requests, ['GET', 'GET', 'GET']);

    f.scope.data = bootstrap(messages: [changed]);
    await c.decide(true, visibleMacAppFingerprint: visible);
    expect(c.error, 'mobileChatActionChanged');
    f.scope.data = bootstrap(messages: [missing]);
    expect(c.canApprove, isFalse);
    await c.decide(true);
    expect(requests, ['GET', 'GET', 'GET']);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });

  for (final type in [macAppPressAction, macAppSetTextAction]) {
    testWidgets('Mac control review and receipt are readable for $type', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final replacing = type == macAppSetTextAction;
      final message = _controlRequest(type);
      final done = _controlRequest(type, status: 'done');
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          expect(
            request.url.path,
            '/api/workspaces/space-a/computer/actions/$actionId/approve',
          );
          expect(jsonDecode(request.body), isEmpty);
          writes++;
          return jsonResponse({'id': actionId, 'status': 'running'});
        }
        expect(request.url.path, '/api/workspaces/space-a/bootstrap');
        return jsonResponse(bootstrap(messages: [writes > 0 ? done : message]));
      });
      f.scope.data = bootstrap(messages: [message]);
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ActionCard(
              scope: f.scope,
              message: message,
              action: ChatAction.fromMessage(message)!,
            ),
          ),
          locale: Locale(replacing ? 'zh' : 'en'),
        ),
      );
      await tester.pumpAndSettle();

      void expectReadableDetails() {
        expect(
          find.text(replacing ? '替换 Mac 应用中的文字' : 'Click Mac app control'),
          findsOneWidget,
        );
        expect(find.text('TextEdit'), findsOneWidget);
        expect(find.text('QA Bulletin'), findsOneWidget);
        expect(
          find.text(
            replacing ? 'Draft note · AXTextArea' : 'Show Toolbar · AXButton',
          ),
          findsOneWidget,
        );
        expect(find.text('将写入的文字'), replacing ? findsOneWidget : findsNothing);
        expect(
          find.text(_replacement),
          replacing ? findsOneWidget : findsNothing,
        );
        expect(find.byType(ExpansionTile), findsNothing);
        expect(find.textContaining(_snapshot), findsNothing);
        expect(find.textContaining('element-7'), findsNothing);
      }

      expectReadableDetails();
      final approve = find.byType(FilledButton);
      expect(tester.widget<FilledButton>(approve).onPressed, isNotNull);
      expect(writes, 0);
      await tester.tap(approve);
      final receipt = find.text(replacing ? '已返回结果' : 'Result received');
      await waitFor(tester, () => receipt.evaluate().isNotEmpty);
      expectReadableDetails();
      expect(writes, 1);
      expect(approve, findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }

  test('older control targets can use only a role and omit window title', () {
    final old = _controlRequest(macAppPressAction);
    final target = old['metadata']['action']['target'] as Json;
    target.remove('windowTitle');
    target['label'] = '';
    final review = ChatAction.fromMessage(old)!.macControlTarget!;
    expect(review.app, 'TextEdit');
    expect(review.role, 'AXButton');
    expect(review.windowTitle, isEmpty);
    expect(review.text, isNull);
  });

  test('invalid Mac control targets, references and text fail closed', () {
    final invalidRequests = <void Function(Json)>[
      (action) => action.remove('target'),
      (action) => action['target']['app'] = '',
      (action) => action['target']['windowTitle'] = false,
      (action) => action['target']['label'] = 'broken\nlabel',
      (action) => action['payload']['type'] = macAppPressAction,
      (action) => action['payload']['snapshotToken'] = 'A' * 64,
      (action) => action['payload']['elementId'] = 'element-7\n',
      (action) => action['payload']['elementId'] = 'a' * 65,
      (action) => action['payload']['text'] = '',
      (action) => action['payload']['text'] = '\u0000',
      (action) => action['payload']['text'] = '\uD800',
      (action) => action['payload']['text'] = '🚀' * 2001,
    ];
    for (final corrupt in invalidRequests) {
      final message = _controlRequest(macAppSetTextAction);
      corrupt(message['metadata']['action'] as Json);
      expect(ChatAction.fromMessage(message)!.macControlTarget, isNull);
    }
    final message = _controlRequest(macAppSetTextAction);
    for (final valid in [' \t\n ', '🚀' * 2000]) {
      message['metadata']['action']['payload']['text'] = valid;
      expect(ChatAction.fromMessage(message)!.macControlTarget?.text, valid);
    }
  });

  test('changed Mac control or replacement needs a new review', () async {
    final message = _controlRequest(macAppSetTextAction);
    final changedTarget = _controlRequest(macAppSetTextAction);
    final changedText = _controlRequest(macAppSetTextAction);
    changedTarget['metadata']['action']['target']['windowTitle'] = 'Other note';
    changedText['metadata']['action']['payload']['text'] = 'Different text';
    var fresh = message;
    final requests = <String>[];
    final f = await fixture((request) async {
      requests.add(request.method);
      return jsonResponse(bootstrap(messages: [fresh]));
    });
    f.scope.data = bootstrap(messages: [message]);
    final c = controller(f.scope, message);
    await c.initialize();
    final visible = c.current!.fingerprint;
    for (final replacement in [changedTarget, changedText]) {
      fresh = replacement;
      await c.decide(true, visibleMacAppFingerprint: visible);
      expect(c.error, 'mobileChatActionChanged');
      expect(f.secrets.values, isEmpty);
    }
    f.scope.data = bootstrap(messages: [changedTarget]);
    await c.decide(true, visibleMacAppFingerprint: visible);
    expect(c.error, 'mobileChatActionChanged');
    expect(requests, ['GET', 'GET']);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });

  test('malformed Mac controls can be rejected', () async {
    final message = _controlRequest(macAppSetTextAction);
    message['metadata']['action']['payload'] = null;
    final data = bootstrap(messages: [message]);
    var rejected = false;
    final f = await fixture((request) async {
      if (request.method == 'POST') {
        expect(
          request.url.path,
          '/api/workspaces/space-a/computer/actions/$actionId/reject',
        );
        rejected = true;
        return jsonResponse({'id': actionId, 'status': 'rejected'});
      }
      return jsonResponse(data);
    });
    f.scope.data = data;
    final c = controller(f.scope, message);
    await c.initialize();
    expect(c.canApprove, isFalse);
    await c.decide(true);
    expect(rejected, isFalse);
    await c.decide(false);
    expect(rejected, isTrue);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
