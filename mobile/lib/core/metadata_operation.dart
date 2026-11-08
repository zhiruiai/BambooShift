import 'dart:convert';

import 'api.dart';
import 'workspace_controller.dart';

class MetadataOperation {
  MetadataOperation(this.scope, String purpose)
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        '$purpose:${scope.userId}:${scope.workspaceId}',
      );
  final WorkspaceController scope;
  final String key;

  Future<Json?> read() => scope.session.api.vault.serial(() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw == null) return null;
    final value = jsonDecode(raw);
    if (value is! Json) {
      throw const ApiException('INVALID_PENDING', 'requestUnknown');
    }
    return value;
  });

  Future<void> claim(Json metadata) => scope.session.api.vault.serial(() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw != null) {
      throw const ApiException('PENDING_OPERATION', 'requestUnknown');
    }
    await scope.session.api.vault.store.write(key, jsonEncode(metadata));
    scope.guard();
  });

  Future<void> clear(Json expected) => scope.session.api.vault.serial(() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw != jsonEncode(expected)) {
      throw const ApiException('PENDING_CHANGED', 'requestUnknown');
    }
    await scope.session.api.vault.store.delete(key);
    scope.guard();
  });
}
