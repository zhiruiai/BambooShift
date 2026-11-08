import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/collaboration/proposal_access.dart';
import 'package:openbot_mobile/features/collaboration/team_data.dart';
import 'collaboration_support.dart';
import 'support.dart';

void main() {
  test(
    'app suggestion verifies actual root, owner and local source before returning catalog ID',
    () async {
      final paths = <String>[];
      final f = await fixture((r) async {
        paths.add(r.url.path);
        expect(r.method, 'GET');
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        return jsonResponse(
          r.url.path.endsWith('/session')
              ? account()
              : teamSnapshot(messages: [appCard(), proposalInput()]),
        );
      });
      f.scope.data = teamSnapshot();
      final access = ProposalAccess(f.scope);
      expect((await access.app(appCard()))['providerId'], 'github');
      expect(paths, [
        '/api/account/session',
        '/api/workspaces/space-a/bootstrap',
      ]);
      access.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'a mentioned secondary Bot must match its own run to open an app proposal',
    () async {
      for (final valid in [true, false]) {
        final card = appCard()..['conversationId'] = 'group-a';
        final input = proposalInput()
          ..['conversationId'] = 'group-a'
          ..['mentions'] = {
            'agentIds': ['bot-b', 'bot-a'],
          }
          ..['delivery'] = {
            'agentId': 'bot-b',
            'runId': 'run-b',
            'state': 'delivered',
            'mentionTargets': [
              {'agentId': 'bot-b', 'runId': 'run-b', 'state': 'done'},
              {
                'agentId': 'bot-a',
                'runId': valid ? 'run-a' : 'other-run',
                'state': 'done',
              },
            ],
          };
        final data = teamSnapshot(messages: [card, input]);
        final f = await fixture(
          (r) async =>
              jsonResponse(r.url.path.endsWith('/session') ? account() : data),
        );
        f.scope.data = data;
        final access = ProposalAccess(f.scope);
        if (valid) {
          expect((await access.app(card))['providerId'], 'github');
        } else {
          await expectLater(access.app(card), throwsA(isA<ApiException>()));
        }
        access.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'malformed and fabricated proposal metadata is never an actionable card',
    () {
      expect(appProposal(appCard()), isNotNull);
      expect(teamCard(proposal()), isNotNull);
      for (final mutate in <void Function(Json)>[
        (m) => m['kind'] = 'text',
        (m) => m['role'] = 'user',
        (m) => m['metadata']['appConnectionProposal']['url'] =
            'https://untrusted.example.test',
        (m) =>
            m['metadata']['appConnectionProposal']['providerId'] = 'unlisted',
        (m) => m['metadata']['appConnectionProposal']['reason'] = 'x' * 301,
        (m) =>
            m['metadata']['appConnectionProposal']['requester']['owner'] = true,
        (m) => m['metadata'] = 'not metadata',
      ]) {
        final m = copyJson(appCard());
        mutate(m);
        expect(appProposal(m), isNull);
      }
      expect(teamCard({...proposal(), 'metadata': 'not metadata'}), isNull);
    },
  );
  test(
    'owner B cannot process A; shared, removed and background roots are rejected',
    () async {
      for (final mode in [
        'other',
        'shared',
        'removed',
        'background',
        'changed',
      ]) {
        final message = appCard(),
            data = teamSnapshot(messages: [appCard(), proposalInput()]);
        if (mode == 'other') {
          message['metadata']['appConnectionProposal']['requester']['userId'] =
              'user-b';
        }
        if (mode == 'shared') {
          data['agents'][0]['sharedBot'] = {'status': 'active'};
        }
        if (mode == 'removed') data['messages'] = [];
        if (mode == 'background') {
          data['messages'][1]['metadata'] = {'routineRun': 'routine-a'};
        }
        if (mode == 'changed') {
          data['messages'][0]['metadata']['appConnectionProposal']['providerId'] =
              'linear';
        }
        final f = await fixture(
          (r) async =>
              jsonResponse(r.url.path.endsWith('/session') ? account() : data),
        );
        f.scope.data = teamSnapshot();
        final access = ProposalAccess(f.scope);
        await expectLater(access.app(message), throwsA(isA<ApiException>()));
        access.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'account switch during owner read prevents the old callback from fetching or opening',
    () async {
      final gate = Completer<http.Response>();
      var calls = 0;
      final f = await fixture((_) {
        calls++;
        return gate.future;
      });
      f.scope.data = teamSnapshot();
      final access = ProposalAccess(f.scope);
      final read = access.app(appCard());
      f.session.user = {'id': 'user-b'};
      gate.complete(jsonResponse(account()));
      await expectLater(read, throwsA(isA<ApiException>()));
      expect(calls, 1);
      access.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'current owner may review a member proposal but the source message and Bot must match',
    () async {
      for (final valid in [true, false]) {
        final f = await fixture((r) async {
          if (r.url.path.endsWith('/session')) return jsonResponse(account());
          if (r.url.path.endsWith('/bootstrap')) {
            return jsonResponse(teamSnapshot(messages: [proposal()]));
          }
          return jsonResponse({
            ...plan(),
            'source': {
              'kind': 'conversation',
              'messageId': valid ? 'team-card' : 'other-card',
              'agentId': 'bot-a',
              'conversationId': 'chat-a',
              'userId': 'user-b',
            },
          });
        });
        f.scope.data = teamSnapshot();
        final access = ProposalAccess(f.scope);
        if (valid) {
          expect(await access.team(proposal()), planId);
        } else {
          await expectLater(
            access.team(proposal()),
            throwsA(isA<ApiException>()),
          );
        }
        access.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'team owner may review active shared source but never an unavailable source',
    () async {
      for (final available in [true, false]) {
        final data = teamSnapshot(messages: [proposal()]);
        data['agents'][0]['sharedBot'] = {
          'status': available ? 'active' : 'unavailable',
        };
        final f = await fixture((r) async {
          if (r.url.path.endsWith('/session')) return jsonResponse(account());
          if (r.url.path.endsWith('/bootstrap')) return jsonResponse(data);
          return jsonResponse({
            ...plan(),
            'source': {
              'kind': 'conversation',
              'messageId': 'team-card',
              'agentId': 'bot-a',
              'conversationId': 'chat-a',
              'userId': 'user-b',
            },
          });
        });
        f.scope.data = data;
        final access = ProposalAccess(f.scope);
        expect(teamProposalBot(f.scope, proposal()), available);
        expect(localProposalBot(f.scope, appCard()), false);
        if (available) {
          expect(await access.team(proposal()), planId);
        } else {
          await expectLater(
            access.team(proposal()),
            throwsA(isA<ApiException>()),
          );
        }
        access.dispose();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
}
