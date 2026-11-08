import 'package:openbot_mobile/core/api.dart';

Json routineConfigFixture() => {
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'title': 'Synthetic review',
  'prompt': 'Only synthetic information.',
  'schedule': 'daily:09:00',
  'timeZone': 'America/New_York',
  'enabled': true,
};
Json routineFixture() => {
  ...routineConfigFixture(),
  'id': 'routine-a',
  'nextRunAt': '2026-11-07T14:00:00Z',
  'lastRunAt': '2026-11-06T14:00:00Z',
};
Json operationReceipt(Json body, {String? status}) {
  final create = body['kind'] == 'create';
  return {
    'kind': body['kind'],
    'requestId': body['requestId'],
    'status': status ?? (create ? 'created' : 'submitted'),
    'routineId': create ? 'created-routine' : body['routineId'],
    'agentId': 'bot-a',
    'conversationId': 'chat-a',
    'userId': 'user-a',
    'workspaceId': 'space-a',
    'createdAt': '2026-11-06T14:00:00Z',
    if (!create) ...{
      'messageId': 'message-a',
      'nextRunAt': '2026-11-07T14:00:00Z',
    },
  };
}
