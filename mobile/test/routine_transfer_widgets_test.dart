import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_controller.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_data.dart';
import 'package:openbot_mobile/features/routines/routine_transfer_screen.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';

import 'model_profiles_layout_test.dart' show expectReadableText;
import 'routine_transfer_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Future<void> reveal(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    220,
    scrollable: find
        .descendant(
          of: find.byType(ListView).last,
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final lang in ['en', 'zh']) {
    testWidgets(
      'phone $lang explicit target confirmation transfers once without running',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final server = TransferServer();
        final f = await fixture(server.handle);
        f.scope.data = server.data;
        await tester.pumpWidget(
          testApp(
            RoutineTransferScreen(scope: f.scope, routine: transferRoutine()),
            locale: Locale(lang),
          ),
        );
        final c =
            (tester.state(find.byType(RoutineTransferScreen)) as dynamic)
                    .controller
                as RoutineTransferController;
        await waitFor(tester, () => c.ready && !c.busy);
        final bot = find.widgetWithText(ListTile, 'Bot b');
        await reveal(tester, bot);
        await tester.tap(bot);
        await tester.pumpAndSettle();
        expect(find.text('Bot shared'), findsNothing);
        expect(find.text('Bot duplicate'), findsNothing);
        final transfer = find.widgetWithText(
          FilledButton,
          lang == 'en' ? 'Transfer to Bot…' : '转交给 Bot…',
        );
        await reveal(tester, transfer);
        await tester.tap(transfer);
        await tester.pumpAndSettle();
        expect(server.transfers, 0);
        for (final p in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(p.text);
        }
        await tester.tap(
          find.widgetWithText(FilledButton, lang == 'en' ? 'Done' : '完成'),
        );
        await waitFor(tester, () => c.receipt != null && !c.busy);
        expect(server.transfers, 1);
        expect(server.requests.any((r) => r.url.path.endsWith('/run')), false);
        expect(
          find.text(
            lang == 'en'
                ? 'The routine was transferred. It was not run immediately.'
                : '任务已转交，未立即执行。',
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
  testWidgets(
    'original empty Bot list retains recovery after accepted transfer and remount',
    (tester) async {
      final server = TransferServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      final record = {
        'version': 1,
        'requestId': '11111111-1111-4111-8111-111111111111',
        'userId': 'user-a',
        'workspaceId': 'space-a',
        'routineId': 'routine-a',
        'sourceAgentId': 'bot-a',
        'sourceConversationId': 'chat-a',
        'targetAgentId': 'bot-b',
        'targetConversationId': 'chat-b',
      };
      server.data['routines'] = [
        {...transferRoutine(), 'agentId': 'bot-b', 'conversationId': 'chat-b'},
      ];
      server.saved = server.receipt(record);
      await f.secrets.write(transferStorageKey(f.scope), jsonEncode(record));
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      final recovery = find.widgetWithText(
        TextButton,
        'Check previous transfer',
      );
      await waitFor(tester, () => recovery.evaluate().isNotEmpty);
      expect(find.text('Synthetic review'), findsNothing);
      await tester.tap(recovery);
      await tester.pump();
      await waitFor(
        tester,
        () =>
            find.byType(RoutineTransferScreen).evaluate().isNotEmpty &&
            ((tester.state(find.byType(RoutineTransferScreen)) as dynamic)
                            .controller
                        as RoutineTransferController)
                    .receipt !=
                null &&
            !((tester.state(find.byType(RoutineTransferScreen)) as dynamic)
                        .controller
                    as RoutineTransferController)
                .busy,
      );
      final c =
          (tester.state(find.byType(RoutineTransferScreen)) as dynamic)
                  .controller
              as RoutineTransferController;
      await waitFor(tester, () => c.receipt != null && !c.busy);
      expect(server.transfers, 0);
      expect(c.receipt?['targetAgentId'], 'bot-b');
      expect(
        find.textContaining('The routine was transferred.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets('member and team lists keep history but do not offer transfer', (
    tester,
  ) async {
    for (final mode in ['member', 'team', 'shared']) {
      final server = TransferServer();
      final f = await fixture(server.handle);
      f.scope.data = server.data;
      if (mode == 'member') f.session.workspace!['role'] = 'member';
      if (mode == 'team') f.session.workspace!['kind'] = 'team';
      if (mode == 'shared') f.scope.items('agents').first['sharedBot'] = null;
      await tester.pumpWidget(
        testApp(RoutinesScreen(scope: f.scope, agentId: 'bot-a')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Transfer to Bot…'), findsNothing);
      expect(find.text('Recent runs'), findsOneWidget);
      expect(server.transfers, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    }
  });
}
