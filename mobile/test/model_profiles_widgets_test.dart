import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/settings/model_profile_editor.dart';
import 'package:openbot_mobile/features/settings/model_profiles_controller.dart';
import 'package:openbot_mobile/features/settings/model_settings.dart';

import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Finder field(String label) => find.widgetWithText(TextFormField, label);
Future<void> visible(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'profile activation and deletion require separate explicit confirmation',
    (tester) async {
      final server = ModelsServer();
      final f = await fixture(server.handle);
      await tester.pumpWidget(testApp(ModelSettings(scope: f.scope)));
      final c =
          (tester.state(find.byType(ModelSettings)) as dynamic).controller
              as ModelProfilesController;
      await waitFor(
        tester,
        () => find.text('Profile profile-b').evaluate().isNotEmpty,
      );
      await visible(tester, find.widgetWithText(TextButton, 'Set as default'));
      await tester.tap(find.widgetWithText(TextButton, 'Set as default'));
      await tester.pumpAndSettle();
      expect(server.writes, isEmpty);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.activeId, 'profile-a');
      await tester.tap(find.widgetWithText(TextButton, 'Set as default'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pump(const Duration(milliseconds: 300));
      await waitFor(
        tester,
        () => c.notice == 'mobileModelsActivated' && !c.busy && !c.loading,
      );
      await visible(tester, find.byTooltip('Delete'));
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      expect(server.profiles.length, 2);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await tester.pump(const Duration(milliseconds: 300));
      await waitFor(
        tester,
        () => c.notice == 'mobileModelsDeleted' && !c.busy && !c.loading,
      );
      expect(server.profiles.single['id'], 'profile-b');
      expect(server.writes.map((r) => r.method), ['POST', 'DELETE']);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'save as new copies public fields without the saved key or activation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(700, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ModelsServer();
      server.profiles.first['apiKey'] = 'synthetic-never-copy';
      final f = await fixture(server.handle);
      await tester.pumpWidget(testApp(ModelSettings(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Profile profile-a').evaluate().isNotEmpty,
      );
      await tester.tap(
        find.widgetWithText(TextButton, 'Save as new profile').first,
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        '',
      );
      expect(
        tester.widget<TextFormField>(field('Name')).controller!.text,
        'Profile profile-a (copy)',
      );
      await tester.enterText(field('Name'), 'Explicit copy');
      await visible(tester, find.widgetWithText(FilledButton, 'Save profile'));
      await tester.tap(find.widgetWithText(FilledButton, 'Save profile'));
      await waitFor(tester, () => server.writes.isNotEmpty);
      final body = jsonDecode(server.writes.single.body) as Json;
      expect(body.containsKey('apiKey'), false);
      expect(body.containsKey('id'), false);
      expect(body['activate'], false);
      expect(server.activeId, 'profile-a');
      expect(
        f.secrets.values.values.join(),
        isNot(contains('synthetic-never-copy')),
      );
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'provider and endpoint changes clear temporary keys; idle conflict preserves the draft',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(700, 1800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ModelsServer();
      Json? sent;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          sent = jsonDecode(request.body) as Json;
          return jsonResponse({
            'error': 'Synthetic task is running',
          }, status: 409);
        }
        return server.handle(request);
      });
      final c = ModelProfilesController(f.scope);
      await tester.runAsync(c.initialize);
      await tester.pumpWidget(
        testApp(ModelProfileEditor(controller: c, profile: c.profiles.first)),
      );
      await tester.pumpAndSettle();
      await tester.enterText(field('API key'), 'synthetic-entered-key');
      await tester.enterText(
        field('API base URL'),
        'https://changed.example.test/v1',
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        '',
      );
      await tester.enterText(field('API key'), 'another-synthetic-key');
      await tester.enterText(field('Model provider'), 'anthropic');
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        '',
      );
      await tester.enterText(field('Name'), 'Draft retained');
      await tester.tap(find.widgetWithText(FilledButton, 'Save profile'));
      await waitFor(tester, () => sent != null && !c.busy);
      expect(sent!.containsKey('apiKey'), false);
      expect(
        tester.widget<TextFormField>(field('Name')).controller!.text,
        'Draft retained',
      );
      expect(find.text('Synthetic task is running'), findsOneWidget);
      expect(c.canManage, false);
      expect(c.pending, isNotNull);
      expect(f.secrets.values, isNotEmpty);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'members see the current profile without owner controls or key input',
    (tester) async {
      final server = ModelsServer();
      final f = await fixture((request) async {
        expect(request.url.path.endsWith('/bootstrap'), true);
        expect(request.method, 'GET');
        return server.handle(request);
      });
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(testApp(ModelSettings(scope: f.scope)));
      await waitFor(
        tester,
        () => find.text('Profile profile-a').evaluate().isNotEmpty,
      );
      expect(find.byTooltip('New profile'), findsNothing);
      expect(find.text('Set as default'), findsNothing);
      expect(find.text('Save as new profile'), findsNothing);
      await tester.tap(find.widgetWithText(TextButton, 'View profile'));
      await tester.pumpAndSettle();
      expect(field('API key'), findsNothing);
      expect(find.text('Save profile'), findsNothing);
      expect(tester.widget<TextFormField>(field('Name')).enabled, false);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'leaving or changing account clears the transient key and stale controls',
    (tester) async {
      final server = ModelsServer();
      final f = await fixture(server.handle);
      final c = ModelProfilesController(f.scope);
      await tester.runAsync(c.initialize);
      await tester.binding.setSurfaceSize(const Size(700, 1600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        testApp(ModelProfileEditor(controller: c, profile: c.profiles.first)),
      );
      await tester.pumpAndSettle();
      await tester.enterText(field('API key'), 'synthetic-transient-key');
      f.session.selectWorkspace(null);
      await tester.pumpAndSettle();
      expect(find.text('synthetic-transient-key'), findsNothing);
      expect(field('API key'), findsNothing);
      expect(server.writes, isEmpty);
      expect(f.secrets.values, isEmpty);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'removing a saved key is an explicit saved change, not a readback',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(700, 1700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ModelsServer();
      final f = await fixture(server.handle);
      final c = ModelProfilesController(f.scope);
      await tester.runAsync(c.initialize);
      await tester.pumpWidget(
        testApp(ModelProfileEditor(controller: c, profile: c.profiles.first)),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(
          CheckboxListTile,
          'Remove the saved key when saving',
        ),
      );
      await tester.pumpAndSettle();
      expect(server.writes, isEmpty);
      expect(
        tester.widget<TextFormField>(field('API key')).controller!.text,
        '',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save profile'));
      await waitFor(
        tester,
        () => !c.busy && !c.loading && c.notice == 'mobileModelsSaved',
      );
      final body = jsonDecode(server.writes.single.body) as Json;
      expect(body['id'], 'profile-a');
      expect(body['clearApiKey'], true);
      expect(body.containsKey('apiKey'), false);
      expect(body['activate'], false);
      expect(c.find('profile-a')?['hasApiKey'], false);
      expect(server.activeId, 'profile-a');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
