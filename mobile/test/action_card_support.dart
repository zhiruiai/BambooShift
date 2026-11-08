import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/chat/action_controller.dart';
import 'package:openbot_mobile/features/chat/action_data.dart';

const actionId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';
const issueReadInput = {
  'method': 'get',
  'owner': 'example',
  'repo': 'research',
  'issue_number': 42,
};

Json exactReadAction({String? usage}) {
  final message = actionMessage(status: usage == null ? 'pending' : 'done');
  final action = message['metadata']['appAction'] as Json;
  action.remove('source');
  action.addAll({
    'appName': 'Example GitHub',
    'toolName': 'issue_read',
    'expiresAt': DateTime.now()
        .add(const Duration(minutes: 5))
        .toIso8601String(),
    'arguments': {...issueReadInput},
    'interactiveApproval': {
      'eligible': usage == null,
      'agentName': 'Research Bot',
      'conversationTitle': 'Synthetic project',
      if (usage != null) ...{'usage': usage, 'ruleId': ruleId},
    },
  });
  return message;
}

Json exactReadRule() => {
  'id': ruleId,
  'agentId': 'bot-a',
  'agentName': 'Research Bot',
  'conversationId': 'chat-a',
  'conversationTitle': 'Synthetic project',
  'connectionId': 'connection-a',
  'connectionName': 'Example GitHub',
  'toolName': 'issue_read',
  'input': issueReadInput,
  'createdAt': '2026-11-07T00:00:00Z',
};

Json actionMessage({
  String kind = 'app',
  String? requester = 'user-a',
  String status = 'pending',
}) {
  final Json action = {
    'id': actionId,
    'agentId': 'bot-a',
    'status': status,
    'createdAt': '2026-11-07T00:00:00Z',
    if (requester != null)
      'requester': {'userId': requester, 'name': 'Synthetic requester'},
    if (kind == 'app') ...{
      'conversationId': 'chat-a',
      'connectionId': 'connection-a',
      'appName': 'Example App',
      'toolName': 'lookup',
      'arguments': {'query': 'synthetic'},
      'source': {
        'kind': 'shared_bot',
        'shareId': 'share-a',
        'botName': 'Shared researcher',
        'ownerName': 'Synthetic publisher',
      },
    } else ...{
      'type': 'browser_click',
      'payload': {'type': 'browser_click', 'selector': '#synthetic'},
      'screenBinding': {
        'screenId': 'screen-a',
        'assignmentRevision': 'revision-a',
      },
    },
  };
  return {
    'id': 'card-a',
    'kind': kind == 'app' ? 'approval' : 'computer',
    'role': 'assistant',
    'agentId': 'bot-a',
    'conversationId': 'chat-a',
    'content': 'Synthetic action',
    'metadata': {kind == 'app' ? 'appAction' : 'action': action},
  };
}

ActionController controller(WorkspaceController scope, Json message) =>
    ActionController(
      scope,
      'card-a',
      'chat-a',
      ChatAction.fromMessage(message)!,
    );
