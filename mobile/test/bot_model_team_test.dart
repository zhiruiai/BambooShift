import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/bot_model_picker.dart';
import 'package:openbot_mobile/features/collaboration/team_controller.dart';
import 'package:openbot_mobile/features/collaboration/team_plans_screen.dart';

import 'bot_model_selection_test.dart' show phone, profileId, tapVisible;
import 'collaboration_support.dart';
import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Future<void> tapRequest(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pump();
}

void main() {
  testWidgets(
    'new team members retain the selected model through draft and commit',
    (tester) async {
      phone(tester);
      final server = TeamServer();
      server.current['draft']['members'] = <Json>[
        Map<String, dynamic>.from(server.current['draft']['members'][0]),
        {
          ...(profile('New reviewer')..remove('id')),
          'key': 'second',
          'kind': 'create',
          'assignment': 'Review the evidence',
        },
      ];
      final models = ModelsServer()
        ..profiles.add(modelProfile(profileId, name: 'Review model'));
      final f = await fixture(
        (request) => request.url.path.endsWith('/model-profiles')
            ? models.handle(request)
            : server.handle(request),
      );
      f.scope.data = teamSnapshot();
      await tester.pumpWidget(
        testApp(TeamPlansScreen(scope: f.scope, initialPlanId: planId)),
      );
      await waitFor(
        tester,
        () => find.text('Ready to review').evaluate().isNotEmpty,
      );
      final controller =
          (tester.state(find.byType(TeamPlansScreen)) as dynamic).controller
              as TeamController;
      await tapRequest(tester, find.text('New Bot profile'));
      final selector = find.descendant(
        of: find.byType(BotModelPicker),
        matching: find.byType(DropdownButtonFormField<String>),
      );
      await waitFor(
        tester,
        () =>
            selector.evaluate().isNotEmpty &&
            tester
                    .widget<DropdownButtonFormField<String>>(selector)
                    .onChanged !=
                null,
      );
      await tapVisible(tester, selector);
      await tester.tap(find.text('Review model · synthetic-model').last);
      await tester.pumpAndSettle();
      expect(server.creations, 0);
      expect(server.posts, isEmpty);
      await tapRequest(
        tester,
        find.widgetWithText(OutlinedButton, 'Save draft'),
      );
      await waitFor(
        tester,
        () =>
            !controller.busy &&
            server.current['draft']['members'][1]['modelProfileId'] ==
                profileId,
      );
      final save = server.posts.last;
      expect(
        (jsonDecode(save.body)
            as Json)['draft']['members'][1]['modelProfileId'],
        profileId,
      );
      expect(models.writes, isEmpty);
      await tapVisible(
        tester,
        find.widgetWithText(FilledButton, 'Create team'),
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitFor(tester, () => server.creations == 1 && !controller.busy);
      final commit = server.posts.lastWhere(
        (r) => r.url.path.endsWith('/commit'),
      );
      expect(
        (jsonDecode(commit.body)
            as Json)['draft']['members'][1]['modelProfileId'],
        profileId,
      );
      expect(server.starts, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
