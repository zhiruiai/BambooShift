import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/library_controller.dart';
import 'package:openbot_mobile/features/bot_library/library_installer.dart';
import 'package:openbot_mobile/features/bot_library/library_transport.dart';
import 'package:openbot_mobile/features/bot_library/library_navigation.dart';
import 'library_support.dart';
import 'support.dart';

void main() {
  test(
    'template preview and explicit import preserve exact revision with paused routines',
    () async {
      final server = LibraryServer();
      final f = await fixture((r) async {
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        return server.handle(r);
      });
      final c = LibraryController(f.scope);
      await c.initialize();
      expect(server.posts, isEmpty);
      await c.preview(c.items.single);
      expect(
        c.selected?['blueprint']['profile']['instructions'],
        'Exact synthetic instructions',
      );
      c.chooseTarget('space-b');
      await c.refresh();
      await c.preview(c.items.single);
      c.name = 'My copy';
      await c.install();
      expect(server.installs, 1);
      final body = jsonDecode(server.posts.single.body);
      expect(body['token'], libraryToken);
      expect(body['expectedRevision'], libraryRevision);
      expect(body['name'], 'My copy');
      expect(body['routineMode'], 'pause');
      expect(
        server.posts.single.url.path,
        '/api/workspaces/space-b/bot-template-imports',
      );
      final target = await c.installer.open();
      expect(target?.workspace['id'], 'space-b');
      expect(target?.conversationId, 'installed-chat');
      expect(f.session.workspaceId, 'space-a');
      expect(f.secrets.values.values.join(), isNot(contains('My copy')));
      await c.installer.finish();
      expect(f.secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost import result restores receipt even when the template was revoked',
    () async {
      final server = LibraryServer();
      final f = await fixture((r) async {
        final result = await server.handle(r);
        if (r.method == 'POST') throw http.ClientException('Lost result');
        return result;
      });
      final transport = LibraryTransport(f.scope);
      final c = LibraryInstaller(transport);
      await c.initialize();
      await c.start(
        kind: 'import',
        workspaceId: 'space-b',
        sourceId: libraryToken,
        expectedRevision: libraryRevision,
        name: 'Private unsaved name',
      );
      expect(c.pending, isNotNull);
      expect(
        f.secrets.values.values.join(),
        isNot(contains('Private unsaved')),
      );
      c.dispose();
      server.revoked = true;
      final recovered = LibraryInstaller(transport);
      await recovered.initialize();
      expect(recovered.receipt?['agentId'], 'installed-bot');
      expect(server.posts.length, 1);
      expect((await recovered.open())?.conversationId, 'installed-chat');
      expect(server.posts.length, 1);
      recovered.dispose();
      transport.close();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    '404 after remount never creates a new import or resends unavailable text',
    () async {
      final server = LibraryServer();
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          server.requests.add(r);
          throw http.ClientException('Not delivered');
        }
        return server.handle(r);
      });
      final t = LibraryTransport(f.scope);
      final c = LibraryInstaller(t);
      await c.initialize();
      await c.start(
        kind: 'import',
        workspaceId: 'space-b',
        sourceId: libraryToken,
        expectedRevision: libraryRevision,
        name: 'A',
      );
      c.dispose();
      final recovered = LibraryInstaller(t);
      await recovered.initialize();
      expect(recovered.pending, isNotNull);
      expect(recovered.canRetry, false);
      await recovered.retry();
      await recovered.start(
        kind: 'import',
        workspaceId: 'space-b',
        sourceId: libraryToken,
        expectedRevision: libraryRevision,
        name: 'B',
      );
      expect(server.posts.length, 1);
      expect(await recovered.finish(), false);
      recovered.dispose();
      t.close();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'shared join targets personal owner only and retries the same share and request after remount',
    () async {
      final server = LibraryServer();
      var lose = true;
      final f = await fixture((r) async {
        if (r.method == 'POST' && lose) {
          server.requests.add(r);
          throw http.ClientException('Lost');
        }
        return server.handle(r);
      });
      final t = LibraryTransport(f.scope);
      final c = LibraryInstaller(t);
      await c.initialize();
      await c.start(
        kind: 'join',
        workspaceId: 'space-a',
        sourceId: libraryShare,
      );
      expect(server.posts, isEmpty);
      await c.start(
        kind: 'join',
        workspaceId: 'space-c',
        sourceId: libraryShare,
      );
      expect(server.posts, isEmpty);
      await c.start(
        kind: 'join',
        workspaceId: 'space-b',
        sourceId: libraryShare,
      );
      final original = server.posts.single.body;
      c.dispose();
      final recovered = LibraryInstaller(t);
      await recovered.initialize();
      expect(recovered.canRetry, true);
      expect(server.posts.length, 1);
      lose = false;
      await recovered.retry();
      expect(server.posts.last.body, original);
      expect(server.installs, 1);
      expect((await recovered.open())?.shareId, libraryShare);
      recovered.dispose();
      t.close();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'only proven not-started unlocks an edit, while generic 403 keeps the original request',
    () async {
      for (final safe in [true, false]) {
        final server = LibraryServer();
        final f = await fixture((r) async {
          if (r.method == 'POST') {
            return jsonResponse({
              'error': 'Synthetic refusal',
              'code': safe ? 'BOT_INSTALL_NOT_STARTED' : 'FORBIDDEN',
            }, status: safe ? 409 : 403);
          }
          return server.handle(r);
        });
        final t = LibraryTransport(f.scope),
            c = LibraryInstaller(LibraryTransport(f.scope));
        await c.initialize();
        await c.start(
          kind: 'import',
          workspaceId: 'space-b',
          sourceId: libraryToken,
          expectedRevision: libraryRevision,
          name: 'A',
        );
        expect(c.pending == null, safe);
        c.dispose();
        c.transport.close();
        t.close();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'storage failure sends zero POST and missing created Bot never navigates or recreates',
    () async {
      final server = LibraryServer();
      final f = await fixture(server.handle);
      final t = LibraryTransport(f.scope);
      final c = LibraryInstaller(t);
      await c.initialize();
      f.secrets.rejectWrites = true;
      await c.start(
        kind: 'join',
        workspaceId: 'space-b',
        sourceId: libraryShare,
      );
      expect(server.posts, isEmpty);
      f.secrets.rejectWrites = false;
      await c.start(
        kind: 'join',
        workspaceId: 'space-b',
        sourceId: libraryShare,
      );
      server.missingBot = true;
      expect(await c.open(), isNull);
      expect(server.installs, 1);
      expect(c.receipt, isNotNull);
      expect(await c.finish(), true);
      c.dispose();
      t.close();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'late gallery and account results cannot replace another selection or account',
    () async {
      final server = LibraryServer(), gate = Completer<http.Response>();
      var delay = false;
      final f = await fixture(
        (r) async => delay && r.url.path == '/api/bot-template-gallery'
            ? gate.future
            : server.handle(r),
      );
      final c = LibraryController(f.scope);
      await c.initialize();
      delay = true;
      final read = c.refresh();
      c.chooseKind('shared');
      await c.refresh();
      expect(c.items.single['id'], libraryShare);
      gate.complete(jsonResponse([]));
      await read;
      expect(c.items.single['id'], libraryShare);
      f.session.user = {'id': 'user-b'};
      await c.install();
      expect(server.posts, isEmpty);
      expect(c.active, false);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'cross-workspace navigation is one-shot and never crosses account generations',
    () async {
      final f = await fixture((_) async => jsonResponse({}));
      final destination = LibraryOpen(
        workspace: {'id': 'space-a'},
        agentId: 'a',
        conversationId: 'c',
      );
      queueLibraryOpen(f.scope, destination);
      expect(takeLibraryOpen(f.scope), same(destination));
      expect(takeLibraryOpen(f.scope), isNull);
      queueLibraryOpen(f.scope, destination);
      f.session.user = {'id': 'user-b'};
      expect(takeLibraryOpen(f.scope), isNull);
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
