import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/settings/model_profile_editor.dart';
import 'package:openbot_mobile/features/settings/model_profiles_controller.dart';
import 'package:openbot_mobile/features/settings/model_settings.dart';

import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Finder field(String label) => find.widgetWithText(TextFormField, label);

void main() {
  testWidgets(
    'lost save response keeps the draft locked until explicit read and acknowledgement',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(750, 1900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ModelsServer();
      final f = await fixture((request) async {
        final response = await server.handle(request);
        if (request.method == 'POST') {
          throw http.ClientException('Synthetic lost response');
        }
        return response;
      });
      await tester.pumpWidget(testApp(ModelSettings(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Profile profile-a').evaluate().isNotEmpty,
      );
      await tester.tap(find.byTooltip('New profile'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name'), 'Explicit unknown save');
      await tester.enterText(field('Model ID'), 'synthetic-model');
      await tester.enterText(field('API base URL'), 'https://example.test/v1');
      await tester.enterText(field('API key'), 'synthetic-key-not-persisted');
      await tester.tap(find.widgetWithText(FilledButton, 'Save profile'));
      await waitFor(
        tester,
        () => find
            .textContaining('The previous change needs checking.')
            .evaluate()
            .isNotEmpty,
      );
      expect(server.writes.length, 1);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Save profile'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester.widget<TextFormField>(field('Name')).controller!.text,
        'Explicit unknown save',
      );
      expect(
        f.secrets.values.values.single,
        isNot(contains('synthetic-key-not-persisted')),
      );
      expect(
        f.secrets.values.values.single,
        isNot(contains('Explicit unknown save')),
      );
      await tester.tap(
        find.widgetWithText(TextButton, 'Refresh and check profiles'),
      );
      await waitFor(
        tester,
        () =>
            tester
                .widget<TextButton>(
                  find.widgetWithText(
                    TextButton,
                    'Continue from saved profiles',
                  ),
                )
                .onPressed !=
            null,
      );
      expect(server.writes.length, 1);
      await tester.tap(
        find.widgetWithText(TextButton, 'Continue from saved profiles'),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('This does not cancel the request'),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pump(const Duration(milliseconds: 300));
      await waitFor(tester, () => f.secrets.values.isEmpty);
      expect(field('Name'), findsNothing);
      expect(find.text('Explicit unknown save'), findsOneWidget);
      expect(server.writes.length, 1);
      expect(f.secrets.values, isEmpty);
      expect(find.text('synthetic-key-not-persisted'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'a role downgrade clears the temporary key and removes mutation controls immediately',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(750, 1700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ModelsServer();
      final f = await fixture(server.handle);
      f.scope.data!['settings'] = server.settings;
      final controller = ModelProfilesController(f.scope);
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(
        testApp(
          ModelProfileEditor(
            controller: controller,
            profile: controller.profiles.first,
          ),
        ),
      );
      await tester.pumpAndSettle();
      final key = tester.widget<TextFormField>(field('API key')).controller!;
      await tester.enterText(field('API key'), 'synthetic-temporary');
      f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
      await tester.pumpAndSettle();
      expect(key.text, '');
      expect(field('API key'), findsNothing);
      expect(find.text('Save profile'), findsNothing);
      expect(tester.widget<TextFormField>(field('Name')).enabled, false);
      expect(controller.profiles.map((p) => p['id']), ['profile-a']);
      expect(server.writes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
