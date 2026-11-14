import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/bot_model_picker.dart';
import 'package:openbot_mobile/features/bots/bot_settings.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor.dart';

import 'creation_controller_test.dart' show receipt;
import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const profileId = 'b9ae5e6e-3b26-4c4d-8ad0-a0d236ce9f74';
const botProfile = {
  'id': 'bot-a',
  'name': 'Synthetic researcher',
  'role': 'Research',
  'description': '',
  'instructions': '',
  'avatar': 'orb',
  'color': '#496fab',
  'configRevision': 'revision-a',
};

void phone(WidgetTester tester) {
  tester.view
    ..physicalSize = const Size(320, 640)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetViewInsets);
}

Future<void> tapVisible(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Finder get picker => find.descendant(
  of: find.byType(BotModelPicker),
  matching: find.byType(DropdownButtonFormField<String>),
);

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'independent Bot model persists and resets on narrow $language',
      (tester) async {
        phone(tester);
        final models = ModelsServer()
          ..profiles.add(modelProfile(profileId, name: 'Research model'));
        models.profiles.add({
          ...modelProfile('unconfigured', name: 'Unconfigured model'),
          'configured': false,
        });
        models.profiles.last['apiKey'] = 'synthetic-never-display';
        final bot = {...botProfile, 'modelProfileId': null};
        final data = bootstrap(agents: [bot])..['settings'] = models.settings;
        final writes = <Json>[];
        final f = await fixture((request) async {
          if (request.url.path.endsWith('/model-profiles')) {
            expect(request.method, 'GET');
            return models.handle(request);
          }
          if (request.method == 'PATCH') {
            expect(request.url.path, '/api/workspaces/space-a/agents/bot-a');
            final body = jsonDecode(request.body) as Json;
            writes.add(body);
            bot['modelProfileId'] = body['modelProfileId'];
            return jsonResponse({'agent': bot});
          }
          return jsonResponse(data);
        });
        f.scope.data = data;
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: Builder(
                builder: (context) {
                  return TextButton(
                    onPressed: () => Navigator.push<void>(
                      context,
                      MaterialPageRoute(
                        builder: (_) => BotSettings(scope: f.scope, bot: bot),
                      ),
                    ),
                    child: const Text('Open'),
                  );
                },
              ),
            ),
            locale: Locale(language),
          ),
        );
        for (final reset in [false, true]) {
          await tester.tap(find.text('Open'));
          await waitFor(
            tester,
            () =>
                picker.evaluate().isNotEmpty &&
                tester
                        .widget<DropdownButtonFormField<String>>(picker)
                        .onChanged !=
                    null,
          );
          if (!reset) {
            tester.view.viewInsets = const FakeViewPadding(bottom: 240);
            await tester.pump();
          }
          await tapVisible(tester, picker);
          expect(find.textContaining('Unconfigured model'), findsNothing);
          expect(find.textContaining('synthetic-never-display'), findsNothing);
          await tester.tap(
            find
                .text(
                  reset
                      ? language == 'en'
                            ? 'Use workspace default'
                            : '跟随工作空间默认模型'
                      : 'Research model · synthetic-model',
                )
                .last,
          );
          await tester.pumpAndSettle();
          expect(writes.length, reset ? 1 : 0);
          await tapVisible(
            tester,
            find.widgetWithText(FilledButton, language == 'en' ? 'Save' : '保存'),
          );
          await waitFor(tester, () => find.text('Open').evaluate().isNotEmpty);
          tester.view.resetViewInsets();
          await tester.pump();
          expect(writes.last['modelProfileId'], reset ? null : profileId);
          expect(writes.last['expectedRevision'], 'revision-a');
          expect(models.activeId, 'profile-a');
          expect(tester.takeException(), isNull);
        }
        expect(
          f.secrets.values.values.join(),
          isNot(contains('synthetic-never-display')),
        );
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }

  testWidgets('creation sends only the chosen model identifier', (
    tester,
  ) async {
    phone(tester);
    final models = ModelsServer()
      ..profiles.add(modelProfile(profileId, name: 'Research model'));
    Json? sent;
    final f = await fixture((request) async {
      if (request.url.path.endsWith('/model-profiles')) {
        return models.handle(request);
      }
      if (request.method == 'POST') {
        sent = jsonDecode(request.body) as Json;
        return jsonResponse(receipt(sent!));
      }
      return jsonResponse(bootstrap());
    });
    await tester.pumpWidget(
      testApp(
        CreateScreen(scope: f.scope, kind: 'bot', initialProfile: botProfile),
      ),
    );
    await waitFor(
      tester,
      () =>
          picker.evaluate().isNotEmpty &&
          tester.widget<DropdownButtonFormField<String>>(picker).onChanged !=
              null,
    );
    await tapVisible(tester, picker);
    await tester.tap(find.text('Research model · synthetic-model').last);
    await tester.pumpAndSettle();
    expect(sent, isNull);
    await tapVisible(tester, find.widgetWithText(FilledButton, 'Create'));
    await waitFor(tester, () => sent != null);
    expect(sent!['profile']['modelProfileId'], profileId);
    expect(sent!['profile'].containsKey('apiKey'), false);
    expect(sent!['profile'].containsKey('baseUrl'), false);
    expect(models.activeId, 'profile-a');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'missing selection is retained and workspace change blocks editing',
    (tester) async {
      final models = ModelsServer();
      final f = await fixture(models.handle);
      String? changed;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: BotModelPicker(
              scope: f.scope,
              value: profileId,
              enabled: true,
              onChanged: (value) => changed = value,
            ),
          ),
        ),
      );
      await waitFor(
        tester,
        () =>
            picker.evaluate().isNotEmpty &&
            tester.widget<DropdownButtonFormField<String>>(picker).onChanged !=
                null,
      );
      expect(find.text('Assigned model unavailable'), findsOneWidget);
      expect(tester.state<FormFieldState<String>>(picker).value, profileId);
      expect(changed, isNull);
      f.session.selectWorkspace(null);
      await tester.pumpAndSettle();
      expect(picker, findsNothing);
      expect(models.writes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'shared Bots never load owner models or offer an editable choice',
    (tester) async {
      var requests = 0;
      final f = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      final bot = {...botProfile, 'sharedBot': null};
      f.scope.data = bootstrap(agents: [bot]);
      await tester.pumpWidget(testApp(BotSettings(scope: f.scope, bot: bot)));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.text('Use the requester’s workspace model'),
      );
      expect(picker, findsNothing);
      expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
      expect(requests, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'Bot settings show scoped skills and prefill a reviewable workflow',
    (tester) async {
      phone(tester);
      final models = ModelsServer();
      final data = bootstrap(agents: [botProfile])
        ..['skills'] = [
          {
            'id': 'skill-a',
            'agentId': 'bot-a',
            'name': 'Source check',
            'status': 'active',
          },
          {
            'id': 'skill-b',
            'agentId': 'bot-a',
            'name': 'Review draft',
            'status': 'proposed',
          },
          {
            'id': 'skill-c',
            'agentId': 'bot-b',
            'name': 'Other Bot skill',
            'status': 'active',
          },
        ];
      final writes = <String>[];
      final f = await fixture((request) async {
        if (request.method != 'GET') writes.add(request.url.path);
        return request.url.path.endsWith('/model-profiles')
            ? models.handle(request)
            : jsonResponse(data);
      });
      f.scope.data = data;
      await tester.pumpWidget(
        testApp(BotSettings(scope: f.scope, bot: botProfile)),
      );
      await waitFor(
        tester,
        () =>
            picker.evaluate().isNotEmpty &&
            tester.widget<DropdownButtonFormField<String>>(picker).onChanged !=
                null,
      );
      await tester.scrollUntilVisible(
        find.textContaining('Enabled: 1'),
        180,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.textContaining('Awaiting review: 1'), findsOneWidget);
      expect(find.textContaining('Other Bot skill'), findsNothing);
      await tapVisible(tester, find.widgetWithText(ListTile, 'Skills'));
      expect(find.text('Synthetic researcher'), findsOneWidget);
      expect(find.text('Other Bot skill'), findsNothing);
      final recipes = find.widgetWithText(
        OutlinedButton,
        'Start from a workflow template',
      );
      await tapVisible(tester, recipes);
      await waitFor(
        tester,
        () => find
            .text('Source-grounded technical research')
            .evaluate()
            .isNotEmpty,
      );
      await tester.scrollUntilVisible(
        find.text('Systematic debugging'),
        100,
        scrollable: find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(Scrollable),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Systematic debugging').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Systematic debugging'));
      await waitFor(
        tester,
        () => find.byType(KnowledgeEditor).evaluate().isNotEmpty,
      );
      expect(find.text('Systematic debugging'), findsOneWidget);
      expect(
        find.widgetWithText(FilledButton, 'Submit for review'),
        findsOneWidget,
      );
      expect(writes, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
