import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/app_session.dart';
import 'package:openbot_mobile/core/secure_store.dart';

import 'support.dart';

void main() {
  test(
    'session refresh retains an authorized workspace but clears it on account switch',
    () async {
      var actor = 'user-a';
      final f = await fixture(
        (request) async => jsonResponse({
          'authenticated': true,
          'user': {'id': actor, 'name': 'Example'},
          'workspaces': [
            {
              'id': 'space-a',
              'name': 'Personal',
              'kind': 'personal',
              'role': 'owner',
              'status': 'active',
            },
          ],
        }),
      );
      await f.session.refresh();
      expect(f.session.workspaceId, 'space-a');
      actor = 'user-b';
      await f.session.refresh();
      expect(f.session.workspaceId, isNull);
      expect(f.session.userId, 'user-b');
      expect(f.scope.active, isFalse);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'late initialization after dispose does not publish state or write credentials',
    () async {
      final response = Completer<http.Response>();
      final secrets = MemorySecrets()
        ..values['openbot.server.v1'] = 'https://example.test';
      final api = ApiClient(
        SessionVault(secrets),
        factory: () => MockClient((_) => response.future),
      );
      final session = AppSession(api);
      var changes = 0;
      session.addListener(() => changes++);
      final initializing = session.initialize();
      await Future<void>.delayed(Duration.zero);
      session.dispose();
      response.complete(jsonResponse({'authenticated': false}));
      await initializing;
      expect(changes, 0);
    },
  );
  test(
    'device appearance stays local and does not send account mutations',
    () async {
      var requests = 0;
      final f = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      await f.session.preferences(
        language: const Locale('en'),
        mode: ThemeMode.dark,
        avatars: 'pandas',
      );
      expect(f.session.locale.languageCode, 'en');
      expect(f.session.theme, ThemeMode.dark);
      expect(f.session.avatarTheme, 'pandas');
      expect(requests, 0);
      expect(f.secrets.values['openbot.preferences.v1'], contains('pandas'));
      for (final avatar in ['chicks', 'elephants']) {
        await f.session.preferences(avatars: avatar);
        final reopened = AppSession(f.session.api);
        await reopened.initialize();
        expect(reopened.avatarTheme, avatar);
        expect(reopened.theme, ThemeMode.dark);
        expect(reopened.locale.languageCode, 'en');
        reopened.dispose();
      }
      expect(requests, 0);
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('revoked account response removes all workspace projections', () async {
    final f = await fixture(
      (_) async => jsonResponse({'authenticated': false, 'workspaces': []}),
    );
    await f.session.refresh();
    expect(f.session.user, isNull);
    expect(f.session.workspaces, isEmpty);
    expect(f.session.workspace, isNull);
    expect(f.scope.active, isFalse);
    f.scope.dispose();
    f.session.dispose();
  });
}
