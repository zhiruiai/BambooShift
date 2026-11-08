import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/apps/private_skill_data.dart';
import 'package:openbot_mobile/features/apps/private_skills_screen.dart';
import 'package:openbot_mobile/features/apps/team_publication_controller.dart';
import 'package:openbot_mobile/features/bots/team_skills_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _base = '/api/workspaces/space-a/private-skills';
const _id = '00000000-0000-4000-8000-000000000001';
const _teamId = '00000000-0000-4000-8000-000000000002';
const _oldRevision = '00000000-0000-4000-8000-000000000003';
const _newRevision = '00000000-0000-4000-8000-000000000004';
const _otherTeam = '00000000-0000-4000-8000-000000000005';
const _link = '00000000-0000-4000-8000-000000000006';
const _policy = '00000000-0000-4000-8000-000000000007';
const _targets = '$_base/skill-two/team-publication-targets';
const _publish = '$_base/skill-two/team-publications/$_teamId';
const _content = 'Read original sources before concluding.';
final _source = List.filled(64, 'a').join();
final _older = List.filled(64, 'b').join();

Json _shelf() => {
  'agents': [
    {'id': 'private-bot', 'name': 'Private Bot'},
  ],
  'skills': [
    {
      'id': 'skill-two',
      'sourceAgentId': 'private-bot',
      'sourceAgentName': 'Private Bot',
      'name': 'Evidence review',
      'description': 'Check primary sources',
      'content': _content,
      'available': true,
      'version': 2,
      'revision': _source,
      'enabledAgentIds': <String>[],
    },
  ],
};

Json _summary({required bool current}) => {
  'id': _id,
  'revision': current ? _newRevision : _oldRevision,
  'version': current ? 2 : 1,
  'sourceRevision': current ? _source : _older,
  if (current) 'linkId': _link,
};

Json _destination(Json? publication) => {
  'teams': [
    {
      'workspaceId': _teamId,
      'workspaceName': 'Research team',
      'publication': publication,
    },
    {
      'workspaceId': _otherTeam,
      'workspaceName': 'Review team',
      'publication': null,
    },
  ],
};

void main() {
  testWidgets(
    '320px owner explicitly reviews and syncs an exact prior team copy',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(320, 568);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var synced = false;
      final writes = <Json>[];
      final copies = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copies.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.url.path == _base) return jsonResponse(_shelf());
        if (request.url.path == _targets) {
          expect(request.method, 'GET');
          return jsonResponse(_destination(_summary(current: synced)));
        }
        expect(request.url.path, _publish);
        expect(request.method, 'PUT');
        writes.add(jsonDecode(request.body) as Json);
        synced = true;
        return jsonResponse({'publication': _summary(current: true)});
      });
      await tester.pumpWidget(testApp(PrivateSkillsScreen(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Evidence review').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('Evidence review'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Publish to team'));
      await waitFor(
        tester,
        () => find.text('Destination team').evaluate().isNotEmpty,
      );
      expect(find.text(_content), findsOneWidget);
      final dropdown = find.byType(DropdownButtonFormField<String>);
      await tester.tap(dropdown);
      await tester.pumpAndSettle();
      expect(find.text('Review team'), findsWidgets);
      await tester.tap(find.text('Research team').last);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Currently published as team version 1'),
        findsOneWidget,
      );
      expect(writes, isEmpty);
      expect(find.text('Copy team link'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Sync this version'));
      final success = find.text(
        'The reviewed version was published to the team.',
      );
      for (
        var attempt = 0;
        attempt < 60 &&
            (success.evaluate().isEmpty ||
                find.byType(LinearProgressIndicator).evaluate().isNotEmpty);
        attempt++
      ) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(success, findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(writes, hasLength(1));
      expect(isRequestId(writes.single['requestId']), isTrue);
      expect(writes.single, {
        'requestId': writes.single['requestId'],
        'expectedSourceRevision': _source,
        'expectedPublicationRevision': _oldRevision,
      });
      expect(
        find.text('This version is already published as team version 2.'),
        findsOneWidget,
      );
      final copy = find.text('Copy team link');
      await tester.ensureVisible(copy);
      await tester.pumpAndSettle();
      await tester.tap(copy);
      await tester.pump();
      expect(copies, [
        'https://api.example.test/team-skills/$_teamId/$_id/$_link',
      ]);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Sync this version'),
            )
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'member publishes against the listed policy revision and refreshes a conflict',
    () async {
      var changed = false;
      final writes = <Json>[];
      final f = await fixture((request) async {
        if (request.method == 'GET') {
          return jsonResponse({
            'teams': [
              if (!changed)
                {
                  'workspaceId': _teamId,
                  'workspaceName': 'Research team',
                  'policyRevision': _policy,
                  'publication': null,
                },
              {
                'workspaceId': _otherTeam,
                'workspaceName': 'Review team',
                'publication': null,
              },
            ],
          });
        }
        expect(request.url.path, _publish);
        writes.add(jsonDecode(request.body) as Json);
        changed = true;
        return jsonResponse({
          'code': 'TEAM_SKILL_POLICY_CHANGED',
          'error': 'Changed',
        }, status: 409);
      });
      final skill = PrivateSkillShelf.parse(_shelf()).skills.single;
      final controller = TeamPublicationController(f.scope);
      await controller.refresh(skill);
      await controller.publish(skill, controller.targets.first);
      expect(writes.single['expectedTeamPolicyRevision'], _policy);
      expect(controller.feedback, 'mobileTeamPublishPolicyChanged');
      expect(controller.pending, isEmpty);
      expect(controller.canPublish(skill, controller.targets.single), isTrue);
      expect(controller.targets.single.id, _otherTeam);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'only a forbidden receipt permits removing its local reminder',
    () async {
      var denied = false;
      final operations = <String>[];
      final f = await fixture((request) async {
        if (request.url.path == _targets) {
          return jsonResponse(_destination(null));
        }
        operations.add(request.method);
        if (request.method == 'PUT') {
          throw http.ClientException('Synthetic connection loss');
        }
        return jsonResponse({
          'error': 'Synthetic access failure',
        }, status: denied ? 403 : 401);
      });
      final skill = PrivateSkillShelf.parse(_shelf()).skills.single;
      final controller = TeamPublicationController(f.scope);
      await controller.refresh(skill);
      await controller.publish(skill, controller.targets.first);
      final marker = controller.pending.single;
      await controller.recover(marker, skill: skill);
      expect(controller.canRemoveReminder(marker), isFalse);
      expect(controller.canPublish(skill, controller.targets.last), isTrue);
      denied = true;
      await controller.recover(marker, skill: skill);
      expect(controller.canRemoveReminder(marker), isTrue);
      expect(controller.feedback, 'mobileTeamPublishReceiptForbidden');
      await controller.removeReminder(marker, skill: skill);
      expect(controller.feedback, 'mobileTeamPublishReminderRemoved');
      expect(controller.pending, isEmpty);
      expect(operations, ['PUT', 'GET', 'GET']);
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'ambiguous PUT survives controller recreation and only a definitive fence clears it',
    () async {
      String? requestId;
      final operations = <String>[];
      final f = await fixture((request) async {
        if (request.url.path == _targets) {
          return jsonResponse(_destination(null));
        }
        operations.add(request.method);
        if (request.method == 'PUT') {
          expect(request.url.path, _publish);
          final body = jsonDecode(request.body) as Json;
          expect(body['expectedPublicationRevision'], isNull);
          requestId = body['requestId'] as String;
          throw http.ClientException('Synthetic connection loss');
        }
        expect(request.url.path, '$_publish/$requestId');
        if (request.method == 'GET') {
          return jsonResponse({
            'code': 'TEAM_SKILL_PUBLICATION_NOT_FOUND',
            'error': 'Missing receipt',
          }, status: 404);
        }
        return jsonResponse({'status': 'cancelled'});
      });
      final skill = PrivateSkillShelf.parse(_shelf()).skills.single;
      final original = TeamPublicationController(f.scope);
      await original.refresh(skill);
      await original.publish(skill, original.targets.first);
      expect(original.feedback, 'mobileTeamPublishUnknown');
      expect(original.canPublish(skill, original.targets.first), isFalse);
      expect(original.canPublish(skill, original.targets.last), isTrue);
      expect(
        f.secrets.values.values.any((value) => value.contains(_content)),
        isFalse,
      );
      original.dispose();

      final restored = TeamPublicationController(f.scope);
      await restored.refresh();
      final marker = restored.pending.single;
      expect(marker.id, requestId);
      await restored.recover(marker);
      expect(restored.feedback, 'mobileTeamPublishNotFound');
      expect(restored.pending, hasLength(1));
      await restored.recover(marker, cancel: true);
      expect(restored.feedback, 'mobileTeamPublishCancelled');
      expect(restored.pending, isEmpty);
      expect(operations, ['PUT', 'GET', 'DELETE']);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    '390px team viewer can open a private-origin copy with neutral provenance',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(390, 760);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final copies = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copies.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final f = await fixture((request) async {
        expect(request.method, 'GET');
        if (request.url.path.endsWith('/import-targets')) {
          return jsonResponse([]);
        }
        return jsonResponse([
          {
            'id': _id,
            'revision': _newRevision,
            'version': 1,
            'name': 'Evidence review',
            'description': 'Check primary sources',
            'content': _content,
            'linkId': _link,
            'canWithdraw': false,
            'canModerate': false,
            'source': {'origin': 'personal', 'version': 2},
          },
        ]);
      });
      final team = {
        ...f.session.workspace!,
        'id': _teamId,
        'kind': 'team',
        'role': 'member',
      };
      f.session.workspaces = [...f.session.workspaces, team];
      f.session.selectWorkspace(team);
      final scope = WorkspaceController(f.session);
      await tester.pumpWidget(
        testApp(
          TeamSkillsScreen(scope: scope, sourceAgentId: 'unused'),
          locale: const Locale('zh'),
        ),
      );
      await waitFor(
        tester,
        () => find.text('v1 · 来自个人技能库').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('Evidence review'));
      await tester.pumpAndSettle();
      expect(find.text(_content), findsOneWidget);
      expect(find.text('Private Bot'), findsNothing);
      expect(find.text('撤回发布'), findsNothing);
      await tester.tap(find.text('复制团队链接'));
      await tester.pump();
      expect(copies, [
        'https://api.example.test/team-skills/$_teamId/$_id/$_link',
      ]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      scope.dispose();
      f.session.dispose();
    },
  );

  for (final owner in [false, true]) {
    testWidgets(
      '390px ${owner ? 'owner moderates' : 'member withdraws own'} publication',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = const Size(390, 660);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final writes = <Json>[];
        final f = await fixture((request) async {
          if (request.method == 'POST') {
            expect(
              request.url.path,
              '/api/workspaces/space-a/team-skills/$_id/unpublish',
            );
            writes.add(jsonDecode(request.body) as Json);
            return jsonResponse({'ok': true});
          }
          if (request.url.path.endsWith('/import-targets')) {
            return jsonResponse([]);
          }
          return jsonResponse([
            {
              'id': _id,
              'revision': _newRevision,
              'version': 1,
              'name': 'Evidence review',
              'description': 'Check primary sources',
              'content': _content,
              'source': {'origin': 'personal', 'version': 2},
              'canWithdraw': true,
              'canModerate': owner,
            },
          ]);
        });
        f.session.workspace!
          ..['kind'] = 'team'
          ..['role'] = owner ? 'owner' : 'member';
        await tester.pumpWidget(
          testApp(TeamSkillsScreen(scope: f.scope, sourceAgentId: 'unused')),
        );
        final item = find.text('Evidence review');
        await waitFor(tester, () => item.evaluate().isNotEmpty);
        await tester.tap(item);
        await tester.pumpAndSettle();
        await tester.tap(find.text(owner ? 'Remove publication' : 'Withdraw'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining(
            owner ? 'prevent the same source' : 'Withdraw this version',
          ),
          findsOneWidget,
        );
        expect(writes, isEmpty);
        await tester.tap(find.widgetWithText(FilledButton, 'Done'));
        await waitFor(tester, () => item.evaluate().isEmpty);
        expect(writes, [
          {'expectedRevision': _newRevision},
        ]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
}
