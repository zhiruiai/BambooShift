import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/oauth_launch.dart';

import 'apps_support.dart';
import 'support.dart';

void main() {
  test(
    'OAuth requires explicit start, launch and finish; complete is not connected',
    () async {
      final events = <String>[];
      final opened = <Uri>[];
      final secrets = MemorySecrets();
      Json? flow;
      var app = connectedApp(auth: 'oauth', status: 'needs_auth');
      final f = await fixture((r) async {
        events.add('${r.method} ${r.url.path}');
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        if (r.url.path.endsWith('/start')) {
          expect(jsonDecode(r.body), {
            'expectedRevision': 'rev-a',
            'clientId': 'public-id',
            'clientSecret': 'synthetic-client-secret',
          });
          expect(
            secrets.values.values.join(),
            isNot(contains('synthetic-client-secret')),
          );
          flow = oauthFlow();
          app = {...app, 'revision': 'rev-b'};
          return jsonResponse(flow!);
        }
        if (r.url.path.endsWith('/launch')) {
          return jsonResponse({
            'launchPath': '/app-authorize/space-a/app-a/flow-a',
          });
        }
        if (r.url.path.endsWith('/finish')) {
          flow = oauthFlow(status: 'complete');
          app = {...app, 'status': 'error', 'hasCredential': true};
          return jsonResponse(flow!);
        }
        if (r.url.path.endsWith('/oauth')) {
          return http.Response(jsonEncode(flow), 200);
        }
        return jsonResponse([app]);
      }, secrets: secrets);
      final c = AppsController(
        f.scope,
        launcher: (uri) async {
          opened.add(uri);
          return true;
        },
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.refresh('app-a');
      expect(events.every((e) => e.startsWith('GET')), isTrue);
      await c.startOAuth(
        'app-a',
        clientId: 'public-id',
        clientSecret: 'synthetic-client-secret',
      );
      expect(opened, isEmpty);
      expect(c.flows['app-a']?['status'], 'pending');
      await c.openOAuth('app-a');
      expect(
        opened.single.toString(),
        'https://api.example.test/app-authorize/space-a/app-a/flow-a',
      );
      flow = oauthFlow(status: 'callback_received');
      await c.refresh('app-a');
      expect(events.where((e) => e.endsWith('/finish')), isEmpty);
      await c.finishOAuth('app-a');
      expect(events.where((e) => e.endsWith('/finish')).length, 1);
      expect(c.flows['app-a']?['status'], 'complete');
      expect(c.find('app-a')?['status'], 'error');
      expect(c.hasPending, isFalse);
    },
  );

  test(
    'lost start recovers from GET; lost finish never repeats and explicit cancel is allowed',
    () async {
      Json? flow;
      var revision = 'rev-a';
      final posts = <String>[];
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          posts.add(r.url.path);
          if (r.url.path.endsWith('/start')) {
            flow = oauthFlow();
            revision = 'rev-b';
            throw http.ClientException('Lost start');
          }
          if (r.url.path.endsWith('/finish')) {
            throw http.ClientException('Lost finish');
          }
          if (r.url.path.endsWith('/cancel')) {
            flow = oauthFlow(status: 'cancelled');
            return jsonResponse(flow!);
          }
        }
        if (r.url.path.contains('/oauth')) {
          return http.Response(jsonEncode(flow), 200);
        }
        return jsonResponse([connectedApp(auth: 'oauth', revision: revision)]);
      });
      var c = AppsController(f.scope);
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.startOAuth('app-a');
      expect(c.hasPending, isTrue);
      c.dispose();
      c = AppsController(f.scope);
      await c.initialize();
      expect(c.hasPending, isFalse);
      expect(posts.length, 1);
      flow = oauthFlow(status: 'callback_received');
      await c.refresh('app-a');
      await c.finishOAuth('app-a');
      await c.refresh('app-a');
      await c.finishOAuth('app-a');
      expect(posts.where((p) => p.endsWith('/finish')).length, 1);
      expect(c.hasPending, isTrue);
      await c.cancelOAuth('app-a');
      expect(c.flows['app-a']?['status'], 'cancelled');
      expect(c.hasPending, isFalse);
      expect(posts.where((p) => p.endsWith('/cancel')).length, 1);
    },
  );

  test(
    'old flow completion is read by exact ID even after a later flow starts',
    () async {
      var initial = true;
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          initial = false;
          throw http.ClientException('Lost');
        }
        if (r.url.path.endsWith('/oauth/flow-a')) {
          return jsonResponse(oauthFlow(status: 'complete'));
        }
        if (r.url.path.endsWith('/oauth')) {
          return jsonResponse(
            oauthFlow(
              id: initial ? 'flow-a' : 'flow-b',
              status: initial ? 'callback_received' : 'pending',
            ),
          );
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
      await c.finishOAuth('app-a');
      expect(c.hasPending, isTrue);
      await c.refresh('app-a');
      expect(c.hasPending, isFalse);
      expect(c.flows['app-a']?['id'], 'flow-b');
    },
  );

  test(
    'launch rejects arbitrary URLs and only opens the configured server',
    () async {
      final origin = Uri.parse('https://api.example.test');
      for (final path in [
        'https://provider.example.test/authorize',
        '//api.example.test/app-authorize/space-a/app-a/flow-a',
        '/app-authorize/space-b/app-a/flow-a',
        '/app-authorize/space-a/app-a/flow-a?next=x',
        '/app-authorize/space-a/app-a/flow-a#x',
        'javascript:alert(1)',
      ]) {
        expect(
          () => oauthLaunchUri(origin, 'space-a', 'app-a', 'flow-a', path),
          throwsA(isA<ApiException>()),
        );
      }
      expect(
        oauthLaunchUri(
          Uri.parse('http://127.0.0.1:3001'),
          'space-a',
          'app-a',
          'flow-a',
          '/app-authorize/space-a/app-a/flow-a',
        ).port,
        3001,
      );
      var opens = 0;
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/launch')) {
          return jsonResponse({
            'launchPath': 'https://provider.example.test/authorize',
          });
        }
        if (r.url.path.endsWith('/oauth')) return jsonResponse(oauthFlow());
        {
          return jsonResponse([connectedApp(auth: 'oauth')]);
        }
      });
      final c = AppsController(
        f.scope,
        launcher: (_) async {
          opens++;
          return true;
        },
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.refresh('app-a');
      await c.openOAuth('app-a');
      expect(opens, 0);
      expect(c.error, 'mobileAppsLaunchRejected');
    },
  );

  test(
    'account switch while launch confirmation is pending cannot open browser',
    () async {
      final reply = Completer<http.Response>(), entered = Completer<void>();
      var opens = 0;
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/launch')) {
          entered.complete();
          return reply.future;
        }
        if (r.url.path.endsWith('/oauth')) return jsonResponse(oauthFlow());
        {
          return jsonResponse([connectedApp(auth: 'oauth')]);
        }
      });
      final c = AppsController(
        f.scope,
        launcher: (_) async {
          opens++;
          return true;
        },
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.refresh('app-a');
      final launch = c.openOAuth('app-a');
      await entered.future;
      f.session.user = {...f.session.user!, 'id': 'user-b'};
      f.session.selectWorkspace(f.session.workspace);
      reply.complete(
        jsonResponse({'launchPath': '/app-authorize/space-a/app-a/flow-a'}),
      );
      await launch;
      expect(opens, 0);
    },
  );
}
