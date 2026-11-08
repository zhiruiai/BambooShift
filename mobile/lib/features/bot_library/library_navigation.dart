import '../../core/api.dart';
import '../../core/app_session.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';

class LibraryOpen {
  const LibraryOpen({
    required this.workspace,
    required this.agentId,
    required this.conversationId,
    this.shareId,
  });
  final Json workspace;
  final String agentId, conversationId;
  final String? shareId;
  bool matches(Json snapshot) {
    final agents = (snapshot['agents'] as List? ?? []).whereType<Json>();
    final bot = agents.where((a) => a['id'] == agentId).firstOrNull;
    final chat = (snapshot['conversations'] as List? ?? [])
        .whereType<Json>()
        .where((c) => c['id'] == conversationId)
        .firstOrNull;
    if (!botAvailable(bot) ||
        chat == null ||
        chat['isGroup'] == true ||
        chat['agentIds'] is! List ||
        (chat['agentIds'] as List).length != 1 ||
        chat['agentIds'][0] != agentId) {
      return false;
    }
    return shareId == null
        ? !isManagedBot(bot!)
        : bot!['sharedBot'] is Json && bot['sharedBot']['shareId'] == shareId;
  }
}

class _PendingOpen {
  _PendingOpen(this.user, this.generation, this.destination);
  final String user;
  final int generation;
  final LibraryOpen destination;
}

final _next = Expando<_PendingOpen>();
void queueLibraryOpen(WorkspaceController scope, LibraryOpen destination) {
  scope.guard();
  _next[scope.session] = _PendingOpen(scope.userId, scope.stamp, destination);
}

LibraryOpen? takeLibraryOpen(WorkspaceController scope) {
  final entry = _next[scope.session];
  _next[scope.session] = null;
  if (!scope.active ||
      entry?.user != scope.userId ||
      entry?.generation != scope.stamp ||
      entry?.destination.workspace['id'] != scope.workspaceId) {
    return null;
  }
  return entry!.destination;
}

void clearLibraryOpen(AppSession session) => _next[session] = null;
