import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/connections_list.dart';
import 'package:openbot_mobile/features/apps/private_skill_controller.dart';
import 'package:openbot_mobile/features/apps/private_skill_data.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const shelfPath = '/api/workspaces/space-a/private-skills';
final v1 = List.filled(64, 'a').join();
final v2 = List.filled(64, 'b').join();
final content =
    '# Review\n${List.filled(120, 'Read-only synthetic content.').join('\n')}\nFinal instruction.';
Finder selectable(String value) => find.byWidgetPredicate(
  (widget) => widget is SelectableText && widget.data == value,
);

Json privateShelf({bool old = true, bool enabled = false}) => {
  'agents': [
    {'id': 'source-bot', 'name': 'Source Bot'},
    {'id': 'target-bot', 'name': 'Target Bot'},
    {'id': 'other-bot', 'name': 'Another Bot'},
  ],
  'skills': [
    {
      'id': 'skill-v2',
      'sourceAgentId': 'source-bot',
      'sourceAgentName': 'Source Bot',
      'name': 'Research checklist',
      'description': 'Synthetic description',
      'content': content,
      'version': 2,
      'revision': v2,
      'available': true,
      'enabledAgentIds': [if (enabled) 'target-bot'],
    },
    if (old)
      {
        'id': 'skill-v1',
        'sourceAgentId': 'source-bot',
        'sourceAgentName': 'Source Bot',
        'name': 'Research checklist',
        'description': 'Earlier version',
        'content': 'Original synthetic skill.',
        'version': 1,
        'revision': v1,
        'available': false,
        'enabledAgentIds': ['target-bot'],
      },
  ],
};

void main() {
  for (final chinese in [false, true]) {
    testWidgets(
      'private skill ${chinese ? 'Chinese' : 'English'} exact review, pin and replace',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = Size(chinese ? 390 : 320, chinese ? 760 : 568);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var old = true, enabled = false;
        final writes = <String>[];
        final f = await fixture((request) async {
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          final path = request.url.path;
          if (request.method == 'GET') {
            if (path.endsWith('/bootstrap')) return jsonResponse(bootstrap());
            if (path.endsWith('/apps')) return jsonResponse([]);
            expect(path, shelfPath);
            return jsonResponse(privateShelf(old: old, enabled: enabled));
          }
          expect(request.method, 'PUT');
          if (path == '$shelfPath/skill-v1/bots/target-bot') {
            expect(jsonDecode(request.body), {
              'enabled': false,
              'expectedRevision': v1,
            });
            writes.add('disable');
            old = false;
            return jsonResponse({'enabled': false});
          }
          expect(path, '$shelfPath/skill-v2/bots/target-bot');
          expect(jsonDecode(request.body), {
            'enabled': true,
            'expectedRevision': v2,
          });
          writes.add('enable');
          enabled = true;
          if (chinese) throw http.ClientException('Synthetic lost response');
          return jsonResponse({'enabled': true});
        });
        final locale = Locale(chinese ? 'zh' : 'en');
        final private = chinese ? '私有技能' : 'Private skills';
        final enable = chinese ? '启用此版本' : 'Enable this version';
        final disable = chinese ? '停用此版本' : 'Disable this version';
        final confirm = chinese ? '完成' : 'Done';
        final cancel = chinese ? '取消' : 'Cancel';
        final previous = chinese ? '查看已安装版本' : 'Review installed version';
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
        await tester.tap(find.text(private));
        await waitFor(
          tester,
          () => find.text('Research checklist').evaluate().length == 2,
        );
        await tester.tap(find.text('Research checklist').first);
        await tester.pumpAndSettle();
        expect(selectable(content), findsOneWidget);
        expect(selectable(v2), findsOneWidget);
        expect(
          tester
              .widget<FilledButton>(find.widgetWithText(FilledButton, enable))
              .onPressed,
          isNull,
        );
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await tester.pumpAndSettle();
        expect(find.text('Source Bot'), findsNothing);
        await tester.tap(find.text('Target Bot').last);
        await tester.pumpAndSettle();
        expect(writes, isEmpty);
        expect(find.widgetWithText(FilledButton, enable), findsNothing);
        await tester.tap(find.widgetWithText(OutlinedButton, previous));
        await tester.pumpAndSettle();
        expect(selectable('Original synthetic skill.'), findsOneWidget);
        expect(selectable(v1), findsOneWidget);
        expect(find.text('Another Bot'), findsNothing);
        await tester.tap(find.widgetWithText(FilledButton, disable));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, confirm));
        await waitFor(
          tester,
          () => find
              .text(chinese ? '技能版本已停用。' : 'Skill version disabled.')
              .evaluate()
              .isNotEmpty,
        );
        expect(writes, ['disable']);
        await tester.tap(find.text('Research checklist'));
        await tester.pumpAndSettle();
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Target Bot').last);
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, enable));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(TextButton, cancel));
        await tester.pumpAndSettle();
        expect(writes, ['disable']);
        await tester.tap(find.widgetWithText(FilledButton, enable));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, confirm));
        await waitFor(
          tester,
          () => find
              .text(chinese ? '技能版本已启用。' : 'Skill version enabled.')
              .evaluate()
              .isNotEmpty,
        );
        expect(writes, ['disable', 'enable']);
        expect(find.widgetWithText(FilledButton, disable), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  test(
    'unknown skill write blocks any retry until authoritative refresh',
    () async {
      var writes = 0, online = true;
      final f = await fixture((request) async {
        if (request.method == 'PUT') {
          writes++;
          online = false;
          throw http.ClientException('Synthetic lost response');
        }
        if (!online) {
          return jsonResponse({'error': 'Synthetic read failure'}, status: 503);
        }
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(bootstrap());
        }
        return jsonResponse(privateShelf(old: false, enabled: writes > 0));
      });
      final c = PrivateSkillController(f.scope);
      await c.refresh();
      final skill = c.shelf.skills.single;
      await c.change(skill, 'source-bot', true);
      expect(writes, 0);
      await c.change(skill, 'target-bot', true);
      expect(writes, 1);
      expect(c.canWrite, false);
      expect(c.feedback, 'mobileAppsPrivateSkillUnconfirmed');
      await c.change(skill, 'target-bot', true);
      expect(writes, 1);
      online = true;
      await c.refresh();
      expect(c.feedback, 'mobileAppsPrivateSkillEnabled');
      expect(c.canChange(skill, 'target-bot', true), false);
      expect(c.canChange(skill, 'target-bot', false), true);
      expect(writes, 1);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test('team and malformed shelf cannot supply a target', () async {
    final malformed = privateShelf();
    malformed['skills'][0]['enabledAgentIds'] = ['source-bot'];
    expect(
      () => PrivateSkillShelf.parse(malformed),
      throwsA(isA<ApiException>()),
    );
    var requests = 0;
    final f = await fixture((_) async {
      requests++;
      return jsonResponse(privateShelf());
    });
    f.session.workspace!['kind'] = 'team';
    final c = PrivateSkillController(f.scope);
    await c.refresh();
    expect(requests, 0);
    expect(c.active, false);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });

  test(
    'stale and conflicting skill choices refresh without resubmitting',
    () async {
      for (final code in [
        'PRIVATE_SKILL_CHANGED',
        'PRIVATE_SKILL_NAME_CONFLICT',
      ]) {
        final operations = <String>[];
        final f = await fixture((request) async {
          operations.add(request.method);
          if (request.method == 'PUT') {
            return jsonResponse({
              'code': code,
              'error': 'Synthetic conflict',
            }, status: 409);
          }
          return jsonResponse(privateShelf(old: false));
        });
        final c = PrivateSkillController(f.scope);
        await c.refresh();
        await c.change(c.shelf.skills.single, 'target-bot', true);
        expect(operations, ['GET', 'PUT', 'GET']);
        expect(
          c.feedback,
          code.endsWith('CHANGED')
              ? 'mobileAppsPrivateSkillChanged'
              : 'mobileAppsPrivateSkillNameConflict',
        );
        expect(c.shelf.skills.single.enabledAgentIds, isEmpty);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}
