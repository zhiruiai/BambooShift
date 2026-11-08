import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/routine_access.dart';
import '../../core/workspace_controller.dart';

final _identifier = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
final _secret = RegExp(r'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$');

typedef RoutineWebhookStatus = ({bool enabled, String revision, String? path});

String? routineWebhookPath(WorkspaceController scope, Object? routineId) {
  if (!_identifier.hasMatch(scope.workspaceId) ||
      routineId is! String ||
      !_identifier.hasMatch(routineId)) {
    return null;
  }
  return '/api/routine-webhooks/${scope.workspaceId}/$routineId';
}

bool canManageRoutineWebhook(WorkspaceController scope, Json routine) =>
    routineWebhookPath(scope, routine['id']) != null &&
    routine['agentId'] is String &&
    routineLocalWebhookOwner(
      scope,
      routine['agentId'] as String,
      routine['conversationId'],
    );

({RoutineWebhookStatus status, String? secret}) parseRoutineWebhook(
  Json value,
  String expectedPath, {
  bool? writtenEnabled,
}) {
  final enabled = value['enabled'];
  final revision = value['revision'];
  final path = value['path'];
  final secret = value['secret'];
  final validRevision =
      isRequestId(revision) && (revision as String) == revision.toLowerCase();
  if (enabled is! bool ||
      !(validRevision || (!enabled && revision == 'unset')) ||
      (writtenEnabled != null && writtenEnabled != enabled) ||
      (enabled ? path != expectedPath : path != null) ||
      (writtenEnabled == true
          ? secret is! String || !_secret.hasMatch(secret)
          : secret != null)) {
    throw const ApiException('INVALID_RESPONSE', 'routineWebhookUnknown');
  }
  return (
    status: (
      enabled: enabled,
      revision: revision as String,
      path: path as String?,
    ),
    secret: secret as String?,
  );
}
