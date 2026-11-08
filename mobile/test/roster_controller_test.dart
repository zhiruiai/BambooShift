import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/roster/roster_controller.dart';

import 'roster_projection_test.dart' show roster;
import 'support.dart';

void main() {
  test(
    'members organize only their own actor list using Rust revision CAS',
    () async {
      final writes = <Json>[];
      var state = roster();
      final value = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(bootstrap());
        }
        if (request.method == 'GET') return jsonResponse(state);
        expect(request.method, 'PUT');
        expect(request.url.path, '/api/workspaces/space-a/sidebar-roster');
        writes.add(jsonDecode(request.body) as Json);
        state = roster(revision: 'revision-b');
        return jsonResponse(state);
      });
      value.session.workspaces.first['role'] = 'member';
      final model = RosterController(value.scope);
      await model.initialize();
      expect(
        await model.update({
          'type': 'create-section',
          'name': 'Private section',
        }),
        true,
      );
      expect(writes.single, {
        'expectedRevision': 'revision-a',
        'operation': {'type': 'create-section', 'name': 'Private section'},
      });
      expect(model.state?['revision'], 'revision-b');
      expect(value.secrets.values, isEmpty);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'lost writes reopen read-only without persisting names or repeating PUT',
    () async {
      var writes = 0;
      final value = await fixture((request) async {
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(bootstrap());
        }
        if (request.method == 'GET') {
          return jsonResponse(roster(revision: 'revision-b'));
        }
        writes++;
        throw http.ClientException('Synthetic lost reply');
      });
      var model = RosterController(value.scope);
      await model.initialize();
      expect(
        await model.update({
          'type': 'create-section',
          'name': 'Never persist this title',
        }),
        false,
      );
      expect(
        value.secrets.values.values.single,
        isNot(contains('Never persist')),
      );
      model.dispose();
      model = RosterController(value.scope);
      await model.initialize();
      expect(model.pending, isNotNull);
      expect(model.checked, true);
      expect(
        await model.update({'type': 'create-section', 'name': 'Do not send'}),
        false,
      );
      await model.check();
      await model.acknowledge();
      expect(model.pending, isNull);
      expect(model.state?['revision'], 'revision-b');
      expect(writes, 1);
      expect(value.secrets.values, isEmpty);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'post-commit error and revision conflict retain local recovery',
    () async {
      for (final status in [403, 409, 500]) {
        final value = await fixture(
          (request) async => request.method == 'GET'
              ? jsonResponse(roster())
              : jsonResponse({'error': 'Synthetic error'}, status: status),
        );
        final model = RosterController(value.scope);
        await model.initialize();
        expect(
          await model.update({'type': 'create-section', 'name': 'Section'}),
          false,
        );
        expect(model.pending, isNotNull);
        expect(model.editable, false);
        expect(value.secrets.values.length, 1);
        model.dispose();
        value.scope.dispose();
        value.session.dispose();
      }
    },
  );

  test('two mounted managers cannot dispatch duplicate mutations', () async {
    final reply = Completer<http.Response>(), sent = Completer<void>();
    var writes = 0;
    final value = await fixture((request) async {
      if (request.method == 'GET') return jsonResponse(roster());
      writes++;
      sent.complete();
      return reply.future;
    });
    final first = RosterController(value.scope),
        second = RosterController(value.scope);
    await first.initialize();
    await second.initialize();
    final saving = first.update({'type': 'create-section', 'name': 'First'});
    await sent.future;
    expect(
      await second.update({'type': 'create-section', 'name': 'Second'}),
      false,
    );
    expect(second.pending, isNotNull);
    reply.complete(
      jsonResponse({'error': 'Synthetic lost reply'}, status: 500),
    );
    await saving;
    expect(writes, 1);
    first.dispose();
    second.dispose();
    value.scope.dispose();
    value.session.dispose();
  });

  test(
    'storage failure prevents dispatch and mutable caller state is frozen',
    () async {
      Json? body;
      final value = await fixture((request) async {
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(bootstrap());
        }
        if (request.method == 'GET') return jsonResponse(roster());
        body = jsonDecode(request.body) as Json;
        return jsonResponse(roster(revision: 'revision-b'));
      });
      final model = RosterController(value.scope);
      await model.initialize();
      value.secrets.rejectWrites = true;
      expect(
        await model.update({'type': 'create-section', 'name': 'First'}),
        false,
      );
      expect(body, isNull);
      value.secrets.rejectWrites = false;
      final op = <String, dynamic>{'type': 'create-section', 'name': 'Frozen'};
      final saving = model.update(op);
      op['name'] = 'Changed after click';
      expect(await saving, true);
      expect(body?['operation']['name'], 'Frozen');
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'late responses never update another account or clear its marker',
    () async {
      final reply = Completer<http.Response>(), sent = Completer<void>();
      final value = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(roster());
        sent.complete();
        return reply.future;
      });
      final model = RosterController(value.scope);
      await model.initialize();
      final saving = model.update({'type': 'create-section', 'name': 'Scoped'});
      await sent.future;
      value.session.user = {'id': 'user-b'};
      reply.complete(jsonResponse(roster(revision: 'revision-b')));
      expect(await saving, false);
      expect(model.state?['revision'], 'revision-a');
      expect(value.secrets.values.length, 1);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );
}
