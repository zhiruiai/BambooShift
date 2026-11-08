import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_card.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_generator.dart';
import 'package:openbot_mobile/features/settings/device_settings.dart';
import 'package:openbot_mobile/widgets/avatar_appearance.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const themeData = {
  'name': '月光企鹅',
  'motif': 'pandas',
  'colors': ['#334466', '#345674', '#A9B8CC'],
  'badge': 'moon',
  'backdrop': 'halo',
};

const previewData = {'kind': 'theme', 'theme': themeData};

void main() {
  test('validates and normalizes constrained model theme data', () {
    final draft = GeneratedAvatarTheme.preview(previewData)!;
    expect(draft.name, '月光企鹅');
    expect(draft.colorFor('arch'), '#a9b8cc');
    for (final invalid in [
      {...themeData, 'name': '<svg>'},
      {...themeData, 'name': '---'},
      {...themeData, 'color': '#aabbcc'},
      {...themeData, 'badge': 'sparkles'},
      {
        ...themeData,
        'colors': ['#AAAAAA', '#aaaaaa', '#aaaacc'],
      },
    ]) {
      expect(GeneratedAvatarTheme.parse(invalid), isNull, reason: '$invalid');
    }
    expect(
      GeneratedAvatarTheme.preview({...previewData, 'html': '<img>'}),
      isNull,
    );
  });

  testWidgets(
    'appearance generates, reviews, and saves only an explicitly applied theme',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(320, 620);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var requests = 0;
      final f = await fixture((request) async {
        requests++;
        expect(request.method, 'POST');
        expect(request.url.path, '/api/workspaces/space-a/creation-preview');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(jsonDecode(request.body), {
          'kind': 'theme',
          'brief': 'Night sky with a moon',
          'language': 'en',
        });
        return jsonResponse(previewData);
      });
      f.scope.data!['settings'] = {'configured': true};
      f.session.api.language = 'en';
      await tester.pumpWidget(
        testApp(DeviceSettings(session: f.session, scope: f.scope)),
      );
      final entry = find.widgetWithText(
        OutlinedButton,
        'Design avatar theme with AI',
      );
      await tester.scrollUntilVisible(entry, 280);
      await tester.tap(entry);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Night sky with a moon');
      await tester.pump();
      await tester.tap(find.text('Generate preview'));
      await waitFor(tester, () => find.text('月光企鹅').evaluate().isNotEmpty);
      expect(requests, 1);
      expect(f.session.customAvatarTheme, isNull);
      expect(f.secrets.values['openbot.preferences.v1'], isNull);
      expect(find.byType(GeneratedAvatarDecoration), findsNWidgets(3));
      await tester.tap(find.text('Apply to this device'));
      await tester.pumpAndSettle();
      expect(f.session.useCustomAvatarTheme, true);
      expect(f.session.customAvatarTheme?.name, '月光企鹅');
      expect(
        f.secrets.values['openbot.preferences.v1'],
        isNot(contains('Night sky')),
      );
      await f.session.preferences(avatars: 'elephants');
      expect(f.session.useCustomAvatarTheme, false);
      await f.session.preferences(useCustomAvatar: true);
      f.session.customAvatarTheme = null;
      f.session.useCustomAvatarTheme = false;
      await f.session.initialize();
      expect(f.session.customAvatarTheme?.name, '月光企鹅');
      expect(f.session.useCustomAvatarTheme, true);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('generation output cannot cross a changed account', (
    tester,
  ) async {
    final gate = Completer<http.Response>();
    var requested = false;
    final f = await fixture((_) {
      requested = true;
      return gate.future;
    });
    await tester.pumpWidget(
      testApp(Scaffold(body: AvatarThemeGenerator(scope: f.scope))),
    );
    await tester.enterText(find.byType(TextField), 'Dark halo');
      await tester.pump();
    await tester.tap(find.text('Generate preview'));
    for (var i = 0; i < 100 && !requested; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
    }
    expect(requested, true);
    f.session.user = {'id': 'user-b'};
    f.session.notifyListeners();
    gate.complete(jsonResponse(previewData));
    await tester.runAsync(() => gate.future);
    await tester.pumpAndSettle();
    expect(find.text('Apply to this device'), findsNothing);
    expect(f.session.customAvatarTheme, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'a chat draft revalidates the originating conversation and actor',
    (tester) async {
      final message = <String, dynamic>{
        'id': 'draft-a',
        'role': 'assistant',
        'kind': 'creation_preview',
        'status': 'done',
        'conversationId': 'chat-a',
        'agentId': 'bot-a',
        'metadata': {
          'creationPreview': previewData,
          'requesterUserId': 'user-a',
          'inputMessageId': 'input-a',
          'runId': 'run-a',
        },
      };
      final agents = <Map<String, dynamic>>[
        {'id': 'bot-a', 'name': 'Example Bot', 'avatar': 'orb'},
      ];
      final root = <String, dynamic>{
        'id': 'input-a',
        'role': 'user',
        'userId': 'user-a',
        'conversationId': 'chat-a',
        'delivery': {
          'state': 'delivered',
          'agentId': 'bot-a',
          'runId': 'run-a',
        },
      };
      final paths = <String>[];
      var wrongActor = true;
      final f = await fixture((request) async {
        expect(request.method, 'GET');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        paths.add(request.url.path);
        if (request.url.path == '/api/account/session') {
          return jsonResponse({
            'authenticated': true,
            'user': {'id': 'user-a'},
            'workspaces': [
              {'id': 'space-a', 'role': 'owner', 'status': 'active'},
            ],
          });
        }
        return jsonResponse(
          bootstrap(
            agents: agents,
            messages: [
              if (wrongActor) {...root, 'userId': 'user-b'} else root,
              message,
            ],
          ),
        );
      });
      f.scope.data = bootstrap(agents: agents, messages: [root, message]);
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: Column(
              children: [
                AvatarThemeCard(
                  scope: f.scope,
                  message: message,
                  theme: avatarThemeProposal(message)!,
                ),
                AvatarAppearance(
                  session: f.session,
                  child: const BotAvatar(bot: {}, family: 'companions'),
                ),
              ],
            ),
          ),
        ),
      );
      final apply = find.text('Apply to this device');
      await tester.tap(apply);
      await waitFor(
        tester,
        () => find
            .text('This item is no longer available.')
            .evaluate()
            .isNotEmpty,
      );
      expect(f.session.customAvatarTheme, isNull);
      wrongActor = false;
      await tester.tap(apply);
      await waitFor(
        tester,
        () => find.text('Applied to this device').evaluate().isNotEmpty,
      );
      expect(f.session.customAvatarTheme?.name, '月光企鹅');
      expect(find.byType(GeneratedAvatarDecoration), findsNWidgets(4));
      expect(paths, [
        '/api/account/session',
        '/api/workspaces/space-a/bootstrap',
        '/api/account/session',
        '/api/workspaces/space-a/bootstrap',
      ]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
