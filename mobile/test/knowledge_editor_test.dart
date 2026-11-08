import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor_controller.dart';

import 'support.dart';

const bot = {'id': 'bot-a', 'name': 'Synthetic Bot'};
const memory = {
  'content': 'Synthetic working preference',
  'category': 'preference',
};

void main() {
  test(
    'memory creation and editing use the real Rust methods and actor header',
    () async {
      final writes = <http.Request>[];
      final value = await fixture((request) async {
        if (request.method == 'GET') {
          return jsonResponse(bootstrap(agents: [bot]));
        }
        writes.add(request);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        final body = jsonDecode(request.body) as Json;
        return jsonResponse({...body, 'id': 'memory-a', 'agentId': 'bot-a'});
      });
      value.scope.data = bootstrap(agents: [bot]);
      final create = KnowledgeEditorController(
        value.scope,
        'bot-a',
        'memories',
      );
      await create.initialize();
      expect(await create.save(memory), true);
      expect(writes.single.method, 'POST');
      expect(writes.single.url.path, '/api/workspaces/space-a/memories');
      final edit = KnowledgeEditorController(value.scope, 'bot-a', 'memories');
      await edit.initialize();
      expect(await edit.save(memory, id: 'memory-a'), true);
      expect(writes.last.method, 'PATCH');
      expect(jsonDecode(writes.last.body), memory);
      expect(value.secrets.values, isEmpty);
      create.dispose();
      edit.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test('a new skill is proposed and never auto-approved', () async {
    final paths = <String>[];
    final value = await fixture((request) async {
      if (request.method == 'GET') {
        return jsonResponse(bootstrap(agents: [bot]));
      }
      paths.add(request.url.path);
      return jsonResponse({
        ...jsonDecode(request.body) as Json,
        'id': 'skill-a',
        'status': 'proposed',
        'version': 2,
      });
    });
    value.scope.data = bootstrap(agents: [bot]);
    final model = KnowledgeEditorController(value.scope, 'bot-a', 'skills');
    await model.initialize();
    expect(
      await model.save({
        'name': 'Research',
        'description': '',
        'content': 'Check sources.',
      }),
      true,
    );
    expect(paths, ['/api/workspaces/space-a/skills']);
    expect(model.accepted?['status'], 'proposed');
    model.dispose();
    value.scope.dispose();
    value.session.dispose();
  });

  test(
    'unknown writes persist metadata only; reopening checks without resending',
    () async {
      var posts = 0, reads = 0;
      final value = await fixture((request) async {
        if (request.method == 'GET') {
          reads++;
          return jsonResponse(bootstrap(agents: [bot]));
        }
        posts++;
        throw http.ClientException('Synthetic lost response');
      });
      value.scope.data = bootstrap(agents: [bot]);
      var model = KnowledgeEditorController(value.scope, 'bot-a', 'memories');
      await model.initialize();
      expect(await model.save(memory), false);
      expect(posts, 1);
      expect(
        value.secrets.values.values.single.contains(memory['content']!),
        false,
      );
      model.dispose();
      model = KnowledgeEditorController(value.scope, 'bot-a', 'memories');
      await model.initialize();
      expect(model.pending, isNotNull);
      expect(await model.save(memory), false);
      await model.check();
      expect(reads, 1);
      expect(model.checked, true);
      expect(posts, 1);
      await model.forget();
      expect(value.secrets.values, isEmpty);
      expect(posts, 1);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'two mounted editors cannot dispatch two writes for one knowledge target',
    () async {
      var posts = 0;
      final response = Completer<http.Response>();
      final sent = Completer<void>();
      final value = await fixture((request) async {
        if (request.method == 'GET') {
          return jsonResponse(bootstrap(agents: [bot]));
        }
        posts++;
        sent.complete();
        return response.future;
      });
      value.scope.data = bootstrap(agents: [bot]);
      final first = KnowledgeEditorController(value.scope, 'bot-a', 'memories');
      final second = KnowledgeEditorController(
        value.scope,
        'bot-a',
        'memories',
      );
      await first.initialize();
      await second.initialize();
      final saving = first.save(memory);
      await sent.future;
      expect(await second.save(memory), false);
      expect(second.pending, isNotNull);
      response.complete(
        jsonResponse({...memory, 'id': 'memory-a', 'agentId': 'bot-a'}),
      );
      expect(await saving, true);
      expect(posts, 1);
      first.dispose();
      second.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'members and managed Bots cannot create skills; memory remains workspace-owned',
    () async {
      var writes = 0;
      final value = await fixture((_) async {
        writes++;
        return jsonResponse({});
      });
      value.scope.data = bootstrap(
        agents: [
          {
            ...bot,
            'sharedBot': {'id': 'shared-a'},
          },
        ],
      );
      final shared = KnowledgeEditorController(value.scope, 'bot-a', 'skills');
      await shared.initialize();
      expect(shared.allowed, false);
      expect(await shared.save({'content': 'Do not send'}), false);
      value.scope.data = bootstrap(agents: [bot]);
      value.session.workspaces.first['role'] = 'member';
      expect(shared.allowed, false);
      expect(writes, 0);
      shared.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  test(
    'storage failure blocks dispatch and a late response cannot cross account scope',
    () async {
      var posts = 0;
      final response = Completer<http.Response>();
      final sent = Completer<void>();
      final value = await fixture((_) async {
        posts++;
        sent.complete();
        return response.future;
      });
      value.scope.data = bootstrap(agents: [bot]);
      final model = KnowledgeEditorController(value.scope, 'bot-a', 'memories');
      await model.initialize();
      value.secrets.rejectWrites = true;
      expect(await model.save(memory), false);
      expect(posts, 0);
      value.secrets.rejectWrites = false;
      final saving = model.save(memory);
      await sent.future;
      value.session.user = {'id': 'user-b'};
      response.complete(
        jsonResponse({...memory, 'id': 'memory-a', 'agentId': 'bot-a'}),
      );
      expect(await saving, false);
      expect(model.accepted, isNull);
      expect(posts, 1);
      model.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );
}
