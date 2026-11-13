import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/computer/cloud_computer_controller.dart';
import 'package:openbot_mobile/features/computer/computer_connection_controller.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'computer_support.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Future<void> scenario(
    Future<void> Function(ComputerServer, ComputerConnectionController, dynamic)
    run,
  ) async {
    final server = ComputerServer(await computerPng())..available = false;
    final f = await fixture(server.handle);
    f.scope.data = server.data;
    final computer = ComputerController(f.scope, 'bot-a');
    final connection = ComputerConnectionController(computer);
    try {
      await connection.refresh();
      await run(server, connection, f);
    } finally {
      connection.dispose();
      computer.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  }

  test(
    'opening is passive; local connect uses scoped owner API then refreshes',
    () => scenario((s, c, f) async {
      expect(s.requests.single.method, 'GET');
      expect(s.connections, 0);
      await c.connectLocal();
      expect(s.connections, 1);
      expect(c.location, 'server');
      expect(c.computer.frame, isNotNull);
      expect(s.starts, 0);
      final writes = s.requests.where((r) => r.method == 'POST').toList();
      expect(writes.length, 1);
      expect(
        writes.single.url.path,
        '/api/workspaces/space-a/computer/connect',
      );
      expect(jsonDecode(writes.single.body), {'mode': 'local'});
      expect(writes.single.headers['X-OpenBot-Expected-User'], 'user-a');
      await c.connectLocal();
      expect(s.connections, 1);
      await c.disconnect();
      expect(s.disconnections, 1);
      expect(c.connected, false);
    }),
  );

  test(
    'owner loss, takeover and background each prevent connection writes',
    () => scenario((s, c, f) async {
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'member',
      });
      await c.connectLocal();
      expect(s.connections, 0);
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'owner',
      });
      c.computer.occupied = true;
      await c.connectLocal();
      expect(s.connections, 0);
      c.computer.occupied = false;
      c.computer.suspend();
      await c.connectLocal();
      expect(s.connections, 0);
    }),
  );

  test(
    'connection change excludes duplicate writes and cloud start',
    () => scenario((s, c, f) async {
      s.cloudConfigured = true;
      final cloud = CloudComputerController(c.computer);
      await cloud.refresh();
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/connect')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final pending = c.connectLocal();
      await called.future;
      await c.connectLocal();
      await cloud.start();
      expect(s.cloudStarts, 0);
      expect(s.requests.where((r) => r.method == 'POST').length, 1);
      reply.complete(jsonResponse({'error': 'Synthetic busy'}, status: 409));
      await pending;
      expect(c.error, 'Synthetic busy');
      expect(c.unknown, false);
      expect(c.computer.busy, false);
      cloud.dispose();
    }),
  );

  test(
    'lost response locks all connection changes until explicit successful read',
    () => scenario((s, c, f) async {
      s.cloudConfigured = true;
      final cloud = CloudComputerController(c.computer);
      await cloud.refresh();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/connect')) {
          await s.respond(r);
          throw http.ClientException('Synthetic lost response');
        }
        return s.respond(r);
      };
      await c.connectLocal();
      expect(c.unknown, true);
      await c.disconnect();
      await cloud.start();
      expect(s.connections, 1);
      expect(s.disconnections, 0);
      expect(s.cloudStarts, 0);
      await c.refresh(acknowledge: false);
      expect(c.unknown, true);
      s.intercept = (r) async =>
          jsonResponse({'error': 'Offline'}, status: 503);
      await c.refresh();
      expect(c.unknown, true);
      s.intercept = null;
      await c.refresh();
      expect(c.unknown, false);
      expect(c.location, 'server');
      expect(s.connections, 1);
      cloud.dispose();
    }),
  );

  test(
    'malformed mutation response is unknown, not a successful connection',
    () => scenario((s, c, f) async {
      s.intercept = (r) async =>
          r.method == 'POST' ? jsonResponse({'ok': true}) : s.respond(r);
      await c.connectLocal();
      expect(c.unknown, true);
      expect(c.connected, false);
      expect(c.canChange, false);
    }),
  );

  test(
    'cloud uncertainty cannot be cleared by a local connection read',
    () => scenario((s, c, f) async {
      s.cloudConfigured = true;
      final cloud = CloudComputerController(c.computer);
      await cloud.refresh();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/cloud-computer/start')) {
          s.cloudStarts++;
          throw http.ClientException('Synthetic lost cloud response');
        }
        return s.respond(r);
      };
      await cloud.start();
      expect(cloud.unknown, true);
      expect(c.canChange, false);
      await c.refresh();
      expect(c.canChange, false);
      await c.connectLocal();
      await c.connectRemote('https://worker.example.test', 'synthetic-token');
      expect(s.connections, 0);
      await cloud.refresh();
      expect(c.canChange, true);
      cloud.dispose();
    }),
  );

  test(
    'workspace switch discards a late connection response',
    () => scenario((s, c, f) async {
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/connect')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final pending = c.connectLocal();
      await called.future;
      final next = <String, dynamic>{...f.session.workspace!, 'id': 'space-b'};
      f.session.workspaces.add(next);
      f.session.selectWorkspace(next);
      reply.complete(
        jsonResponse({
          'connected': true,
          'mode': 'local',
          'surface': 'browser',
        }),
      );
      await pending;
      expect(c.active, false);
      expect(c.connected, false);
      expect(s.requests.where((r) => r.method == 'POST').length, 1);
      expect(s.requests.any((r) => r.url.path.contains('space-b')), false);
    }),
  );

  test(
    'pairing uses HTTPS, keeps credentials out of storage and supports reconnect',
    () => scenario((s, c, f) async {
      await c.connectRemote('https://worker.example.test', 'synthetic-token');
      expect(s.connections, 1);
      expect(c.location, 'remote');
      expect(f.secrets.values.toString(), isNot(contains('synthetic-token')));
      expect(c.machine.toString(), isNot(contains('synthetic-token')));
      await c.disconnect();
      await c.reconnect();
      expect(s.reconnections, 1);
      expect(c.connected, true);
    }),
  );

  test(
    'worker address rejects embedded credentials, fragments and nonlocal HTTP',
    () {
      for (final invalid in [
        'https://user:password@worker.example.test',
        'http://worker.example.test',
        'file:///tmp/worker',
        'https://worker.example.test?token=secret',
        'https://worker.example.test#fragment',
        'https://worker.example.test/with space',
      ]) {
        expect(computerWorkerAddress(invalid), null, reason: invalid);
      }
      expect(computerWorkerAddress('https://worker.example.test'), isNotNull);
      expect(computerWorkerAddress('http://127.0.0.1'), isNotNull);
      expect(computerWorkerAddress('http://[::1]'), isNotNull);
    },
  );

  test(
    'full desktop selection requires existing driver authorization',
    () => scenario((s, c, f) async {
      await c.connectLocal();
      s.desktop = {'available': true, 'authorized': false, 'kind': 'host'};
      await c.computer.refresh();
      await c.selectSurface('desktop');
      expect(s.surface, 'browser');
      s.desktop!['authorized'] = true;
      await c.computer.refresh();
      await c.selectSurface('desktop');
      expect(s.surface, 'desktop');
      expect(c.computer.status?.surface, 'desktop');
      final write = s.requests.singleWhere(
        (r) => r.url.path.endsWith('/surface'),
      );
      expect(jsonDecode(write.body), {'surface': 'desktop', 'confirm': true});
      expect(s.starts, 0);
      expect(s.inputs, isEmpty);
    }),
  );
}
