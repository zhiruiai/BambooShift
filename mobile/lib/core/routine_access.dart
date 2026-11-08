import 'bot_access.dart';
import 'workspace_controller.dart';

bool routineLocalDirectOwner(
  WorkspaceController scope,
  String agentId,
  Object? conversationId,
) {
  if (!scope.active || !scope.owner || conversationId is! String) return false;
  final agent = scope.find('agents', agentId);
  final chat = scope.find('conversations', conversationId);
  final members = chat?['agentIds'];
  return agent != null &&
      !isManagedBot(agent) &&
      chat?['isGroup'] == false &&
      members is List &&
      members.length == 1 &&
      members.single == agentId;
}

bool routineLocalWebhookOwner(
  WorkspaceController scope,
  String agentId,
  Object? conversationId,
) =>
    conversationId is String &&
    routineLocalDirectOwner(scope, agentId, conversationId) &&
    scope.find('conversations', conversationId)?['demo'] != true;
