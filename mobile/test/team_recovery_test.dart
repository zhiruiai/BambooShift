import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/collaboration/team_controller.dart';
import 'package:openbot_mobile/features/collaboration/team_data.dart';
import 'collaboration_support.dart';
import 'support.dart';

void main() {
  test(
    'a remounted lost start checks first and explicitly retries immutable goal with plan ID',
    () async {
      final server = TeamServer()..current = plan(status: 'committed');
      var lose = true;
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/messages') && lose) {
          server.requests.add(r);
          throw http.ClientException('Not yet delivered');
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      await c.conversation(start: true);
      expect(c.pending?['kind'], 'startChat');
      c.dispose();
      final restored = TeamController(f.scope);
      await restored.initialize();
      expect(server.posts.length, 1);
      expect(restored.canRetry, true);
      expect(restored.pending, isNotNull);
      lose = false;
      await restored.retry();
      expect(server.starts, 1);
      expect(restored.pending, isNull);
      expect(server.posts.last.body, server.posts.first.body);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'unknown commit keeps edits until explicit CAS fences the old request',
    () async {
      final server = TeamServer();
      http.Request? late;
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/commit')) {
          late = r;
          server.requests.add(r);
          throw http.ClientException('Delayed request');
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      final edited = copyJson(c.draft!);
      edited['members'][1]['assignment'] = 'Keep this assignment';
      c.update(edited);
      await c.save(commit: true);
      expect(c.pending, isNotNull);
      await c.check();
      expect(c.observed?['revision'], revision1);
      expect(c.editable, false);
      expect(server.posts.length, 1);
      await c.continueEditing();
      expect(c.pending, isNull);
      expect(c.editable, true);
      expect(c.draft!['members'][1]['assignment'], 'Keep this assignment');
      expect(server.posts.last.url.path.endsWith('/revise'), true);
      expect(jsonDecode(server.posts.last.body)['expectedRevision'], revision1);
      final rejected = await server.handle(late!);
      expect(rejected.statusCode, 409);
      expect(server.creations, 0);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'remount with no body displays saved draft before explicitly fencing old commit',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/commit')) {
          server.requests.add(r);
          throw http.ClientException('Lost request');
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      c.update({...c.draft!, 'title': 'Private unsaved title'});
      await c.save(commit: true);
      c.dispose();
      final restored = TeamController(f.scope);
      await restored.initialize();
      expect(restored.draft, isNull);
      expect(restored.observed?['draft']['title'], 'Research team');
      expect(restored.canRetry, false);
      expect(server.posts.length, 1);
      expect(
        f.secrets.values.values.join(),
        isNot(contains('Private unsaved')),
      );
      await restored.continueEditing();
      expect(restored.draft?['title'], 'Research team');
      expect(restored.pending, isNull);
      expect(server.creations, 0);
      expect(server.starts, 0);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'subsequent saved revision is never silently installed over local catalog edits',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.url.path.endsWith('/refresh-bots')) {
          final result = jsonDecode(response.body);
          result['plan'] = <String, dynamic>{
            ...result['plan'],
            'revision': originalRequest,
            'draft': {...draft(), 'title': 'Changed elsewhere'},
          };
          server.current = result['plan'];
          return jsonResponse(result);
        }
        return response;
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      c.update({...c.draft!, 'title': 'Keep local edits'});
      await c.reviewBots();
      await c.acceptReview();
      expect(c.draft?['title'], 'Keep local edits');
      expect(
        c.observed?['draft']['title'],
        'Changed elsewhere',
        reason: c.error,
      );
      expect(c.editable, false);
      expect(c.pending, isNull);
      await c.continueEditing();
      expect(c.draft?['title'], 'Changed elsewhere');
      expect(c.editable, true);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'a metadata-only catalog 404 cannot unlock without a saved-version fence',
    () async {
      final server = TeamServer();
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/refresh-bots')) {
          server.requests.add(r);
          throw http.ClientException('Lost');
        }
        return server.handle(r);
      });
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      await c.reviewBots();
      await c.acceptReview();
      c.dispose();
      final restored = TeamController(f.scope);
      await restored.initialize();
      expect(restored.pending?['kind'], 'catalog');
      expect(restored.observed?['revision'], revision1);
      expect(restored.editable, false);
      expect(restored.canRetry, false);
      expect(server.posts.length, 2);
      await restored.continueEditing();
      expect(server.posts.last.url.path.endsWith('/revise'), true);
      expect(restored.pending, isNull);
      restored.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'new Bot profile, avatar and assignment survive review and unknown recovery',
    () async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      f.scope.data = teamSnapshot();
      final c = TeamController(f.scope);
      await c.initialize(planId);
      final created = {
        ...profile('ignored'),
        'key': 'new-member',
        'kind': 'create',
        'avatarImageId': originalRequest,
        'assignment': 'Precise assignment',
      }..remove('id');
      c.update({
        ...c.draft!,
        'members': [...(c.draft!['members'] as List), created],
      });
      await c.reviewBots();
      await c.acceptReview();
      expect(c.draft!['members'].last, created);
      expect(
        draftProblem(c.draft, f.scope.items('agents'), commit: true),
        isNull,
      );
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'invalid metadata blocks creation without leaking stored text or changing an ID',
    () async {
      final server = TeamServer();
      final f = await fixture(server.handle);
      final c = TeamController(f.scope);
      f.secrets.values[c.recovery.key] = jsonEncode({
        'version': 1,
        'kind': 'start',
        'operationId': originalRequest,
        'requestId': planId,
        'goal': 'not permitted',
      });
      await c.initialize();
      c.changeGoal('New goal');
      await c.start();
      expect(c.blocked, true);
      expect(server.posts, isEmpty);
      expect(server.requests, isEmpty);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
