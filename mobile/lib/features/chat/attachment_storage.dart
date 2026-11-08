import 'dart:convert';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'attachment_data.dart';

class AttachmentStorage {
  AttachmentStorage(this.scope, this.conversationId, [String? threadRootId])
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        'attachments:${scope.userId}:${scope.workspaceId}:${chatScopeKey(conversationId, threadRootId)}',
      );
  final WorkspaceController scope;
  final String conversationId, key;
  List<Json> files = [];
  Json? pending;

  Future<void> _read() async {
    scope.guard();
    final raw = await scope.session.api.vault.store.read(key);
    scope.guard();
    if (raw == null) {
      files = [];
      pending = null;
      return;
    }
    if (raw.length > 300000) {
      throw const ApiException('INVALID_PENDING', 'requestUnknown');
    }
    final value = jsonDecode(raw);
    if (value is! Json ||
        value['version'] != 1 ||
        value['files'] is! List ||
        (value['files'] as List).length > attachmentCount) {
      throw const ApiException('INVALID_PENDING', 'requestUnknown');
    }
    final next = (value['files'] as List)
        .map((v) => attachmentFile(v, conversationId))
        .toList();
    if (next.map((f) => f['id']).toSet().length != next.length) {
      throw const ApiException('INVALID_PENDING', 'requestUnknown');
    }
    final p = value['pending'];
    if (p != null &&
        (p is! Json ||
            !isRequestId(p['operationId']) ||
            p['conversationId'] != conversationId ||
            p['userId'] != scope.userId ||
            p['workspaceId'] != scope.workspaceId ||
            p['size'] is! int ||
            p['size'] < 0 ||
            p['size'] > attachmentLimit ||
            p['type'] is! String ||
            p['baseline'] is! List ||
            (p['baseline'] as List).length > 2000 ||
            !(p['baseline'] as List).every(
              (id) => id is String && attachmentId.hasMatch(id),
            ) ||
            p['sha256'] is! String ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(p['sha256']) ||
            p.keys.any(
              (k) => !{
                'operationId',
                'conversationId',
                'userId',
                'workspaceId',
                'name',
                'size',
                'type',
                'baseline',
                'sha256',
              }.contains(k),
            ))) {
      throw const ApiException('INVALID_PENDING', 'requestUnknown');
    }
    if (p != null) attachmentName(p['name']);
    files = next;
    pending = p;
  }

  Future<void> _write(List<Json> next, Json? marker) async {
    scope.guard();
    if (next.isEmpty && marker == null) {
      await scope.session.api.vault.store.delete(key);
    } else {
      await scope.session.api.vault.store.write(
        key,
        jsonEncode({'version': 1, 'files': next, 'pending': marker}),
      );
    }
    scope.guard();
    files = next;
    pending = marker;
  }

  Future<void> load() => scope.session.api.vault.serial(_read);
  Future<void> claim(Json marker) => scope.session.api.vault.serial(() async {
    await _read();
    if (pending != null || files.length >= attachmentCount) {
      throw const ApiException('PENDING', 'mobileFilesUnknown');
    }
    await _write(files, marker);
  });
  Future<void> complete(Json marker, Json file) =>
      scope.session.api.vault.serial(() async {
        await _read();
        if (pending?['operationId'] != marker['operationId']) {
          throw const ApiException('PENDING_CHANGED', 'requestUnknown');
        }
        await _write([
          ...files.where((f) => f['id'] != file['id']),
          file,
        ], null);
      });
  Future<void> abandon(Json marker) => scope.session.api.vault.serial(() async {
    await _read();
    if (pending?['operationId'] != marker['operationId']) {
      throw const ApiException('PENDING_CHANGED', 'requestUnknown');
    }
    await _write(files, null);
  });
  Future<void> remove(Set<String> ids) =>
      scope.session.api.vault.serial(() async {
        await _read();
        await _write(
          files.where((f) => !ids.contains(f['id'])).toList(),
          pending,
        );
      });
}
