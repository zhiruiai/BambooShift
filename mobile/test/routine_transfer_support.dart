import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'support.dart';

Json transferRoutine() => {
  'id': 'routine-a',
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'title': 'Synthetic review',
  'prompt': 'Synthetic private reminder',
  'schedule': 'daily:09:30',
  'timeZone': 'Asia/Shanghai',
  'enabled': false,
  'nextRunAt': '2026-11-08T01:30:00Z',
  'lastRunAt': '2026-11-06T01:30:00Z',
};
Json transferData() => {
  ...bootstrap(
    agents: [
      for (final id in ['a', 'b', 'shared', 'duplicate'])
        {
          'id': 'bot-$id',
          'name': 'Bot $id',
          'avatar': 'orb',
          'color': '#76568d',
          if (id == 'shared') 'sharedBot': null,
        },
    ],
  ),
  'conversations': [
    for (final id in ['a', 'b', 'shared', 'duplicate'])
      {
        'id': 'chat-$id',
        'agentIds': ['bot-$id'],
        'title': 'Chat $id',
        'isGroup': false,
      },
    {
      'id': 'chat-duplicate2',
      'agentIds': ['bot-duplicate'],
      'title': 'Other duplicate',
      'isGroup': false,
    },
    {
      'id': 'group',
      'agentIds': ['bot-a', 'bot-b'],
      'title': 'Group',
      'isGroup': true,
    },
  ],
  'routines': [transferRoutine()],
};

class TransferServer {
  Json data = transferData();
  Json? saved;
  bool closed = false;
  final List<http.Request> requests = [];
  Json receipt(Json body, {String status = 'transferred'}) => {
    'requestId': body['requestId'],
    'routineId': 'routine-a',
    'userId': 'user-a',
    'workspaceId': 'space-a',
    'sourceAgentId': 'bot-a',
    'sourceConversationId': 'chat-a',
    'targetAgentId': body['targetAgentId'],
    'targetConversationId': body['targetConversationId'],
    'appliedRevision': 'a' * 64,
    'createdAt': '2026-11-07T00:00:00Z',
    'status': status,
    if (status == 'transferred') 'routine': data['routines'][0],
  };
  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    if (r.url.path.endsWith('/bootstrap')) return jsonResponse(data);
    if (r.url.path.endsWith('/cancel')) {
      if (saved != null) return jsonResponse(saved!);
      closed = true;
      return jsonResponse({
        'status': 'not_transferred',
        'requestId': r.url.path.split('/')[5],
        'userId': 'user-a',
        'workspaceId': 'space-a',
      });
    }
    if (r.method == 'GET') {
      if (saved != null) return jsonResponse(saved!);
      return closed
          ? jsonResponse({
              'code': 'ROUTINE_TRANSFER_CLOSED',
              'error': 'Closed',
            }, status: 410)
          : jsonResponse({'error': 'No receipt'}, status: 404);
    }
    if (closed) {
      return jsonResponse({
        'code': 'ROUTINE_TRANSFER_CLOSED',
        'error': 'Closed',
      }, status: 410);
    }
    final body = jsonDecode(r.body) as Json;
    data['routines'] = [
      {
        ...data['routines'][0] as Json,
        'agentId': body['targetAgentId'],
        'conversationId': body['targetConversationId'],
      },
    ];
    saved = receipt(body);
    return jsonResponse(saved!);
  }

  int get transfers => requests
      .where((r) => r.method == 'POST' && r.url.path.endsWith('/transfer'))
      .length;
}
