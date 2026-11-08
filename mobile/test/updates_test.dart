import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/updates/updates_controller.dart';

import 'support.dart';

Json updateStatus({String status = 'unconfigured'}) => {
  'scope': {'userId': 'user-a', 'workspaceId': 'space-a'},
  'repository': null,
  'serviceVersion': '0.1.0',
  'status': status,
  'reason': null,
  'release': null,
  'checkedAt': null,
};
Json released() => {
  ...updateStatus(status: 'update_available'),
  'repository': 'example/openbot',
  'checkedAt': '2026-11-07T00:00:00Z',
  'release': {
    'tag': 'v0.2.0',
    'version': '0.2.0',
    'name': 'OpenBot 0.2.0',
    'notes': 'Synthetic release notes.',
    'publishedAt': '2026-11-07T00:00:00Z',
    'url': 'https://github.com/example/openbot/releases/tag/v0.2.0',
  },
};

void main() {
  test(
    'opening update status is GET only and unconfigured never means current',
    () async {
      final requests = <String>[];
      final value = await fixture((request) async {
        requests.add(request.method);
        expect(request.url.path, '/api/workspaces/space-a/updates');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        return jsonResponse(updateStatus());
      });
      final model = UpdatesController(value.scope);
      await model.read();
      expect(model.data?['status'], 'unconfigured');
      expect(model.canCheck, false);
      expect(model.releaseUri, isNull);
      await model.read(check: true);
      expect(requests, ['GET']);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'one explicit check posts an empty body, never installs or follows release URLs',
    () async {
      final requests = <http.Request>[];
      final value = await fixture((request) async {
        requests.add(request);
        return jsonResponse(
          request.method == 'GET'
              ? {
                  ...updateStatus(status: 'unavailable'),
                  'repository': 'example/openbot',
                  'reason': 'not_checked',
                }
              : released(),
        );
      });
      value.session.workspaces.first['role'] = 'member';
      final model = UpdatesController(value.scope);
      await model.read();
      expect(model.canCheck, true);
      await model.read(check: true);
      expect(requests.map((r) => r.method), ['GET', 'POST']);
      expect(requests.last.body, '{}');
      expect(
        model.releaseUri.toString(),
        'https://github.com/example/openbot/releases/tag/v0.2.0',
      );
      expect(value.secrets.values, isEmpty);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'cross-workspace and forged release destinations are rejected',
    () async {
      final value = await fixture((_) async => jsonResponse({}));
      for (final invalid in [
        {
          ...released(),
          'scope': {'userId': 'user-b', 'workspaceId': 'space-a'},
        },
        {...released(), 'repository': '../other'},
        {
          ...released(),
          'release': {
            ...released()['release'] as Json,
            'url': 'https://untrusted.example.test/install',
          },
        },
        {
          ...released(),
          'release': {...released()['release'] as Json, 'tag': '..'},
        },
        {...updateStatus(status: 'current')},
      ]) {
        expect(
          () => checkedUpdates(invalid, value.scope),
          throwsA(isA<ApiException>()),
        );
      }
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test('late results and duplicate taps cannot cross actor scope', () async {
    final reply = Completer<http.Response>(), sent = Completer<void>();
    var requests = 0;
    final value = await fixture((_) async {
      requests++;
      sent.complete();
      return reply.future;
    });
    final model = UpdatesController(value.scope);
    final reading = model.read();
    await sent.future;
    await model.read();
    expect(requests, 1);
    value.session.user = {'id': 'user-b'};
    reply.complete(jsonResponse(released()));
    await reading;
    expect(model.data, isNull);
    expect(model.releaseUri, isNull);
    model.dispose();
    value.scope.dispose();
    value.session.dispose();
  });
}
