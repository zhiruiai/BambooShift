import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/settings/team_skill_policy_screen.dart';
import 'package:openbot_mobile/features/settings/workspace_settings.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _path = '/api/workspaces/space-a/team-skills/publishing-policy';
const _revision = '00000000-0000-4000-8000-000000000007';

void main() {
  testWidgets('320px owner explicitly saves the current policy revision', (
    tester,
  ) async {
    tester.view
      ..devicePixelRatio = 1
      ..physicalSize = const Size(320, 568);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final writes = <Json>[];
    final f = await fixture((request) async {
      expect(request.url.path, _path);
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.method == 'GET') {
        return jsonResponse({'memberPublishing': false, 'revision': 'unset'});
      }
      expect(request.method, 'PUT');
      writes.add(jsonDecode(request.body) as Json);
      return jsonResponse({'memberPublishing': true, 'revision': _revision});
    });
    f.session.workspace!['kind'] = 'team';
    await tester.pumpWidget(
      testApp(
        Scaffold(body: WorkspaceSettings(scope: f.scope)),
        locale: const Locale('zh'),
      ),
    );
    final entry = find.text('技能发布权限');
    await tester.scrollUntilVisible(entry, 110);
    await tester.tap(entry);
    final toggle = find.byType(SwitchListTile);
    await waitFor(tester, () => toggle.evaluate().isNotEmpty);
    expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(writes, isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    final saved = find.text('已保存团队技能发布权限。');
    await waitFor(tester, () => saved.evaluate().isNotEmpty);
    expect(writes, [
      {'memberPublishing': true, 'expectedRevision': 'unset'},
    ]);
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('ambiguous policy save only reads back the current state', (
    tester,
  ) async {
    final operations = <String>[];
    final f = await fixture((request) async {
      operations.add(request.method);
      if (request.method == 'PUT') {
        throw http.ClientException('Synthetic disconnect');
      }
      final changed = operations.length > 1;
      return jsonResponse({
        'memberPublishing': changed,
        'revision': changed ? _revision : 'unset',
      });
    });
    f.session.workspace!['kind'] = 'team';
    await tester.pumpWidget(testApp(TeamSkillPolicyScreen(scope: f.scope)));
    final toggle = find.byType(SwitchListTile);
    await waitFor(tester, () => toggle.evaluate().isNotEmpty);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    final save = find.widgetWithText(FilledButton, 'Save');
    await tester.tap(save);
    final readback = find.text(
      'The current policy was reloaded from the server.',
    );
    await waitFor(tester, () => readback.evaluate().isNotEmpty);
    expect(operations, ['GET', 'PUT', 'GET']);
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    expect(tester.widget<FilledButton>(save).onPressed, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('a team member cannot read or write the owner setting', (
    tester,
  ) async {
    var requests = 0;
    final f = await fixture((request) async {
      requests++;
      return jsonResponse({});
    });
    f.session.workspace!
      ..['kind'] = 'team'
      ..['role'] = 'member';
    await tester.pumpWidget(testApp(TeamSkillPolicyScreen(scope: f.scope)));
    await tester.pumpAndSettle();
    expect(find.byType(SwitchListTile), findsNothing);
    expect(requests, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
