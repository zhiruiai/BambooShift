import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/settings/account_settings.dart';
import 'package:openbot_mobile/features/settings/team_settings.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  testWidgets(
    'account profile changes keep the fixed account and refreshed name',
    (tester) async {
      Json? saved;
      final f = await fixture((request) async {
        if (request.url.path.endsWith('/sessions')) {
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          return jsonResponse({'userId': 'user-a', 'sessions': []});
        }
        if (request.method == 'PATCH') {
          expect(request.url.path, '/api/account/profile');
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          saved = jsonDecode(request.body) as Json;
          return jsonResponse({'ok': true});
        }
        return jsonResponse({
          'authenticated': true,
          'user': {'id': 'user-a', 'name': saved!['name']},
          'workspaces': [],
        });
      });
      await tester.pumpWidget(testApp(AccountSettings(session: f.session)));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'Updated person');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await waitFor(tester, () => f.session.user?['name'] == 'Updated person');
      expect(saved, {'expectedUserId': 'user-a', 'name': 'Updated person'});
      f.session.user = {'id': 'other-user', 'name': 'Other'};
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(f.session.userId, 'other-user');
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('team owner can create an invitation using the captured space', (
    tester,
  ) async {
    var invitations = 0;
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.method == 'POST') {
        expect(request.url.path, '/api/account/workspaces/space-a/invitations');
        invitations++;
        return jsonResponse({
          'token': 'synthetic-invitation',
          'invitation': {'id': 'invite-a'},
        });
      }
      expect(request.url.path, '/api/account/workspaces/space-a/team');
      return jsonResponse({
        'workspace': {'id': 'space-a', 'kind': 'team'},
        'members': [
          {'userId': 'user-a', 'name': 'Owner', 'role': 'owner'},
        ],
        'invitations': [],
      });
    });
    f.session.workspace!['kind'] = 'team';
    await tester.pumpWidget(testApp(TeamSettings(scope: f.scope)));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create invitation'));
    await waitFor(
      tester,
      () => find.byType(SelectableText).evaluate().isNotEmpty,
    );
    expect(invitations, 1);
    expect(find.text('synthetic-invitation'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'team members see localized membership and only their own leave control',
    (tester) async {
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method != 'GET') writes++;
        return jsonResponse({
          'workspace': {'id': 'space-a', 'kind': 'team'},
          'members': [
            {'userId': 'user-a', 'name': 'Me', 'role': 'member'},
            {'userId': 'user-b', 'name': 'Peer', 'role': 'member'},
            {'userId': 'owner', 'name': 'Owner', 'role': 'owner'},
          ],
          'invitations': [],
        });
      });
      f.session.workspace!['kind'] = 'team';
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(
        testApp(TeamSettings(scope: f.scope), locale: const Locale('zh')),
      );
      await waitFor(tester, () => find.text('Peer').evaluate().isNotEmpty);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byIcon(Icons.person_remove_outlined), findsOneWidget);
      expect(writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
