import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';

import 'apps_support.dart';
import 'support.dart';

void main() {
  test(
    'bare arrays, null OAuth and tools retain fixed actor headers',
    () async {
      final f = await fixture((r) async {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(r.method, 'GET');
        if (r.url.path.endsWith('/oauth')) return http.Response('null', 200);
        if (r.url.path.endsWith('/tools')) {
          return jsonResponse([
            {
              'name': 'lookup',
              'description': 'Read data',
              'inputSchema': <String, dynamic>{},
            },
          ]);
        }
        return jsonResponse([connectedApp(auth: 'oauth')]);
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.refresh('app-a');
      await c.loadTools('app-a');
      expect(c.error, isNull);
      expect(c.flows['app-a'], isNull);
      expect(c.tools['app-a']!.single['name'], 'lookup');
    },
  );

  test('member reads but cannot add or mutate credentials', () async {
    final requests = <String>[];
    final f = await fixture((r) async {
      requests.add(r.method);
      return jsonResponse([connectedApp(auth: 'oauth')]);
    });
    f.session.workspace!['role'] = 'member';
    final c = AppsController(f.scope);
    addTearDown(() {
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await c.initialize();
    await c.add(appDraft());
    await c.change('app-a', 'disconnect');
    await c.startOAuth('app-a');
    expect(requests, ['GET']);
    expect(c.canWrite, isFalse);
  });

  test('consent and credentials are validated before any dispatch', () async {
    var writes = 0;
    final f = await fixture((r) async {
      if (r.method != 'GET') writes++;
      {
        return jsonResponse([]);
      }
    });
    final c = AppsController(f.scope);
    addTearDown(() {
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await c.initialize();
    await c.add({...appDraft(), 'shared': false});
    await c.add({...appDraft(auth: 'bearer'), 'token': 'bad token'});
    await c.add({
      ...appDraft(auth: 'bearer'),
      'name': 'synthetic-access-token',
    });
    expect(writes, 0);
    expect(c.hasPending, isFalse);
  });

  test(
    'unknown add survives reopening with no secret or automatic retry',
    () async {
      final secrets = MemorySecrets();
      var posts = 0;
      var visible = false;
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          posts++;
          expect(
            secrets.values.values.join(),
            isNot(contains('synthetic-access-token')),
          );
          expect(jsonDecode(r.body)['token'], 'synthetic-access-token');
          throw http.ClientException('Synthetic lost response');
        }
        return jsonResponse(
          visible
              ? [
                  {...connectedApp(), ...appDraft(auth: 'bearer')},
                ]
              : [],
        );
      }, secrets: secrets);
      var c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.add(appDraft(auth: 'bearer'));
      expect(c.canAdd, isFalse);
      expect(c.hasPending, isTrue);
      c.dispose();
      c = AppsController(f.scope);
      await c.initialize();
      await c.refresh();
      await c.add(appDraft());
      expect(posts, 1);
      expect(
        c.hasPending,
        isTrue,
        reason: 'An empty list does not prove no write.',
      );
      visible = true;
      await c.refresh();
      expect(c.hasPending, isFalse);
      expect(c.apps.single['status'], 'connected');
    },
  );

  test(
    'unknown connection does not block another; explicit local release never POSTs',
    () async {
      final events = <String>[];
      var bRevision = 'rev-a';
      var fail = true;
      final f = await fixture((r) async {
        events.add('${r.method} ${r.url.path}');
        if (r.method == 'GET') {
          return jsonResponse([
            connectedApp(),
            connectedApp(id: 'app-b', revision: bRevision),
          ]);
        }
        if (r.url.path.contains('app-a') && fail) {
          throw http.ClientException('Lost');
        }
        if (r.url.path.contains('app-b')) bRevision = 'rev-b';
        {
          return jsonResponse(connectedApp(id: 'app-b', revision: bRevision));
        }
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.change('app-a', 'reconnect');
      expect(c.canWriteConnection('app-a'), isFalse);
      expect(c.canWriteConnection('app-b'), isTrue);
      expect(c.canAdd, isTrue);
      await c.change('app-b', 'disconnect');
      expect(c.pendingFor('app-a'), isNotNull);
      expect(c.pendingFor('app-b'), isNull);
      final before = events.where((e) => e.startsWith('POST')).length;
      await c.abandonLocalDraft('app-a');
      expect(c.pendingFor('app-a'), isNull);
      expect(events.last, 'GET /api/workspaces/space-a/apps');
      expect(events.where((e) => e.startsWith('POST')).length, before);
      fail = false;
      await c.change('app-a', 'reconnect');
      expect(events.where((e) => e.startsWith('POST')).length, before + 1);
    },
  );

  test(
    'HTTP errors remain pending and local release requires a successful fresh GET',
    () async {
      var unavailable = false;
      var posts = 0;
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          posts++;
          return jsonResponse({
            'error': 'Forbidden',
            'code': 'FORBIDDEN',
          }, status: 403);
        }
        if (unavailable) {
          return jsonResponse({'error': 'Unavailable'}, status: 503);
        }
        return jsonResponse([]);
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.add(appDraft());
      expect(c.hasPending, isTrue);
      unavailable = true;
      await c.abandonLocalDraft();
      expect(c.hasPending, isTrue);
      unavailable = false;
      await c.abandonLocalDraft();
      expect(c.hasPending, isFalse);
      expect(posts, 1);
    },
  );

  test('unknown records are isolated by workspace and actor', () async {
    final f = await fixture((r) async {
      if (r.method != 'GET') throw http.ClientException('Lost');
      {
        return jsonResponse([]);
      }
    });
    final a = AppsController(f.scope);
    await a.initialize();
    await a.add(appDraft());
    expect(a.hasPending, isTrue);
    f.session.workspaces.add({...f.session.workspace!, 'id': 'space-b'});
    f.session.selectWorkspace(f.session.workspaces.last);
    final bScope = WorkspaceController(f.session);
    final b = AppsController(bScope);
    await b.initialize();
    expect(b.hasPending, isFalse);
    f.session.user = {...f.session.user!, 'id': 'user-b'};
    f.session.selectWorkspace({...f.session.workspace!, 'id': 'space-a'});
    final otherScope = WorkspaceController(f.session);
    final other = AppsController(otherScope);
    await other.initialize();
    expect(other.hasPending, isFalse);
    a.dispose();
    b.dispose();
    other.dispose();
    f.scope.dispose();
    bScope.dispose();
    otherScope.dispose();
    f.session.dispose();
  });

  test(
    'late account response cannot publish data or accept a cookie',
    () async {
      final response = Completer<http.Response>();
      final entered = Completer<void>();
      final f = await fixture((r) async {
        entered.complete();
        return response.future;
      });
      final c = AppsController(f.scope);
      final initialization = c.initialize();
      await entered.future;
      f.session.user = {...f.session.user!, 'id': 'user-b'};
      f.session.selectWorkspace(f.session.workspace);
      response.complete(
        jsonResponse(
          [connectedApp()],
          headers: {'set-cookie': 'session=late; Path=/'},
        ),
      );
      await initialization;
      expect(c.active, isFalse);
      expect(c.apps, isEmpty);
      expect(f.secrets.values.values.join(), isNot(contains('late')));
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'confirmed save remains known when its following list refresh fails',
    () async {
      var accepted = false;
      final saved = {...connectedApp(id: 'saved-a'), ...appDraft()};
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          accepted = true;
          return jsonResponse(saved);
        }
        if (accepted) throw http.ClientException('Refresh unavailable');
        {
          return jsonResponse([]);
        }
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      expect(await c.add(appDraft()), saved);
      expect(c.find('saved-a'), saved);
      expect(c.hasPending, isFalse);
      expect(c.error, isNotNull);
    },
  );

  test(
    'failed pending storage prevents dispatch and no credentials are persisted',
    () async {
      final secrets = MemorySecrets();
      var posts = 0;
      final f = await fixture((r) async {
        if (r.method == 'POST') posts++;
        {
          return jsonResponse([]);
        }
      }, secrets: secrets);
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      secrets.rejectWrites = true;
      await c.add(appDraft(auth: 'bearer'));
      expect(posts, 0);
      expect(
        secrets.values.values.join(),
        isNot(contains('synthetic-access-token')),
      );
    },
  );

  test(
    'unavailable old-session OAuth flow cannot lock another connection',
    () async {
      final f = await fixture((r) async {
        if (r.method == 'POST') throw http.ClientException('Lost');
        if (r.url.path.contains('/oauth')) {
          return jsonResponse({'error': 'Denied'}, status: 403);
        }
        return jsonResponse([
          connectedApp(auth: 'oauth'),
          connectedApp(id: 'app-b'),
        ]);
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.startOAuth('app-a');
      await c.refresh();
      expect(c.pendingFor('app-a'), isNotNull);
      expect(c.canWriteConnection('app-b'), isTrue);
      await c.abandonLocalDraft('app-a');
      expect(c.pendingFor('app-a'), isNull);
    },
  );
  test(
    'unauthenticated service can explicitly upgrade to bearer but OAuth cannot',
    () async {
      final posted = <String>[];
      var app = connectedApp(status: 'needs_auth');
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          posted.add(r.body);
          app = connectedApp(auth: 'bearer', revision: 'rev-b');
          return jsonResponse(app);
        }
        if (r.url.path.endsWith('/oauth')) return http.Response('null', 200);
        return jsonResponse([app]);
      });
      final c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.change('app-a', 'reconnect', token: 'synthetic-token');
      expect(jsonDecode(posted.single), {'token': 'synthetic-token'});
      expect(c.find('app-a')?['authType'], 'bearer');
      app = connectedApp(auth: 'oauth');
      await c.refresh();
      await c.change('app-a', 'reconnect', token: 'synthetic-token');
      expect(posted.length, 1);
    },
  );
}
