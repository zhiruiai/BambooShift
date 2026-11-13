import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/mcp_import_preview.dart';
import 'package:openbot_mobile/features/apps/remote_mcp_import.dart';

import 'support.dart';

const previewPath = '/api/workspaces/space-a/apps/import/preview';
const canonical = 'https://remote.example.test/mcp';
Json previewResponse() => {
  'candidates': [
    {'name': 'Synthetic service', 'url': canonical},
  ],
  'skipped': 1,
  'error': null,
};
RemoteMcpImportResult draft() => parseRemoteMcpImport(
  jsonEncode({
    'servers': {
      'Synthetic service': {'url': canonical},
    },
  }),
);

void main() {
  test(
    'preview sends only projected names and addresses to the workspace',
    () async {
      final requests = <http.Request>[];
      final f = await fixture((request) async {
        requests.add(request);
        if (request.url.path == previewPath) {
          return jsonResponse(previewResponse());
        }
        return jsonResponse([]);
      });
      final controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await controller.initialize();
      final projected = parseRemoteMcpImport(
        jsonEncode({
          'mcpServers': {
            'Synthetic service': {
              'url': 'HTTPS://REMOTE.EXAMPLE.TEST/mcp',
              'headers': {'Authorization': 'Bearer synthetic-header-secret'},
              'env': {'API_KEY': 'synthetic-env-secret'},
              'token': 'synthetic-token-secret',
            },
            'Local command': {
              'command': 'synthetic-command',
              'args': ['private-arg'],
            },
          },
        }),
      );
      final result = await previewRemoteMcpImport(controller, projected);
      expect(result.candidates.single.url, canonical);
      final writes = requests.where((r) => r.method != 'GET').toList();
      expect(writes, hasLength(1));
      expect(writes.single.url.path, previewPath);
      expect(jsonDecode(writes.single.body), {
        'candidates': [
          {
            'name': 'Synthetic service',
            'url': 'HTTPS://REMOTE.EXAMPLE.TEST/mcp',
          },
        ],
        'skipped': 1,
      });
      expect(requests.every((r) => r.url.host == 'api.example.test'), isTrue);
      expect(controller.apps, isEmpty);
      expect(controller.hasPending, isFalse);
      expect(
        f.secrets.values.values.join(),
        isNot(contains('synthetic-token-secret')),
      );
    },
  );

  for (final change in ['permission', 'workspace', 'close']) {
    test('pending preview cannot return after $change is revoked', () async {
      final response = Completer<http.Response>();
      final sent = Completer<void>();
      final requests = <http.Request>[];
      final f = await fixture((request) async {
        requests.add(request);
        if (request.url.path == previewPath) {
          sent.complete();
          return response.future;
        }
        return jsonResponse([]);
      });
      final controller = AppsController(f.scope);
      var disposed = false;
      addTearDown(() {
        if (!response.isCompleted) {
          response.complete(jsonResponse(previewResponse()));
        }
        if (!disposed) controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await controller.initialize();
      final pending = previewRemoteMcpImport(controller, draft());
      final rejected = expectLater(pending, throwsA(isA<ApiException>()));
      await sent.future;
      if (change == 'permission') {
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
      } else if (change == 'workspace') {
        final next = {...f.session.workspace!, 'id': 'space-b'};
        f.session.workspaces.add(next);
        f.session.selectWorkspace(next);
      } else {
        controller.dispose();
        disposed = true;
      }
      response.complete(jsonResponse(previewResponse()));
      await rejected;
      expect(requests.where((r) => r.method == 'POST').map((r) => r.url.path), [
        previewPath,
      ]);
    });
  }

  test('members cannot send a preview request', () async {
    var posts = 0;
    final f = await fixture((request) async {
      if (request.method == 'POST') posts++;
      return jsonResponse([]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await controller.initialize();
    f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
    await expectLater(
      previewRemoteMcpImport(controller, draft()),
      throwsA(isA<ApiException>()),
    );
    expect(posts, 0);
  });

  test(
    'unusable preview responses are rejected instead of offered as choices',
    () {
      for (final value in [
        [],
        {...previewResponse()}..remove('error'),
        {'candidates': [], 'skipped': 0, 'error': null},
        {'candidates': [], 'skipped': -1, 'error': 'empty'},
        {'candidates': [], 'skipped': 101, 'error': 'empty'},
        {'candidates': [], 'skipped': 0, 'error': 'unknown'},
        {
          'candidates': [
            {'name': 'Unsafe', 'url': 'https://user:secret@example.test/mcp'},
          ],
          'skipped': 0,
          'error': null,
        },
        {
          'candidates': [
            {'name': 'One', 'url': canonical},
            {'name': 'Two', 'url': canonical},
          ],
          'skipped': 0,
          'error': null,
        },
      ]) {
        expect(() => readPreview(value), throwsA(isA<ApiException>()));
      }
      expect(
        readPreview({'candidates': [], 'skipped': 2, 'error': 'empty'}).error,
        'empty',
      );
    },
  );
}
