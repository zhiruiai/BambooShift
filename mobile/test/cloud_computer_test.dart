import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/computer/cloud_computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_data.dart';
import 'computer_support.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Future<void> scenario(
    Future<void> Function(
      ComputerServer,
      ComputerController,
      CloudComputerController,
      dynamic,
    )
    run,
  ) async {
    final s = ComputerServer(await computerPng())..cloudConfigured = true;
    final f = await fixture(s.handle);
    f.scope.data = s.data;
    final c = ComputerController(f.scope, 'bot-a');
    final actual = CloudComputerController(c);
    try {
      await run(s, c, actual, f);
    } finally {
      actual.dispose();
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  }

  test(
    'location is explicit or falls back to the legacy server/remote mode',
    () {
      for (final location in ['server', 'cloud', 'remote', 'none']) {
        expect(
          computerExecutionLocation({
            'executionLocation': location,
            'mode': 'local',
          }),
          location,
        );
      }
      expect(computerExecutionLocation({'mode': 'local'}), 'server');
      expect(computerExecutionLocation({'mode': 'remote'}), 'remote');
      expect(computerExecutionLocation(null), 'unknown');
    },
  );
  test(
    'cloud GET is passive; owner explicitly starts once and member cannot start',
    () => scenario((s, c, cloud, f) async {
      await cloud.refresh();
      expect(s.cloudStarts, 0);
      expect(s.requests.length, 1);
      expect(s.requests.single.url.path.endsWith('/cloud-computer'), true);
      await c.refresh();
      expect(cloud.canStart, true);
      await cloud.start();
      expect(s.cloudStarts, 1);
      expect(cloud.status?.state, 'running');
      expect(c.frame, isNotNull);
      for (final r in s.requests) {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
      }
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'member',
      });
      expect(cloud.canStart, false);
      await cloud.start();
      expect(s.cloudStarts, 1);
    }),
  );
  test(
    'cloud start blocks duplicate writes and observations; conflict preserves error',
    () => scenario((s, c, cloud, f) async {
      await c.refresh();
      await cloud.refresh();
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/cloud-computer/start')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final start = cloud.start();
      await called.future;
      final count = s.requests.length;
      await cloud.start();
      await c.refresh();
      expect(s.requests.length, count);
      expect(c.frame, isNull);
      reply.complete(jsonResponse({'error': 'Synthetic busy'}, status: 409));
      await start;
      expect(cloud.actionError, 'Synthetic busy');
      expect(cloud.unknown, false);
      expect(s.requests.where((r) => r.method == 'POST').length, 1);
      expect(c.busy, false);
    }),
  );
  test(
    'unknown cloud write is not replayed and only explicit refresh unlocks retry',
    () => scenario((s, c, cloud, f) async {
      await c.refresh();
      await cloud.refresh();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/cloud-computer/start')) {
          s.cloudStarts++;
          throw http.ClientException('lost');
        }
        return s.respond(r);
      };
      await cloud.start();
      expect(cloud.unknown, true);
      await cloud.start();
      expect(s.cloudStarts, 1);
      await cloud.refresh();
      expect(cloud.unknown, false);
      expect(cloud.actionError, isNotNull);
    }),
  );
  test(
    'active or unconfirmed takeover prevents cloud start',
    () => scenario((s, c, cloud, f) async {
      await c.refresh();
      await cloud.refresh();
      await c.start();
      expect(cloud.canStart, false);
      await cloud.start();
      expect(s.cloudStarts, 0);
      await c.end();
    }),
  );
  test(
    'shared local surface requires a target revision and changes identity when replaced',
    () {
      final value = <String, dynamic>{
        'connected': true,
        'surface': 'browser',
        'botScreen': {
          'agentId': 'a',
          'shared': true,
          'status': 'ready',
          'lifecycle': {'state': 'ready'},
        },
      };
      expect(() => ComputerStatus(value, 'a'), throwsA(anything));
      final first = ComputerStatus({
        ...value,
        'targetRevision': '11111111-1111-4111-8111-111111111111',
      }, 'a');
      final second = ComputerStatus({
        ...value,
        'targetRevision': '22222222-2222-4222-8222-222222222222',
      }, 'a');
      expect(first.ready, true);
      expect(first.fingerprint, isNot(second.fingerprint));
    },
  );
}
