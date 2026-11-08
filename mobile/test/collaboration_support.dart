import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/collaboration/team_data.dart';
import 'support.dart';

const planId = '10000000-0000-4000-8000-000000000001';
const revision1 = '10000000-0000-4000-8000-000000000002';
const revision2 = '10000000-0000-4000-8000-000000000003';
const originalRequest = '10000000-0000-4000-8000-000000000004';
Json profile(String id) => {
  'id': id,
  'name': id,
  'role': 'Research',
  'description': 'Public profile',
  'instructions': 'Synthetic instructions',
  'color': '#76568d',
  'avatar': 'orb',
};
Json draft() => {
  'title': 'Research team',
  'summary': 'Research then review',
  'leadKey': 'first',
  'members': [
    {
      'key': 'first',
      'kind': 'reuse',
      'agentId': 'bot-a',
      'assignment': 'Research',
    },
    {
      'key': 'second',
      'kind': 'reuse',
      'agentId': 'bot-b',
      'assignment': 'Review',
    },
  ],
};
Json plan({String status = 'ready', String revision = revision1}) => {
  'id': planId,
  'requestId': originalRequest,
  'revision': revision,
  'goal': 'Synthetic collaboration goal',
  'status': status,
  'draft': draft(),
  if (status == 'committed')
    'result': {
      'conversationId': 'group-a',
      'leadAgentId': 'bot-a',
      'memberAgentIds': ['bot-a', 'bot-b'],
      'createdAgentIds': [],
    },
};
Json teamSnapshot({List<Json> messages = const []}) => {
  ...bootstrap(
    messages: messages,
    agents: [profile('bot-a'), profile('bot-b')],
  ),
  'settings': {'configured': true, 'profileName': 'Synthetic model'},
  'conversations': [
    {
      'id': 'chat-a',
      'title': 'Example',
      'isGroup': false,
      'agentIds': ['bot-a'],
    },
    {
      'id': 'group-a',
      'title': 'Research team',
      'isGroup': true,
      'agentIds': ['bot-a', 'bot-b'],
    },
  ],
};
Json account() => {
  'authenticated': true,
  'user': {'id': 'user-a'},
  'workspaces': [
    {'id': 'space-a', 'role': 'owner', 'status': 'active'},
  ],
};
Json appCard() => {
  'id': 'suggestion-a',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'kind': 'app_connection_proposal',
  'status': 'done',
  'metadata': {
    'appConnectionProposal': {
      'providerId': 'github',
      'reason': 'Review project issues',
      'runId': 'run-a',
      'toolCallId': 'call-a',
      'requester': {'userId': 'user-a', 'messageId': 'input-a'},
    },
  },
};
Json proposalInput() => {
  'id': 'input-a',
  'conversationId': 'chat-a',
  'userId': 'user-a',
  'role': 'user',
  'delivery': {'runId': 'run-a', 'state': 'delivered', 'agentId': 'bot-a'},
};
Json proposal() => {
  'id': 'team-card',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'role': 'assistant',
  'kind': 'text',
  'status': 'done',
  'metadata': {
    'teamProposal': {
      'planId': planId,
      'revision': revision1,
      'status': 'ready',
      'goal': 'Synthetic collaboration goal',
      'title': 'Research team',
      'summary': 'Research then review',
      'leadKey': 'first',
      'members': [
        {
          'key': 'first',
          'kind': 'reuse',
          'agentId': 'bot-a',
          'name': 'bot-a',
          'role': 'Research',
          'assignment': 'Research',
        },
        {
          'key': 'second',
          'kind': 'reuse',
          'agentId': 'bot-b',
          'name': 'bot-b',
          'role': 'Review',
          'assignment': 'Review',
        },
      ],
    },
  },
};

class TeamServer {
  Json current = plan();
  List<Json> messages = [];
  final List<http.Request> requests = [];
  final Map<String, Json> receipts = {};
  int creations = 0, starts = 0;
  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    final path = request.url.path;
    if (path == '/api/account/session') return jsonResponse(account());
    if (path.endsWith('/bootstrap')) {
      return jsonResponse(teamSnapshot(messages: messages));
    }
    if (request.method == 'GET') {
      if (path.endsWith('/catalog-refreshes/missing')) {
        return jsonResponse({'error': 'Missing'}, status: 404);
      }
      if (path.contains('/catalog-refreshes/')) {
        final r = receipts[path.split('/').last];
        return r == null
            ? jsonResponse({'error': 'Missing'}, status: 404)
            : jsonResponse(r);
      }
      if (path.endsWith('/bot-team-plans')) {
        final id = request.url.queryParameters['requestId'];
        return jsonResponse(
          id == null || id == current['requestId'] ? [current] : [],
        );
      }
      return jsonResponse(current);
    }
    final body = jsonDecode(request.body) as Json;
    if (path.endsWith('/bot-team-plans')) {
      current = {
        ...plan(status: 'generating'),
        'requestId': body['requestId'],
        'goal': body['goal'],
      };
      return jsonResponse(current, status: 202);
    }
    if (path.endsWith('/messages')) {
      final exists = messages
          .where((m) => m['delivery']?['clientId'] == body['clientId'])
          .firstOrNull;
      if (exists != null) return jsonResponse({'message': exists});
      starts++;
      final m = <String, dynamic>{
        'id': 'input-start',
        'role': 'user',
        'userId': 'user-a',
        'conversationId': 'group-a',
        'content': body['content'],
        'delivery': {
          'clientId': body['clientId'],
          'agentId': body['agentId'],
          'explicitAgentId': body['agentId'],
        },
      };
      messages.add(m);
      return jsonResponse({'message': m});
    }
    if (path.endsWith('/cancel')) {
      current = {...current, 'status': 'cancelled'};
      return jsonResponse(current);
    }
    if (body['expectedRevision'] != current['revision']) {
      return jsonResponse({'error': 'Changed'}, status: 409);
    }
    if (path.endsWith('/review-bots')) {
      return jsonResponse({
        'planId': planId,
        'expectedRevision': current['revision'],
        'reviewToken': 'review-token',
        'draftDigest': 'digest',
        'members': (body['draft']['members'] as List)
            .where((m) => m['kind'] == 'reuse')
            .map(
              (m) => {
                'key': m['key'],
                'agentId': m['agentId'],
                'state': 'changed',
                'version': 'version',
                'profile': profile(m['agentId']),
              },
            )
            .toList(),
      });
    }
    if (path.endsWith('/commit')) {
      creations++;
      current = {
        ...plan(status: 'committed', revision: revision2),
        'draft': body['draft'],
      };
    } else {
      current = {
        ...current,
        'revision': revision2,
        'draft': copyJson(body['draft']),
      };
    }
    if (path.endsWith('/refresh-bots')) {
      final value = <String, dynamic>{
        'requestId': body['requestId'],
        'planId': planId,
        'appliedRevision': revision2,
        'plan': current,
      };
      receipts[body['requestId']] = value;
      return jsonResponse(value);
    }
    return jsonResponse(current);
  }

  List<http.Request> get posts =>
      requests.where((r) => r.method == 'POST').toList();
}
