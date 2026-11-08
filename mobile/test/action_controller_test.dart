import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';

import 'action_card_support.dart';
import 'support.dart';

void main() {
  test(
    'only a definitive recurring rejection permits an explicit retry',
    () async {
      for (final code in [
        'APP_APPROVAL_RULE_CHANGED',
        'APP_APPROVAL_RULE_LIMIT',
        'UNKNOWN',
      ]) {
        final message = exactReadAction();
        final data = bootstrap(messages: [message]);
        final writes = <Object?>[];
        final f = await fixture((request) async {
          if (request.method == 'GET') return jsonResponse(data);
          writes.add(jsonDecode(request.body));
          if (writes.length == 1) {
            return jsonResponse({
              'code': code,
              'error': 'Synthetic rejection',
            }, status: 409);
          }
          return jsonResponse({'id': actionId, 'status': 'running'});
        });
        f.scope.data = data;
        final c = controller(f.scope, message);
        await c.initialize();
        await c.decide(true, alwaysAllowFingerprint: c.current!.fingerprint);
        expect(c.uncertain, code == 'UNKNOWN');
        if (code != 'UNKNOWN') {
          expect(f.secrets.values, isEmpty);
          expect(
            c.error,
            code.endsWith('LIMIT')
                ? 'mobileAppsRuleLimit'
                : 'mobileAppsRuleChanged',
          );
        }
        await c.decide(true);
        expect(writes, [
          {'decision': 'always_allow'},
          if (code != 'UNKNOWN') {'approve': true},
        ]);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );

  test(
    'a saved permission is not dispatched if reviewed exact parameters change',
    () async {
      final message = exactReadAction();
      final newer = exactReadAction();
      newer['metadata']['appAction']['arguments']['issue_number'] = 43;
      var writes = 0;
      final f = await fixture((request) async {
        if (request.method == 'POST') writes++;
        return jsonResponse(bootstrap(messages: [newer]));
      });
      f.scope.data = bootstrap(messages: [message]);
      final c = controller(f.scope, message);
      await c.initialize();
      await c.decide(true, alwaysAllowFingerprint: c.current!.fingerprint);
      expect(writes, 0);
      expect(c.error, 'mobileChatActionChanged');
      expect(f.secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'app and computer decisions bind exact ID, requester and original version',
    () async {
      for (final kind in ['app', 'computer']) {
        var writes = 0;
        final message = actionMessage(kind: kind);
        final data = bootstrap(messages: [message]);
        final f = await fixture((request) async {
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          if (request.method == 'POST') {
            writes++;
            expect(
              request.url.path,
              kind == 'app'
                  ? '/api/workspaces/space-a/app-actions/$actionId/decision'
                  : '/api/workspaces/space-a/computer/actions/$actionId/approve',
            );
            expect(
              jsonDecode(request.body),
              kind == 'app' ? {'approve': true} : {},
            );
            final action =
                message['metadata'][kind == 'app' ? 'appAction' : 'action']
                    as Json;
            action['status'] = 'running';
            return jsonResponse(action);
          }
          return jsonResponse(data);
        });
        f.scope.data = data;
        f.session.workspace!['role'] = 'member';
        final c = controller(f.scope, message);
        await c.initialize();
        expect(writes, 0);
        await c.decide(true);
        expect(writes, 1);
        expect(c.current!.status, 'running');
        await c.decide(true);
        expect(writes, 1);
        expect(f.secrets.values.values, ['submitted']);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'owner cannot decide for a peer and malformed requester is fail closed',
    () async {
      for (final requester in ['peer', 'null']) {
        var calls = 0;
        final message = actionMessage(requester: requester);
        if (requester == 'null') {
          message['metadata']['appAction']['requester'] = null;
        }
        final f = await fixture((_) async {
          calls++;
          return jsonResponse({});
        });
        f.scope.data = bootstrap(messages: [message]);
        final c = controller(f.scope, message);
        await c.initialize();
        await c.decide(true);
        expect(c.canDecide, false);
        expect(calls, 0);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'unknown approval survives remount and only checks the original action',
    () async {
      var writes = 0;
      final message = actionMessage();
      final data = bootstrap(messages: [message]);
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes++;
          throw http.ClientException('synthetic lost response');
        }
        return jsonResponse(data);
      });
      f.scope.data = data;
      final first = controller(f.scope, message);
      await first.initialize();
      await first.decide(true);
      expect(first.uncertain, true);
      first.dispose();
      final restored = controller(f.scope, message);
      await restored.initialize();
      await restored.refresh();
      await restored.decide(true);
      expect(restored.uncertain, true);
      expect(restored.canDecide, false);
      expect(writes, 1);
      message['metadata']['appAction']['status'] = 'done';
      await restored.refresh();
      expect(restored.current!.status, 'done');
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'fresh changed parameters and late account changes dispatch no decision',
    () async {
      for (final changeAccount in [false, true]) {
        final late = Completer<http.Response>();
        var writes = 0;
        final message = actionMessage();
        final f = await fixture((request) async {
          if (request.method == 'POST') {
            writes++;
            return jsonResponse({});
          }
          return late.future;
        });
        f.scope.data = bootstrap(messages: [message]);
        final c = controller(f.scope, message);
        await c.initialize();
        final pending = c.decide(true);
        if (changeAccount) f.session.user = {'id': 'other-user'};
        final changed = actionMessage();
        changed['metadata']['appAction']['arguments'] = {'query': 'changed'};
        late.complete(jsonResponse(bootstrap(messages: [changed])));
        await pending;
        expect(writes, 0);
        expect(f.secrets.values, isEmpty);
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'two mounted cards serialize one decision and storage failure sends none',
    () async {
      for (final rejectStorage in [false, true]) {
        var writes = 0;
        final message = actionMessage();
        final data = bootstrap(messages: [message]);
        final f = await fixture((request) async {
          if (request.method == 'POST') {
            writes++;
            return jsonResponse({'id': actionId, 'status': 'running'});
          }
          return jsonResponse(data);
        });
        f.scope.data = data;
        f.secrets.rejectWrites = rejectStorage;
        final a = controller(f.scope, message),
            b = controller(f.scope, message);
        await Future.wait([a.initialize(), b.initialize()]);
        await Future.wait([a.decide(true), b.decide(false)]);
        expect(writes, rejectStorage ? 0 : 1);
        a.dispose();
        b.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}
