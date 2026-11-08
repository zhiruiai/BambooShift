import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/knowledge_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const sourceId = '10000000-0000-4000-8000-000000000001';
const sourceTwo = '10000000-0000-4000-8000-000000000002';
const publicationId = '20000000-0000-4000-8000-000000000001';
const revisionOne = '30000000-0000-4000-8000-000000000001';
const revisionTwo = '30000000-0000-4000-8000-000000000002';
const revisionThree = '30000000-0000-4000-8000-000000000003';

Json skill(String id) => {
  'id': id,
  'agentId': 'source-bot',
  'name': 'Review evidence',
  'description': 'Check dates and citations',
  'content': id == sourceId
      ? 'Original reviewed text'
      : 'Updated reviewed text',
  'status': 'active',
  'version': id == sourceId ? 1 : 2,
};

Json publication(Json row, int version, String revision) => {
  'id': publicationId,
  'version': version,
  'revision': revision,
  'name': row['name'],
  'description': row['description'],
  'content': row['content'],
  'source': {
    'agentId': 'source-bot',
    'agentName': 'Research Bot',
    'skillId': row['id'],
    'version': row['version'],
  },
};

void main() {
  testWidgets(
    'phone owner reviews publish and sync, withdraws and imports a pinned proposal',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final posted = <(String, Json)>[];
      var active = skill(sourceId);
      Json? current, copy;
      Json snapshot() => {
        ...bootstrap(
          agents: [
            {'id': 'source-bot', 'name': 'Research Bot'},
            {'id': 'target-bot', 'name': 'Review Bot'},
          ],
        ),
        'skills': [active, ?copy],
      };
      var version = 0;
      final f = await fixture((request) async {
        final path = request.url.path;
        if (path.endsWith('/bootstrap')) return jsonResponse(snapshot());
        if (path.endsWith('/import-targets')) return jsonResponse([]);
        if (request.method == 'GET') {
          return jsonResponse([?current]);
        }
        final body = jsonDecode(request.body) as Json;
        posted.add((path.split('/').last, body));
        if (path.endsWith('/import')) {
          copy = {
            ...active,
            'id': 'local-proposal',
            'agentId': body['agentId'],
            'status': 'proposed',
            'teamSource': {
              'id': publicationId,
              'revision': body['expectedRevision'],
              'version': current?['version'],
            },
          };
          return jsonResponse(copy!);
        }
        if (path.endsWith('/unpublish')) {
          current = null;
          return jsonResponse({'ok': true});
        }
        final revision = [revisionOne, revisionTwo, revisionThree][version++];
        current = publication(active, version, revision);
        return jsonResponse(current!);
      });
      f.session.workspace!['kind'] = 'team';
      f.scope.data = snapshot();
      await tester.pumpWidget(
        testApp(
          KnowledgeScreen(
            scope: f.scope,
            agentId: 'source-bot',
            kind: 'skills',
          ),
        ),
      );
      await tester.tap(
        find.widgetWithText(OutlinedButton, 'Team skill catalog'),
      );
      final publish = find.widgetWithText(TextButton, 'Publish to team');
      await waitFor(tester, () => publish.evaluate().isNotEmpty);
      await tester.tap(publish);
      await tester.pumpAndSettle();
      expect(find.text('Original reviewed text'), findsOneWidget);
      expect(posted, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Publish to team'));
      await waitFor(
        tester,
        () => find.text('v1 · Research Bot').evaluate().isNotEmpty,
      );
      expect(posted[0].$1, 'team-skills');
      expect(posted[0].$2, {'skillId': sourceId, 'expectedRevision': null});

      active = skill(sourceTwo);
      await tester.runAsync(f.scope.refresh);
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(TextButton, 'Sync approved version'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Updated reviewed text'), findsOneWidget);
      await tester.tap(
        find.widgetWithText(FilledButton, 'Sync approved version'),
      );
      await waitFor(
        tester,
        () => find.text('v2 · Research Bot').evaluate().isNotEmpty,
      );
      expect(posted[1].$1, 'team-skills');
      expect(posted[1].$2, {
        'skillId': sourceTwo,
        'expectedRevision': revisionOne,
      });

      await tester.tap(find.text('v2 · Research Bot'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Withdraw'));
      await tester.pumpAndSettle();
      expect(posted.length, 2);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => publish.evaluate().isNotEmpty);
      expect(posted[2].$1, 'unpublish');
      expect(posted[2].$2, {'expectedRevision': revisionTwo});
      expect(find.text('v2 · Research Bot'), findsNothing);

      await tester.tap(publish);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Publish to team'));
      await waitFor(
        tester,
        () => find.text('v3 · Research Bot').evaluate().isNotEmpty,
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review Bot').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('v3 · Research Bot'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(OutlinedButton, 'Import for review'),
      );
      final target = find.byWidgetPredicate(
        (widget) => widget is KnowledgeScreen && widget.agentId == 'target-bot',
      );
      await waitFor(tester, () => target.evaluate().isNotEmpty);
      expect(posted[4].$1, 'import');
      expect(posted[4].$2, {
        'agentId': 'target-bot',
        'expectedRevision': revisionThree,
      });
      expect(posted.length, 5);
      expect(copy?['status'], 'proposed');
      await tester.tap(find.text('Review evidence'));
      await tester.pumpAndSettle();
      expect(find.text('Copied from team publication v3'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('team member imports a pinned version into a personal Bot', (
    tester,
  ) async {
    const personal = '40000000-0000-4000-8000-000000000001';
    const agentId = 'personal-bot';
    Json? imported;
    final f = await fixture((request) async {
      final path = request.url.path;
      if (path.endsWith('/import-targets')) {
        return jsonResponse([
          {
            'workspaceId': personal,
            'workspaceName': 'Personal space',
            'agents': [
              {'id': agentId, 'name': 'My Bot'},
            ],
          },
        ]);
      }
      if (path.endsWith('/import')) {
        imported = jsonDecode(request.body) as Json;
        return jsonResponse({
          'agentId': agentId,
          'status': 'proposed',
          'teamSource': {'id': publicationId, 'revision': revisionOne},
        });
      }
      return jsonResponse([publication(skill(sourceId), 1, revisionOne)]);
    });
    f.session.workspace!['kind'] = 'team';
    f.session.workspace!['role'] = 'member';
    f.scope.data = {
      ...bootstrap(
        agents: [
          {'id': 'source-bot', 'name': 'Research Bot'},
          {'id': 'team-bot', 'name': 'Another team Bot'},
        ],
      ),
      'skills': [skill(sourceId)],
    };
    await tester.pumpWidget(
      testApp(
        KnowledgeScreen(scope: f.scope, agentId: 'source-bot', kind: 'skills'),
      ),
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Team skill catalog'));
    final chooser = find.byType(DropdownButtonFormField<String>);
    await waitFor(tester, () => chooser.evaluate().isNotEmpty);
    await tester.tap(chooser);
    await tester.pumpAndSettle();
    expect(find.text('Another team Bot'), findsNothing);
    await tester.tap(find.text('Personal space · My Bot').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('v1 · Research Bot'));
    await tester.pumpAndSettle();
    expect(find.text('Original reviewed text'), findsOneWidget);
    expect(find.text('Withdraw'), findsNothing);
    expect(find.text('Publish to team'), findsNothing);
    expect(imported, isNull);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Import for review'));
    await waitFor(
      tester,
      () =>
          find.textContaining('Saved a skill for review').evaluate().isNotEmpty,
    );
    expect(imported, {
      'agentId': agentId,
      'targetWorkspaceId': personal,
      'expectedRevision': revisionOne,
    });
    expect(f.session.workspace!['id'], 'space-a');
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
