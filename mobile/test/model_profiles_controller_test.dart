import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/settings/model_profiles_controller.dart';

import 'model_profile_support.dart';
import 'support.dart';

void main() {
  test(
    'a post-commit 409 or 413 never unlocks another create or replays the first',
    () async {
      for (final status in [409, 413]) {
        final server = ModelsServer();
        final f = await fixture((request) async {
          final saved = await server.handle(request);
          return request.method == 'POST'
              ? jsonResponse({
                  'error': 'Synthetic post-commit credential cleanup error',
                }, status: status)
              : saved;
        });
        final c = ModelProfilesController(f.scope);
        await c.initialize();
        await c.write('create', fields: modelProfile('ignored'));
        expect(server.profiles.length, 3);
        expect(server.writes.length, 1);
        expect(c.pending, isNotNull);
        await c.write('create', fields: modelProfile('ignored'));
        expect(server.writes.length, 1);
        c.dispose();
        final restored = ModelProfilesController(f.scope);
        await restored.initialize();
        expect(restored.profiles.length, 3);
        expect(restored.canManage, false);
        expect(await restored.acknowledge(), true);
        expect(server.writes.length, 1);
        restored.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'owner profiles use fixed identity, save without activation, then explicitly activate and delete',
    () async {
      final server = ModelsServer();
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.url.path.startsWith('/api/workspaces/space-a/'), true);
        return server.handle(request);
      });
      final c = ModelProfilesController(f.scope);
      await c.initialize();
      final created = await c.write(
        'create',
        fields: {
          ...modelProfile('ignored'),
          'name': 'Synthetic new',
          'apiKey': 'synthetic-new-key',
        },
      );
      expect(created?['id'], 'created-1');
      expect(server.activeId, 'profile-a');
      expect(jsonDecode(server.writes.first.body), {
        'name': 'Synthetic new',
        'provider': 'openai',
        'model': 'synthetic-model',
        'baseUrl': 'https://model.example.test/v1',
        'vision': false,
        'apiKey': 'synthetic-new-key',
        'activate': false,
      });
      expect(f.secrets.values, isEmpty);
      await c.write('activate', id: 'created-1');
      expect(server.activeId, 'created-1');
      expect(
        server.writes[1].url.path,
        '/api/workspaces/space-a/model-profiles/created-1/activate',
      );
      await c.write('delete', id: 'profile-b');
      expect(c.find('profile-b'), isNull);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'members see only the current public profile and cannot send mutations',
    () async {
      final server = ModelsServer();
      var calls = 0;
      final f = await fixture((request) async {
        calls++;
        expect(request.url.path.endsWith('/bootstrap'), true);
        return server.handle(request);
      });
      f.session.workspace!['role'] = 'member';
      final c = ModelProfilesController(f.scope);
      await c.initialize();
      expect(c.profiles.map((p) => p['id']), ['profile-a']);
      expect(c.canManage, false);
      await c.write('create', fields: modelProfile('ignored'));
      expect(calls, 1);
      expect(server.writes, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'unknown create retains only metadata and remount never replays it',
    () async {
      final server = ModelsServer();
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes++;
          throw http.ClientException('synthetic lost response');
        }
        return server.handle(request);
      });
      final c = ModelProfilesController(f.scope);
      await c.initialize();
      await c.write(
        'create',
        fields: {...modelProfile('ignored'), 'apiKey': 'synthetic-private-key'},
      );
      expect(c.pending?['kind'], 'create');
      expect(
        f.secrets.values.values.single,
        isNot(contains('synthetic-private-key')),
      );
      expect(
        f.secrets.values.values.single,
        isNot(contains('model.example.test')),
      );
      c.dispose();
      final restored = ModelProfilesController(f.scope);
      await restored.initialize();
      await restored.write('create', fields: modelProfile('ignored'));
      expect(writes, 1);
      expect(restored.canManage, false);
      expect(await restored.acknowledge(), true);
      expect(restored.canManage, true);
      expect(writes, 1);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'all HTTP failures retain the operation until explicit read and acknowledgement',
    () async {
      for (final status in [409, 403, 500]) {
        final server = ModelsServer();
        final f = await fixture(
          (request) async => request.method == 'POST'
              ? jsonResponse({'error': 'Synthetic refusal'}, status: status)
              : server.handle(request),
        );
        final c = ModelProfilesController(f.scope);
        await c.initialize();
        await c.write(
          'save',
          id: 'profile-a',
          fields: modelProfile('profile-a'),
        );
        expect(c.pending, isNotNull);
        expect(c.canManage, false);
        expect(c.error, 'Synthetic refusal');
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test('late library responses cannot populate another account', () async {
    final late = Completer<http.Response>();
    final f = await fixture((_) => late.future);
    final c = ModelProfilesController(f.scope);
    final operation = c.initialize();
    await Future<void>.delayed(Duration.zero);
    f.session.user = {'id': 'other-user'};
    late.complete(jsonResponse(ModelsServer().list));
    await operation;
    expect(c.profiles, isEmpty);
    expect(c.active, false);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
  test('public profile projection never retains a returned secret', () async {
    final server = ModelsServer();
    server.profiles.first['apiKey'] = 'synthetic-must-not-display';
    final f = await fixture(server.handle);
    final c = ModelProfilesController(f.scope);
    await c.initialize();
    expect(
      jsonEncode(c.profiles),
      isNot(contains('synthetic-must-not-display')),
    );
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
  test(
    'late accepted mutation is not shown or sent again after account change',
    () async {
      final server = ModelsServer();
      final started = Completer<void>();
      final late = Completer<http.Response>();
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes++;
          started.complete();
          return late.future;
        }
        return server.handle(request);
      });
      final c = ModelProfilesController(f.scope);
      await c.initialize();
      final result = c.write(
        'save',
        id: 'profile-a',
        fields: modelProfile('profile-a'),
      );
      await started.future;
      f.session.user = {'id': 'other-user'};
      f.session.selectWorkspace(null);
      late.complete(
        jsonResponse({
          'profile': modelProfile('profile-a'),
          'settings': server.settings,
        }),
      );
      expect(await result, isNull);
      expect(c.profiles, isEmpty);
      expect(c.notice, isNull);
      expect(writes, 1);
      expect(f.secrets.values.values.single, contains('profile-a'));
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'unavailable secure recovery storage prevents any model write',
    () async {
      final server = ModelsServer();
      final f = await fixture(server.handle);
      final c = ModelProfilesController(f.scope);
      await c.initialize();
      f.secrets.rejectWrites = true;
      await c.write(
        'create',
        fields: {...modelProfile('unused'), 'apiKey': 'synthetic-temporary'},
      );
      expect(server.writes, isEmpty);
      expect(f.secrets.values, isEmpty);
      expect(c.error, 'mobileModelsRecoveryFailed');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
