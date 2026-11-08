import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/bot_settings.dart';
import 'package:openbot_mobile/features/bots/group_settings.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'routine_operation_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json alias({bool available = true}) => {
  'id': 'bot-a',
  'name': 'Personal reference',
  'role': 'Research',
  'sharedBot': {'status': 'active', 'available': available},
};

void main() {
  testWidgets('owner runs an alias routine using the personal workspace', (
    tester,
  ) async {
    Json? submitted;
    final data = bootstrap(agents: [alias()])
      ..['routines'] = [routineFixture()];
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.method == 'POST') {
        expect(request.url.path, '/api/workspaces/space-a/routine-operations');
        submitted = jsonDecode(request.body) as Json;
        return jsonResponse(operationReceipt(submitted!));
      }
      return jsonResponse(data);
    });
    f.scope.data = data;
    await tester.pumpWidget(
      testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
    );
    await tester.pumpAndSettle();
    expect(find.byTooltip('New routine'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Run now'));
    await tester.pumpAndSettle();
    expect(submitted, isNull);
    await tester.tap(find.widgetWithText(FilledButton, 'Done'));
    await waitFor(tester, () => submitted != null);
    expect(submitted!['kind'], 'run');
    expect(submitted!['expectedRoutine'], routineConfigFixture());
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('unavailable alias plans stay editable but cannot start', (
    tester,
  ) async {
    var writes = 0;
    final f = await fixture((request) async {
      if (request.method != 'GET') writes++;
      return jsonResponse({});
    });
    f.scope.data = bootstrap(agents: [alias(available: false)])
      ..['routines'] = [routineFixture()];
    await tester.pumpWidget(
      testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<IconButton>(find.widgetWithIcon(IconButton, Icons.add))
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Run now'))
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Edit'))
          .onPressed,
      isNotNull,
    );
    expect(find.byTooltip('Delete'), findsOneWidget);
    expect(writes, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('group editing accepts an active personal shared reference', (
    tester,
  ) async {
    Json? submitted;
    final chat = {
      'id': 'group-a',
      'title': 'Synthetic group',
      'isGroup': true,
      'agentIds': ['local-a'],
    };
    final data = bootstrap(
      agents: [
        {'id': 'local-a', 'name': 'Local', 'role': 'Coordinator'},
        alias(),
        {
          ...alias(available: false),
          'id': 'unavailable',
          'name': 'Unavailable',
        },
      ],
    )..['conversations'] = [chat];
    final f = await fixture((request) async {
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      if (request.method == 'PATCH') {
        submitted = jsonDecode(request.body) as Json;
        return jsonResponse({'conversation': chat, 'revision': 'updated'});
      }
      return request.url.path.endsWith('/bootstrap')
          ? jsonResponse(data)
          : jsonResponse({'conversation': chat, 'revision': 'original'});
    });
    f.scope.data = data;
    f.session.workspace!['role'] = 'member';
    await tester.pumpWidget(
      testApp(GroupSettings(scope: f.scope, conversationId: 'group-a')),
    );
    await tester.pumpAndSettle();
    await waitFor(
      tester,
      () =>
          tester
              .widget<TextFormField>(find.byType(TextFormField).first)
              .controller!
              .text ==
          'Synthetic group',
    );
    expect(
      tester
          .widget<CheckboxListTile>(
            find.widgetWithText(CheckboxListTile, 'Unavailable'),
          )
          .onChanged,
      isNull,
    );
    await tester.tap(
      find.widgetWithText(CheckboxListTile, 'Personal reference'),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<CheckboxListTile>(
            find.widgetWithText(CheckboxListTile, 'Personal reference'),
          )
          .value,
      isTrue,
    );
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Save'));
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await waitFor(tester, () => submitted != null);
    expect(submitted!['agentIds'], ['local-a', 'bot-a']);
    expect(submitted!['expectedRevision'], 'original');
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('a malformed managed marker cannot become an editable Bot', (
    tester,
  ) async {
    var writes = 0;
    final f = await fixture((request) async {
      writes++;
      return jsonResponse({});
    });
    final bot = {...alias(), 'sharedBot': null, 'configRevision': 'synthetic'};
    await tester.pumpWidget(testApp(BotSettings(scope: f.scope, bot: bot)));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
    expect(
      tester.widget<TextFormField>(find.byType(TextFormField).first).enabled,
      isFalse,
    );
    expect(writes, 0);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
