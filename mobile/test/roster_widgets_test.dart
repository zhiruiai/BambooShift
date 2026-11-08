import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/roster/roster_controller.dart';
import 'package:openbot_mobile/features/roster/roster_list.dart';
import 'package:openbot_mobile/features/roster/roster_screen.dart';

import 'model_profiles_layout_test.dart' show expectReadableText;
import 'roster_projection_test.dart' show chat, entry, roster;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  testWidgets(
    'section headers collapse in place and persist the observed roster revision',
    (tester) async {
      var collapsed = false, revision = 'revision-a';
      final writes = <Json>[];
      Json state() => roster(
        revision: revision,
        sections: [
          {'id': 'section-a', 'name': 'Research', 'collapsed': collapsed},
        ],
        entries: [entry('bot-a', section: 'section-a')],
      );
      Json data() => {
        ...bootstrap(),
        'sidebarRoster': state(),
        'conversations': [chat('chat-a', 'bot-a')],
      };
      final value = await fixture((request) async {
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(data());
        }
        if (request.method == 'GET') return jsonResponse(state());
        final body = jsonDecode(request.body) as Json;
        expect(body['expectedRevision'], revision);
        expect(body['operation']['type'], 'set-section-collapsed');
        writes.add(body);
        collapsed = body['operation']['collapsed'] as bool;
        revision = 'revision-${writes.length}';
        return jsonResponse(state());
      });
      value.scope.data = data();
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ListenableBuilder(
              listenable: value.scope,
              builder: (_, _) => ListView(
                children: [RosterList(scope: value.scope, onOpen: (_) {})],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('chat-a'), findsOneWidget);
      await tester.tap(find.text('Research'));
      await waitFor(
        tester,
        () => writes.length == 1 && find.text('chat-a').evaluate().isEmpty,
      );
      expect(find.byType(RosterScreen), findsNothing);
      expect(writes.single['operation']['collapsed'], true);
      await tester.tap(find.text('Research'));
      await waitFor(
        tester,
        () => writes.length == 2 && find.text('chat-a').evaluate().isNotEmpty,
      );
      expect(writes.last['operation']['collapsed'], false);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      value.scope.dispose();
      value.session.dispose();
    },
  );

  for (final language in ['en', 'zh']) {
    testWidgets(
      'hidden conversation can be explicitly restored on a phone in $language',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var current = roster(entries: [entry('bot-a', hidden: true)]);
        Json? submitted;
        Json data() => {
          ...bootstrap(),
          'conversations': [chat('chat-a', 'bot-a')],
          'sidebarRoster': current,
        };
        final value = await fixture((request) async {
          if (request.url.path.endsWith('/bootstrap')) {
            return jsonResponse(data());
          }
          if (request.method == 'GET') return jsonResponse(current);
          submitted = jsonDecode(request.body) as Json;
          current = roster(revision: 'revision-b');
          return jsonResponse(current);
        });
        value.scope.data = data();
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: ListView(
                children: [RosterList(scope: value.scope, onOpen: (_) {})],
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('chat-a'), findsNothing);
        final manage = find.widgetWithText(
          TextButton,
          language == 'en' ? 'Manage conversations' : '管理会话',
        );
        await tester.tap(manage);
        await waitFor(tester, () {
          if (find.byType(RosterScreen).evaluate().isEmpty) {
            return false;
          }
          final controller =
              (tester.state(find.byType(RosterScreen)) as dynamic).model
                  as RosterController;
          return controller.ready && !controller.busy;
        });
        final model =
            (tester.state(find.byType(RosterScreen)) as dynamic).model
                as RosterController;
        await waitFor(tester, () => model.ready);
        expect(submitted, isNull);
        expect(
          find.text(language == 'en' ? 'Hidden conversations' : '已隐藏的会话'),
          findsOneWidget,
        );
        await tester.tap(
          find.byTooltip(language == 'en' ? 'Conversation actions' : '会话操作'),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.text(language == 'en' ? 'Restore to list' : '恢复到列表'),
        );
        await waitFor(tester, () => !model.busy && submitted != null);
        expect(submitted, {
          'expectedRevision': 'revision-a',
          'operation': {
            'type': 'set-entry',
            'target': {'kind': 'bot', 'id': 'bot-a'},
            'hidden': false,
          },
        });
        expect(
          find.text(language == 'en' ? 'Hidden conversations' : '已隐藏的会话'),
          findsNothing,
        );
        expect(find.text('chat-a'), findsOneWidget);
        expect(tester.takeException(), isNull);
        for (final paragraph in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(paragraph.text);
        }
        await tester.pumpWidget(const SizedBox());
        value.scope.dispose();
        value.session.dispose();
      },
    );
  }
}
