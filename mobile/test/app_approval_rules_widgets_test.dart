import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/connections_list.dart';
import 'package:openbot_mobile/features/chat/action_card.dart';
import 'package:openbot_mobile/features/chat/action_data.dart';

import 'action_card_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const rulesPath = '/api/workspaces/space-a/apps/approval-rules';
const actionPath = '/api/workspaces/space-a/app-actions/$actionId/decision';

void main() {
  for (final chinese in [false, true]) {
    testWidgets(
      'narrow ${chinese ? 'Chinese' : 'English'} review, receipt and revocation',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = Size(chinese ? 390 : 320, chinese ? 760 : 568);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final message = exactReadAction();
        final saved = exactReadAction(usage: 'saved');
        final used = exactReadAction(usage: 'reused')..['id'] = 'card-b';
        used['metadata']['appAction']['id'] =
            '33333333-3333-4333-8333-333333333333';
        final data = bootstrap(messages: [message]);
        final writes = <String>[];
        var revoked = false;
        final f = await fixture((request) async {
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          final path = request.url.path;
          if (request.method == 'POST') {
            expect(path, actionPath);
            expect(jsonDecode(request.body), {'decision': 'always_allow'});
            writes.add('save');
            data['messages'] = [saved, used];
            return jsonResponse(saved['metadata']['appAction']);
          }
          if (request.method == 'DELETE') {
            expect(path, '$rulesPath/$ruleId');
            writes.add('revoke');
            revoked = true;
            if (chinese) throw http.ClientException('synthetic lost response');
            return jsonResponse({'ok': true});
          }
          if (path == rulesPath) {
            return jsonResponse({
              'rules': [if (!revoked) exactReadRule()],
            });
          }
          if (path.endsWith('/apps')) return jsonResponse([]);
          expect(path, '/api/workspaces/space-a/bootstrap');
          return jsonResponse(data);
        });
        f.scope.data = data;
        final locale = Locale(chinese ? 'zh' : 'en');
        final always = chinese ? '始终允许' : 'Always allow';
        final save = chinese ? '保存并允许' : 'Save and allow';
        final permissions = chinese ? '已保存的应用权限' : 'Saved app permissions';
        final revoke = chinese ? '撤销权限' : 'Revoke permission';
        final cancel = chinese ? '取消' : 'Cancel';
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: ListView(
                children: [
                  ActionCard(
                    key: const ValueKey('card-a'),
                    scope: f.scope,
                    message: message,
                    action: ChatAction.fromMessage(message)!,
                  ),
                ],
              ),
            ),
            locale: locale,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(OutlinedButton, always));
        await tester.pumpAndSettle();
        expect(find.text('Research Bot'), findsOneWidget);
        expect(find.text('Synthetic project'), findsOneWidget);
        expect(find.text('Example GitHub · issue_read'), findsWidgets);
        expect(find.text('get · example/research #42'), findsOneWidget);
        expect(writes, isEmpty);
        await tester.tap(find.widgetWithText(TextButton, cancel));
        await tester.pumpAndSettle();
        expect(writes, isEmpty);
        await tester.tap(find.widgetWithText(OutlinedButton, always));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, save));
        await waitFor(
          tester,
          () => find
              .text(chinese ? '已保存精确授权' : 'Saved exact permission')
              .evaluate()
              .isNotEmpty,
        );
        final reused = find.text(
          chinese ? '已使用已保存的授权' : 'Used a saved permission',
        );
        expect(f.scope.find('messages', 'card-b'), isNotNull);
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: ActionCard(
                key: const ValueKey('card-b'),
                scope: f.scope,
                message: used,
                action: ChatAction.fromMessage(used)!,
              ),
            ),
            locale: locale,
          ),
        );
        await tester.pumpAndSettle();
        expect(reused, findsOneWidget);
        expect(writes, ['save']);
        await tester.pumpWidget(
          testApp(ConnectionsList(scope: f.scope), locale: locale),
        );
        await waitFor(
          tester,
          () => find
              .text(
                chinese
                    ? '当前空间还没有应用连接。'
                    : 'No apps are connected to this workspace.',
              )
              .evaluate()
              .isNotEmpty,
        );
        await tester.tap(find.text(permissions));
        await waitFor(
          tester,
          () => find.text('get · example/research #42').evaluate().isNotEmpty,
        );
        await tester.tap(find.widgetWithText(OutlinedButton, revoke));
        await tester.pumpAndSettle();
        expect(writes, ['save']);
        await tester.tap(find.widgetWithText(FilledButton, revoke));
        await waitFor(
          tester,
          () => find
              .text(
                chinese
                    ? '还没有已保存的应用权限。'
                    : 'There are no saved app permissions.',
              )
              .evaluate()
              .isNotEmpty,
        );
        expect(writes, ['save', 'revoke']);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets(
    'workspace or tool ineligible for exact permission still offers one-time approval',
    (tester) async {
      for (final scenario in [
        'team',
        'malformed',
        'shared',
        'member',
        'legacy',
      ]) {
        final message = exactReadAction();
        final action = message['metadata']['appAction'] as Json;
        if (scenario == 'malformed') action['arguments']['extra'] = true;
        if (scenario == 'shared') action['source'] = {'kind': 'shared_bot'};
        if (scenario == 'legacy') action.remove('interactiveApproval');
        final f = await fixture(
          (_) async => throw StateError('Unexpected network request'),
        );
        if (scenario == 'team') f.session.workspace!['kind'] = 'team';
        if (scenario == 'member') f.session.workspace!['role'] = 'member';
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
        expect(find.text('Always allow'), findsNothing);
        expect(find.text('Approve action'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}
