import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/computer/cloud_computer_controller.dart';
import 'package:openbot_mobile/features/computer/screen_preparation_controller.dart';
import 'computer_support.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Future<void> scenario(
    Future<void> Function(
      ComputerServer,
      ComputerController,
      ScreenPreparationController,
      dynamic,
    )
    run,
  ) async {
    final s = ComputerServer(await computerPng())..assigned = false;
    final f = await fixture(s.handle);
    f.scope.data = s.data;
    final c = ComputerController(f.scope, 'bot-a');
    final p = ScreenPreparationController(c);
    try {
      await run(s, c, p, f);
    } finally {
      p.dispose();
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    }
  }

  test(
    'owner cloud start → explicit screen prepare → preview → takeover uses existing scoped API',
    () => scenario((s, c, p, f) async {
      s.cloudConfigured = true;
      s.available = false;
      final cloud = CloudComputerController(c);
      try {
        await c.refresh();
        await cloud.refresh();
        expect(p.canPrepare, false);
        expect(s.preparations, 0);
        await cloud.start();
        expect(s.cloudStarts, 1);
        expect(s.preparations, 0);
        expect(p.canPrepare, true);
        await p.prepare();
        expect(s.preparations, 1);
        expect(c.frame, isNotNull);
        expect(c.canStart, true);
        await c.start();
        expect(c.canInput, true);
        await p.prepare();
        expect(s.preparations, 1);
        for (final r in s.requests) {
          expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
          expect(r.url.path, startsWith('/api/workspaces/space-a/'));
          expect(r.url.path, isNot(contains('/reset')));
          expect(r.url.path, isNot(contains('/release')));
        }
        await c.end();
      } finally {
        cloud.dispose();
      }
    }),
  );
  test(
    'member, exhausted capacity, active maintenance and unknown takeover do not prepare',
    () => scenario((s, c, p, f) async {
      await c.refresh();
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'member',
      });
      await p.prepare();
      expect(s.preparations, 0);
      f.session.selectWorkspace(<String, dynamic>{
        ...f.session.workspace!,
        'role': 'owner',
      });
      s.configuredScreens = 0;
      await c.refresh();
      await p.prepare();
      expect(s.preparations, 0);
      s.configuredScreens = 1;
      await c.refresh();
      c.unknownStart = true;
      await p.prepare();
      expect(s.preparations, 0);
      c.unknownStart = false;
      c.status!.binding['lifecycle'] = {'state': 'changing'};
      await p.prepare();
      expect(s.preparations, 0);
    }),
  );
  test(
    'pending preparation blocks duplicates and refreshes; 409 preserves error without another POST',
    () => scenario((s, c, p, f) async {
      await c.refresh();
      final called = Completer<void>(), reply = Completer<http.Response>();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/prepare')) {
          called.complete();
          return reply.future;
        }
        return s.respond(r);
      };
      final request = p.prepare();
      await called.future;
      final count = s.requests.length;
      await p.prepare();
      await p.refresh();
      await c.start();
      expect(s.requests.length, count);
      reply.complete(
        jsonResponse({'error': 'Synthetic conflict'}, status: 409),
      );
      await request;
      expect(p.error, 'Synthetic conflict');
      expect(p.unknown, false);
      expect(c.busy, false);
      expect(s.requests.where((r) => r.method == 'POST').length, 1);
    }),
  );
  test(
    'lost receipt recovers assigned screen by GET without repeating preparation',
    () => scenario((s, c, p, f) async {
      await c.refresh();
      s.intercept = (r) async {
        final response = await s.respond(r);
        if (r.url.path.endsWith('/prepare')) {
          throw http.ClientException('lost receipt');
        }
        return response;
      };
      await p.prepare();
      expect(s.preparations, 1);
      expect(p.unknown, false);
      expect(p.error, isNull);
      expect(c.frame, isNotNull);
      await p.prepare();
      expect(s.preparations, 1);
    }),
  );
  test(
    'unconfirmed unassigned result requires separate GET before another explicit attempt',
    () => scenario((s, c, p, f) async {
      await c.refresh();
      s.intercept = (r) async {
        if (r.url.path.endsWith('/prepare')) {
          throw http.ClientException('lost request');
        }
        return s.respond(r);
      };
      await p.prepare();
      expect(p.unknown, true);
      expect(p.canPrepare, false);
      await p.prepare();
      expect(s.requests.where((r) => r.method == 'POST').length, 1);
      await p.refresh();
      expect(p.canPrepare, true);
      s.intercept = null;
      await p.prepare();
      expect(s.requests.where((r) => r.method == 'POST').length, 2);
      expect(c.frame, isNotNull);
    }),
  );
}
