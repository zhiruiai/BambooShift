import 'dart:convert';
import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

class TeamPending {
  TeamPending(this.scope)
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        'team-plan:${scope.userId}:${scope.workspaceId}',
      );
  final WorkspaceController scope;
  final String key;
  Json? value;
  Future<void> load() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw == null) {
      value = null;
      return;
    }
    final next = jsonDecode(raw);
    if (next is! Json ||
        next['version'] != 1 ||
        !isRequestId(next['operationId']) ||
        !{
          'start',
          'commit',
          'revise',
          'catalog',
          'cancel',
          'startChat',
        }.contains(next['kind']) ||
        next.keys.any(
          (k) => !{
            'version',
            'operationId',
            'kind',
            'requestId',
            'planId',
            'expectedRevision',
          }.contains(k),
        ) ||
        (next['requestId'] != null && !isRequestId(next['requestId'])) ||
        (next['planId'] != null && !isRequestId(next['planId'])) ||
        (next['expectedRevision'] != null &&
            !isRequestId(next['expectedRevision'])) ||
        (next['kind'] == 'start' && !isRequestId(next['requestId'])) ||
        (next['kind'] != 'start' && !isRequestId(next['planId'])) ||
        ({'commit', 'catalog', 'revise'}.contains(next['kind']) &&
            !isRequestId(next['expectedRevision'])) ||
        ({'commit', 'catalog'}.contains(next['kind']) &&
            !isRequestId(next['requestId']))) {
      throw const ApiException('INVALID_PENDING', 'mobileCollaborationStorage');
    }
    value = next;
  }

  Future<void> claim(Json next, {Json? replacing}) =>
      scope.session.api.vault.serial(() async {
        await load();
        if (value != null &&
            value?['operationId'] != replacing?['operationId']) {
          throw const ApiException('PENDING', 'mobileCollaborationUnknown');
        }
        await scope.session.api.vault.store.write(key, jsonEncode(next));
        scope.guard();
        value = next;
      });
  Future<void> clear(Json expected) => scope.session.api.vault.serial(() async {
    await load();
    if (value?['operationId'] != expected['operationId']) {
      throw const ApiException('PENDING_CHANGED', 'mobileCollaborationStorage');
    }
    await scope.session.api.vault.store.delete(key);
    scope.guard();
    value = null;
  });
}
