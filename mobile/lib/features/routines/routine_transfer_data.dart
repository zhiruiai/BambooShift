import 'dart:convert';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

bool transferId(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{1,160}$').hasMatch(value);

Json? transferDirectChat(WorkspaceController scope, String agentId) {
  final bot = scope.find('agents', agentId);
  if (bot == null || isManagedBot(bot)) return null;
  final chats = scope
      .items('conversations')
      .where(
        (c) =>
            c['isGroup'] == false &&
            c['agentIds'] is List &&
            (c['agentIds'] as List).length == 1 &&
            c['agentIds'][0] == agentId,
      )
      .toList();
  return chats.length == 1 ? chats.single : null;
}

bool canTransferRoutine(WorkspaceController scope, Json routine) =>
    scope.active &&
    scope.owner &&
    scope.session.workspace?['kind'] == 'personal' &&
    transferId(routine['id']) &&
    transferId(routine['agentId']) &&
    transferDirectChat(scope, routine['agentId'])?['id'] ==
        routine['conversationId'];

List<Json> transferTargets(WorkspaceController scope, String sourceAgent) => [
  for (final agent in scope.items('agents'))
    if (agent['id'] != sourceAgent &&
        transferId(agent['id']) &&
        transferDirectChat(scope, agent['id']) != null)
      {'agent': agent, 'conversation': transferDirectChat(scope, agent['id'])},
];

const transferTuple = [
  'sourceAgentId',
  'sourceConversationId',
  'targetAgentId',
  'targetConversationId',
];

String transferStorageKey(WorkspaceController scope) =>
    scope.session.api.vault.key(
      scope.session.api.server!.origin,
      'routine-transfer:${scope.userId}:${scope.workspaceId}',
    );

Future<Json?> readTransferRecovery(WorkspaceController scope) async {
  scope.guard();
  final raw = await scope.session.api.vault.store.read(
    transferStorageKey(scope),
  );
  scope.guard();
  if (raw == null) return null;
  final value = jsonDecode(raw);
  if (value is! Json || !transferId(value['routineId'])) {
    throw const ApiException(
      'INVALID_TRANSFER',
      'mobileWorkspaceTransferInvalid',
    );
  }
  return transferPending(raw, scope, value['routineId']);
}

Json transferPending(String raw, WorkspaceController scope, String routineId) {
  final value = jsonDecode(raw);
  if (value is! Json ||
      value['version'] != 1 ||
      !isRequestId(value['requestId']) ||
      value['userId'] != scope.userId ||
      value['workspaceId'] != scope.workspaceId ||
      value['routineId'] != routineId ||
      !transferTuple.every((f) => transferId(value[f])) ||
      value.keys.any(
        (key) => ![
          'version',
          'requestId',
          'userId',
          'workspaceId',
          'routineId',
          ...transferTuple,
        ].contains(key),
      )) {
    throw const ApiException(
      'INVALID_TRANSFER',
      'mobileWorkspaceTransferInvalid',
    );
  }
  return value;
}

Json checkedTransfer(Json value, Json pending) {
  if (!['transferred', 'missing'].contains(value['status']) ||
      ![
        'requestId',
        'userId',
        'workspaceId',
        'routineId',
        ...transferTuple,
      ].every((f) => value[f] == pending[f]) ||
      value['appliedRevision'] is! String ||
      !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['appliedRevision']) ||
      value['createdAt'] is! String ||
      DateTime.tryParse(value['createdAt']) == null ||
      (value['status'] == 'transferred' &&
          (value['routine'] is! Json ||
              value['routine']['id'] != pending['routineId']))) {
    throw const ApiException(
      'INVALID_TRANSFER',
      'mobileWorkspaceTransferInvalid',
    );
  }
  return value;
}
