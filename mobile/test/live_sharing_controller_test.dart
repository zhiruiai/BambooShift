import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/live_sharing_controller.dart';
import 'library_support.dart';
import 'sharing_support.dart';
import 'support.dart';

void main() {
  test(
    'audience update preserves unavailable grants by omission; no empty grant replacement',
    () async {
      final server = SharingServer();
      final f = await fixture(server.handle);
      final c = LiveSharingController(f.scope, 'bot-a');
      await c.initialize();
      expect(c.selectedFiles.single['status'], 'missing');
      expect(c.selectedApps.single['status'], 'changed');
      expect(server.writes, isEmpty);
      c.chooseAudience('selected');
      c.member('user-b', true);
      await c.save();
      final body = jsonDecode(server.writes.single.body);
      expect(body['expectedRevision'], libraryRevision);
      expect(body['memberIds'], ['user-b']);
      expect(body.containsKey('files'), false);
      expect(body.containsKey('apps'), false);
      expect(c.selectedFiles, hasLength(1));
      expect(c.selectedApps, hasLength(1));
      expect(c.unknown, false);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'file inspection and app tool review produce exact selected revisions; removal is explicit',
    () async {
      final server = SharingServer();
      final f = await fixture(server.handle);
      final c = LiveSharingController(f.scope, 'bot-a');
      await c.initialize();
      c.selectFile(c.files.single, true);
      expect(c.filesChanged, false);
      await c.inspectFile('file-a');
      c.selectFile(c.files.single, true);
      await c.inspectApp(grantAppId);
      expect(c.inspectedApp?['tools'][0]['inputSchema']['type'], 'object');
      expect(c.tools, isEmpty);
      c.selectApp();
      expect(c.appsChanged, false);
      c.tool('lookup', true);
      c.selectApp();
      await c.save();
      final body = jsonDecode(server.writes.single.body);
      expect(body['files'], [
        {'fileId': 'file-a', 'revision': 'b' * 64},
      ]);
      expect(body['apps'], [
        {
          'connectionId': grantAppId,
          'connectionRevision': libraryRevision,
          'tools': [
            {'name': 'lookup', 'revision': 'c' * 64},
          ],
        },
      ]);
      expect(body['apps'][0].containsKey('inputSchema'), false);
      c.selectFile(c.selectedFiles.single, false);
      c.removeApp(grantAppId);
      await c.save();
      final removal = jsonDecode(server.writes.last.body);
      expect(removal['files'], isEmpty);
      expect(removal['apps'], isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost shared update restores GET-only recovery and needs explicit acknowledgement',
    () async {
      final server = SharingServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'PUT') throw http.ClientException('Lost response');
        return response;
      });
      final c = LiveSharingController(f.scope, 'bot-a');
      await c.initialize();
      c.chooseAudience('selected');
      c.member('user-b', true);
      await c.save();
      final marker = f.secrets.values.values.join();
      expect(marker, isNot(contains('Colleague')));
      expect(marker, isNot(contains('Read records')));
      expect(c.unknown, true);
      c.dispose();
      final recovered = LiveSharingController(f.scope, 'bot-a');
      await recovered.initialize();
      expect(recovered.unknown, true);
      expect(recovered.audience, 'selected');
      await recovered.save();
      await recovered.refresh();
      expect(server.writes.length, 1);
      await recovered.acknowledge();
      expect(recovered.unknown, false);
      expect(server.writes.length, 1);
      recovered.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'options failure and account change cannot clear unavailable grants or submit',
    () async {
      final server = SharingServer();
      final f = await fixture(server.handle);
      final c = LiveSharingController(f.scope, 'bot-a');
      await c.initialize();
      server.failOptions = true;
      await c.refresh();
      expect(c.selectedFiles.single['status'], 'missing');
      expect(c.filesChanged, false);
      expect(c.appsChanged, false);
      f.session.user = {'id': 'user-b'};
      await c.save(revoke: true);
      expect(server.writes, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'durable marker precedes shared update; only proven rejection clears it',
    () async {
      for (final mode in ['storage', 'safe', 'refused']) {
        final server = SharingServer();
        final f = await fixture((r) async {
          if (r.method == 'PUT') {
            server.requests.add(r);
            return jsonResponse({
              'error': 'Refused',
              'code': mode == 'safe' ? 'SHARED_BOT_NOT_APPLIED' : 'FORBIDDEN',
            }, status: mode == 'safe' ? 409 : 403);
          }
          return server.handle(r);
        });
        final c = LiveSharingController(f.scope, 'bot-a');
        await c.initialize();
        c.chooseAudience('selected');
        c.member('user-b', true);
        f.secrets.rejectWrites = mode == 'storage';
        await c.save();
        expect(server.writes.length, mode == 'storage' ? 0 : 1);
        expect(c.unknown, mode == 'refused');
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'revoke uses revision and request identity without replaying grants',
    () async {
      final server = SharingServer();
      final f = await fixture(server.handle);
      final c = LiveSharingController(f.scope, 'bot-a');
      await c.initialize();
      await c.save(revoke: true);
      expect(server.writes.single.url.path.endsWith('/revoke'), true);
      final body = jsonDecode(server.writes.single.body);
      expect(body.keys.toSet(), {'expectedRevision', 'requestId'});
      expect(body['expectedRevision'], libraryRevision);
      expect(c.share?['status'], 'revoked');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
