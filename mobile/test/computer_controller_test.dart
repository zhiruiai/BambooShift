import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';

import 'computer_support.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Future<void> scenario(
    Future<void> Function(ComputerServer, ComputerController, dynamic) run,
  ) async {
    final s = ComputerServer(await computerPng());
    final f = await fixture(s.handle);
    f.scope.data = s.data;
    final c = ComputerController(f.scope, 'bot-a');
    try {
      await run(s, c, f);
    } finally {
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  }

  test(
    'member reads without prepare and explicitly controls with exact actor and lease',
    () => scenario((s, c, f) async {
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'member',
      });
      await c.refresh();
      expect(c.frame?.source.width, 800);
      expect(c.frame?.isPrivate, false);
      expect(c.canStart, true);
      expect(s.requests.every((r) => r.method == 'GET'), true);
      await c.start();
      expect(c.canInput, true);
      expect(c.frame?.isPrivate, true);
      for (final action in <Json>[
        {'type': 'click', 'x': 400, 'y': 200},
        {'type': 'type', 'text': 'Synthetic text'},
        {'type': 'key', 'key': 'Enter'},
        {'type': 'scroll', 'deltaY': 400},
      ]) {
        expect(await c.input(action), true);
      }
      expect(s.inputs.length, 4);
      expect(s.inputs.every((v) => v['leaseId'] == 'lease-original'), true);
      expect(await c.end(), true);
      expect(c.lease, isNull);
      expect(s.starts, 1);
      expect(s.ends, 1);
      for (final r in s.requests) {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(
          r.url.path.startsWith('/api/workspaces/space-a/computer/'),
          true,
        );
        expect(r.url.path, isNot(contains('prepare')));
      }
      expect(f.secrets.values.values.join(), isNot(contains('Synthetic text')));
    }),
  );
  test(
    'unassigned and occupied screens do not grant control or allocate',
    () => scenario((s, c, f) async {
      s.assigned = false;
      await c.refresh();
      await c.start();
      expect(c.frame, isNull);
      expect(s.starts, 0);
      s.assigned = true;
      s.active = true;
      await c.refresh();
      await c.start();
      expect(c.canStart, false);
      expect(c.lease, isNull);
      expect(s.starts, 0);
      expect(await c.input({'type': 'key', 'key': 'Enter'}), false);
      expect(s.inputs, isEmpty);
    }),
  );
  test(
    'an outdated worker shows shared screenshots without accepting a takeover',
    () => scenario((s, c, f) async {
      s.privateCapable = false;
      await c.refresh();
      expect(c.frame?.isPrivate, false);
      expect(c.canStart, false);
      await c.start();
      expect(s.starts, 0);
      s.active = true;
      final previous = s.requests
          .where((r) => r.url.path.endsWith('/screenshot'))
          .length;
      await c.refresh();
      expect(c.frame, isNull);
      expect(c.occupied, true);
      expect(
        s.requests.where((r) => r.url.path.endsWith('/screenshot')),
        hasLength(previous),
      );
    }),
  );
  test(
    'unconfirmed release immediately removes the private frame and never falls back',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      final delayed = Completer<http.Response>();
      final ending = Completer<void>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/takeover/end')) {
          ending.complete();
          return delayed.future;
        }
        return s.respond(r);
      };
      final end = c.end();
      await ending.future;
      expect(c.frame, isNull);
      expect(c.canInput, false);
      delayed.complete(
        jsonResponse({'error': 'Synthetic timeout'}, status: 503),
      );
      expect(await end, false);
      final screenshots = s.requests
          .where((r) => r.url.path.endsWith('/screenshot'))
          .length;
      await c.refresh();
      expect(c.frame, isNull);
      expect(
        s.requests.where((r) => r.url.path.endsWith('/screenshot')),
        hasLength(screenshots),
      );
    }),
  );
  test(
    'lease expiry cancels a private capture before late bytes become visible',
    () => scenario((s, c, f) async {
      s.leaseLifetime = const Duration(seconds: 1);
      await c.refresh();
      await c.start();
      expect(c.frame?.isPrivate, true);
      final dispatched = Completer<void>();
      final image = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/takeover/screenshot')) {
          dispatched.complete();
          return image.future;
        }
        return s.respond(r);
      };
      final refresh = c.refresh();
      await dispatched.future;
      await Future<void>.delayed(const Duration(milliseconds: 1050));
      image.complete(await s.respond(s.requests.last));
      await refresh;
      expect(c.frame, isNull);
      expect(c.canInput, false);
      expect(s.inputs, isEmpty);
    }),
  );
  test(
    'workspace target change discards the private frame before release completes',
    () => scenario((s, c, f) async {
      s.workspaceTarget = {
        'targetRevision': 'target-original',
        'connected': true,
        'mode': 'local',
      };
      await f.scope.refresh();
      await c.refresh();
      await c.start();
      expect(c.frame?.isPrivate, true);
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/takeover/end')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      s.workspaceTarget = {
        'targetRevision': 'target-replacement',
        'connected': true,
        'mode': 'remote',
      };
      await f.scope.refresh();
      await called.future;
      expect(c.frame, isNull);
      expect(c.status, isNull);
      expect(c.canInput, false);
      expect(s.inputs, isEmpty);
      reply.complete(await s.respond(s.requests.last));
      for (var attempt = 0; attempt < 50 && c.busy; attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(c.lease, isNull);
      expect(s.ends, 1);
    }),
  );
  test(
    'unknown start never borrows an active lease or retries after refresh',
    () => scenario((s, c, f) async {
      await c.refresh();
      s.loseStart = true;
      await c.start();
      expect(c.unknownStart, true);
      expect(c.lease, isNull);
      await c.refresh();
      await c.start();
      expect(s.starts, 1);
      expect(c.canInput, false);
      s.active = false;
      await c.refresh();
      expect(c.unknownStart, false);
      expect(c.canStart, true);
    }),
  );
  test(
    'lost input is not replayed; new input requires a new frame and explicit acknowledgement',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      s.loseInput = true;
      expect(
        await c.input({'type': 'type', 'text': 'Synthetic private text'}),
        false,
      );
      expect(c.uncertain, true);
      c.acknowledge();
      expect(c.uncertain, true);
      await c.input({'type': 'type', 'text': 'Synthetic private text'});
      await c.refresh();
      expect(s.inputs.length, 1);
      expect(c.canInput, false);
      expect(c.canAcknowledge, true);
      c.acknowledge();
      s.loseInput = false;
      expect(await c.input({'type': 'key', 'key': 'Escape'}), true);
      expect(s.inputs.length, 2);
      await c.end();
    }),
  );
  test(
    'assignment changes before input release original lease without sending input',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      s.assignment = 'assignment-b';
      expect(await c.input({'type': 'click', 'x': 1, 'y': 1}), false);
      expect(s.inputs, isEmpty);
      expect(s.ends, 1);
      expect(c.lease, isNull);
      final ending = s.requests.firstWhere(
        (r) => r.url.path.endsWith('/takeover/end'),
      );
      expect(jsonDecode(ending.body), {'leaseId': 'lease-original'});
    }),
  );
  test(
    'screen changes during screenshot cannot publish old image or retain control',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      s.intercept = (r) async {
        final response = await s.respond(r);
        if (r.url.path.endsWith('/screenshot')) s.assignment = 'replacement';
        return response;
      };
      await c.refresh();
      expect(c.frame, isNull);
      expect(c.lease, isNull);
      expect(c.canInput, false);
      expect(s.ends, 1);
    }),
  );
  test(
    'account change rejects late screenshot and never releases under new account',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      final started = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/screenshot')) {
          started.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final work = c.refresh();
      await started.future;
      f.session.selectWorkspace(null);
      reply.complete(await s.respond(s.requests.last));
      await work;
      expect(c.frame, isNull);
      expect(c.lease, isNull);
      expect(c.active, false);
      expect(s.ends, 0);
    }),
  );
  test(
    'late start after leaving foreground releases exactly the returned original lease',
    () => scenario((s, c, f) async {
      await c.refresh();
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/takeover/start')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final work = c.start();
      await called.future;
      c.suspend();
      reply.complete(await s.respond(s.requests.last));
      await work;
      expect(s.ends, 1);
      expect(c.lease, isNull);
      expect(c.frame, isNull);
      c.resume();
      expect(c.canInput, false);
    }),
  );
  test(
    'unknown end stays disabled and never automatically repeats even on dispose',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      s.loseEnd = true;
      expect(await c.end(), false);
      expect(c.releaseUnknown, true);
      await c.refresh();
      c.acknowledge();
      await c.end();
      c.suspend();
      expect(c.canInput, false);
      expect(s.ends, 1);
      c.resume();
      s.active = false;
      for (var i = 0; i < 100 && (c.busy || c.lease != null); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(c.lease, isNull);
    }),
  );
  test(
    'returning from background reads a new frame after releasing the old lease',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      final serial = c.frame!.serial;
      c.suspend();
      c.resume();
      for (var i = 0; i < 100 && (c.busy || c.frame == null); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(s.ends, 1);
      expect(s.starts, 1);
      expect(c.lease, isNull);
      expect(c.frame!.serial, greaterThan(serial));
      expect(c.canInput, false);
      expect(s.inputs, isEmpty);
    }),
  );
  test(
    'shared target replacement drops the old frame and lease before input',
    () => scenario((s, c, f) async {
      var revision = '11111111-1111-4111-8111-111111111111';
      s.intercept = (r) async {
        if (r.url.path.endsWith('/status') &&
            !r.url.path.endsWith('/takeover/status')) {
          return jsonResponse({
            'connected': true,
            'surface': 'browser',
            'targetRevision': revision,
            'capabilities': ['private-takeover-frames-v1'],
            'botScreen': {
              'agentId': 'bot-a',
              'status': 'ready',
              'shared': true,
              'lifecycle': {'state': 'ready'},
              'task': {'status': 'idle', 'queued': 0},
            },
          });
        }
        return s.respond(r);
      };
      await c.refresh();
      await c.start();
      expect(c.canInput, true);
      revision = '22222222-2222-4222-8222-222222222222';
      expect(await c.input({'type': 'click', 'x': 400, 'y': 200}), false);
      expect(c.lease, isNull);
      expect(s.ends, 1);
      expect(s.inputs, isEmpty);
    }),
  );
  test(
    'stale frame clicks and invalid local coordinates cannot dispatch',
    () => scenario((s, c, f) async {
      await c.refresh();
      await c.start();
      final serial = c.frame!.serial;
      await c.refresh();
      expect(
        await c.input({'type': 'click', 'x': 1, 'y': 1}, frameSerial: serial),
        false,
      );
      expect(await c.input({'type': 'click', 'x': 800, 'y': 0}), false);
      expect(s.inputs, isEmpty);
      await c.end();
    }),
  );
}
