import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/sharing_policy_controller.dart';
import 'library_support.dart';
import 'sharing_support.dart';
import 'support.dart';

void main() {
  test(
    'workspace sharing policy uses revision CAS and no invented request field',
    () async {
      final server = SharingServer();
      final f = await fixture(server.handle);
      final c = SharingPolicyController(f.scope);
      await c.initialize();
      c.mode = 'disabled';
      await c.save();
      expect(jsonDecode(server.writes.single.body), {
        'expectedRevision': libraryRevision,
        'mode': 'disabled',
      });
      expect(c.policy?['mode'], 'disabled');
      expect(c.unknown, false);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost policy response is GET-only after remount and explicit acknowledgement',
    () async {
      final server = SharingServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'PUT') throw http.ClientException('Lost');
        return response;
      });
      final c = SharingPolicyController(f.scope);
      await c.initialize();
      c.mode = 'disabled';
      await c.save();
      expect(c.unknown, true);
      c.dispose();
      final recovered = SharingPolicyController(f.scope);
      await recovered.initialize();
      expect(recovered.policy?['mode'], 'disabled');
      expect(recovered.unknown, true);
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
  test('policy storage failure or stale account sends no update', () async {
    final server = SharingServer();
    final f = await fixture(server.handle);
    final c = SharingPolicyController(f.scope);
    await c.initialize();
    c.mode = 'disabled';
    f.secrets.rejectWrites = true;
    await c.save();
    expect(server.writes, isEmpty);
    f.secrets.rejectWrites = false;
    f.session.user = {'id': 'other'};
    await c.save();
    expect(server.writes, isEmpty);
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
}
