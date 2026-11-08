import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/collaboration/team_controller.dart';
import 'package:openbot_mobile/features/collaboration/team_data.dart';
import 'collaboration_support.dart';
import 'support.dart';

void main() {
  test(
    'plan edits and commit are distinct from explicit idempotent start',
    () async {
      final server = TeamServer();
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.url.path.startsWith('/api/workspaces/space-a/'), true);
        return server.handle(request);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      expect(c.editable, true);
      expect(server.posts, isEmpty);
      c.update({...c.draft!, 'title': 'Edited team'});
      await c.save();
      expect(c.draft?['title'], 'Edited team');
      expect(c.plan?['revision'], revision2);
      expect(server.creations, 0);
      expect(server.starts, 0);
      await c.save(commit: true);
      expect(server.creations, 1);
      expect(server.starts, 0);
      expect(c.plan?['status'], 'committed');
      expect(await c.conversation(), 'group-a');
      expect(server.starts, 0);
      expect(await c.conversation(start: true), 'group-a');
      expect(await c.conversation(start: true), 'group-a');
      expect(server.starts, 1);
      final sent = jsonDecode(server.posts.last.body);
      expect(sent, {
        'clientId': planId,
        'content': 'Synthetic collaboration goal',
        'agentId': 'bot-a',
        'mode': 'followUp',
      });
      expect(f.secrets.values, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost start persists only metadata and explicit retry keeps the same ID and body',
    () async {
      final server = TeamServer();
      var lose = true;
      final f = await fixture((r) async {
        final result = await server.handle(r);
        if (r.method == 'POST' && lose) {
          throw http.ClientException('Synthetic lost response');
        }
        return result;
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize();
      c.changeGoal('Never store this private goal');
      await c.start();
      expect(c.pending?['kind'], 'start');
      expect(c.canRetry, true);
      expect(f.secrets.values.values.join(), isNot(contains('Never store')));
      await c.start();
      expect(server.posts.length, 1);
      lose = false;
      await c.retry();
      expect(server.posts.length, 2);
      expect(server.posts[1].body, server.posts[0].body);
      expect(c.pending, isNull);
      expect(c.plan?['status'], 'generating');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'remount reads a committed result without replaying or starting work',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'POST') {
          return jsonResponse({
            'error': 'Synthetic final authorization failure',
          }, status: 403);
        }
        return response;
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      await c.save(commit: true);
      expect(c.pending, isNotNull);
      c.dispose();
      final restored = TeamController(f.scope);
      await restored.initialize();
      expect(restored.plan?['status'], 'committed');
      expect(restored.pending, isNull);
      expect(server.posts.length, 1);
      expect(server.starts, 0);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'missing start remains locked after remount and never invents another request',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        if (r.method == 'POST') {
          server.requests.add(r);
          throw http.ClientException('Lost before delivery');
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize();
      c.changeGoal('Private goal');
      await c.start();
      c.dispose();
      final restored = TeamController(f.scope);
      await restored.initialize();
      expect(restored.pending, isNotNull);
      expect(restored.canRetry, false);
      expect(restored.goal, isEmpty);
      await restored.start();
      await restored.retry();
      await restored.check();
      expect(server.posts.length, 1);
      expect(restored.pending, isNotNull);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'storage refusal sends zero POST and account change discards a late read',
    () async {
      final server = TeamServer();
      final gate = Completer<http.Response>();
      var hold = false;
      final f = await fixture(
        (r) async => hold ? gate.future : server.handle(r),
      );
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize();
      f.secrets.rejectWrites = true;
      c.changeGoal('Private goal');
      await c.start();
      expect(server.posts, isEmpty);
      hold = true;
      final pending = c.load(planId);
      f.session.user = {'id': 'user-b'};
      f.session.notifyListeners();
      gate.complete(jsonResponse(plan()));
      await pending;
      expect(c.active, false);
      expect(c.plan, isNull);
      expect(c.draft, isNull);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'members never call planner endpoints and missing groups cannot be started',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/bootstrap')) {
          return jsonResponse({'conversations': [], 'agents': []});
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      f.session.workspace!['role'] = 'member';
      final member = TeamController(f.scope);
      await member.initialize();
      await member.start();
      expect(server.requests, isEmpty);
      member.dispose();
      f.session.workspace!['role'] = 'owner';
      server.current = plan(status: 'committed');
      final c = TeamController(f.scope);
      await c.initialize(planId);
      expect(await c.conversation(start: true), isNull);
      expect(server.posts, isEmpty);
      expect(c.error, 'unavailable');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'read-only profile review is invalidated by draft edits; accepted review preserves all fields',
    () async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      await c.reviewBots();
      expect(c.review, isNotNull);
      expect(server.current['revision'], revision1);
      final next = copyJson(c.draft!);
      next['members'][0]['assignment'] = 'Explicit new assignment';
      c.update(next);
      expect(c.review, isNull);
      await c.acceptReview();
      expect(server.posts.length, 1);
      await c.reviewBots();
      await c.acceptReview();
      expect(c.draft!['members'][0]['assignment'], 'Explicit new assignment');
      expect(c.plan!['revision'], revision2);
      expect(server.creations, 0);
      expect(server.starts, 0);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
