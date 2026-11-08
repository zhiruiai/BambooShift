import 'dart:convert';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

class TeachingPending {
  TeachingPending(this.scope, this.agentId)
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        'teaching:${scope.userId}:${scope.workspaceId}:$agentId',
      );
  final WorkspaceController scope;
  final String agentId, key;
  Json? value;
  Future<void> load() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw == null) {
      value = null;
      return;
    }
    if (utf8.encode(raw).length > 2048) {
      throw const ApiException('INVALID_PENDING', 'mobileTeachingStorage');
    }
    final parsed = jsonDecode(raw);
    if (parsed is! Json ||
        parsed['version'] != 1 ||
        !isRequestId(parsed['id']) ||
        !isRequestId(parsed['operationId']) ||
        parsed['agentId'] != agentId ||
        parsed['userId'] != scope.userId ||
        parsed['workspaceId'] != scope.workspaceId ||
        parsed['conversationId'] is! String ||
        (parsed['conversationId'] as String).isEmpty ||
        (parsed['conversationId'] as String).length > 128 ||
        (parsed['conversationId'] as String).contains('\u0000') ||
        !{
          'idle',
          'start',
          'stop',
          'review',
          'generate',
          'cancel',
        }.contains(parsed['kind']) ||
        (parsed['expectedRevision'] != null &&
            !isRequestId(parsed['expectedRevision'])) ||
        (parsed['requestId'] != null && !isRequestId(parsed['requestId'])) ||
        (parsed['kind'] == 'generate' &&
            (!isRequestId(parsed['requestId']) ||
                !isRequestId(parsed['expectedRevision']))) ||
        (parsed['kind'] == 'review' &&
            !isRequestId(parsed['expectedRevision'])) ||
        parsed.keys.any(
          (k) => !{
            'version',
            'id',
            'operationId',
            'agentId',
            'conversationId',
            'userId',
            'workspaceId',
            'kind',
            'expectedRevision',
            'requestId',
          }.contains(k),
        )) {
      throw const ApiException('INVALID_PENDING', 'mobileTeachingStorage');
    }
    value = parsed;
  }

  Future<void> replace(Json next, Json? expected) =>
      scope.session.api.vault.serial(() async {
        await load();
        if (value?['operationId'] != expected?['operationId']) {
          throw const ApiException(
            'PENDING_CHANGED',
            'mobileTeachingPendingChanged',
          );
        }
        await scope.session.api.vault.store.write(key, jsonEncode(next));
        scope.guard();
        value = next;
      });
  Future<void> clear(Json expected) => scope.session.api.vault.serial(() async {
    await load();
    if (value?['operationId'] != expected['operationId']) {
      throw const ApiException(
        'PENDING_CHANGED',
        'mobileTeachingPendingChanged',
      );
    }
    await scope.session.api.vault.store.delete(key);
    scope.guard();
    value = null;
  });
}
