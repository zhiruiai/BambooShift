import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/metadata_operation.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

class MemoryImportController extends ChangeNotifier {
  MemoryImportController(this.scope)
    : ledger = MetadataOperation(scope, 'memory-import');
  final WorkspaceController scope;
  final MetadataOperation ledger;
  Json? readiness, pending, receipt;
  String? error;
  bool busy = false, ready = false, checked = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get allowed =>
      active && scope.owner && scope.session.workspace?['kind'] == 'personal';
  bool get canSubmit =>
      allowed &&
      ready &&
      !busy &&
      pending == null &&
      readiness?['available'] == true;
  void guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  void notify() {
    if (active) notifyListeners();
  }

  Future<void> initialize() async {
    ready = false;
    try {
      final value = await ledger.read();
      guard();
      if (value != null &&
          (!isRequestId(value['requestId']) ||
              value['userId'] != scope.userId ||
              value['workspaceId'] != scope.workspaceId ||
              ![
                'agentId',
                'conversationId',
                'primaryRevision',
              ].every((k) => value[k] is String))) {
        throw const ApiException('INVALID_PENDING', 'requestUnknown');
      }
      pending = value;
      ready = true;
      await refresh();
    } catch (_) {
      if (active) error = 'requestUnknown';
    }
    notify();
  }

  Future<void> refresh() async {
    if (!active || busy) return;
    busy = true;
    checked = false;
    error = null;
    notify();
    try {
      if (pending != null) {
        final value = await scope.request(
          'GET',
          '/memory-imports/${pending!['requestId']}',
        );
        guard();
        accept(value);
      } else {
        final value = await scope.request('GET', '/memory-imports');
        guard();
        if (value['available'] is! bool || value['primary'] is! Json) {
          throw const ApiException('INVALID_RESPONSE', 'requestFailed');
        }
        readiness = value;
      }
      checked = true;
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestUnknown';
        if (pending != null &&
            e is ApiException &&
            e.status == 404 &&
            e.code == 'MEMORY_IMPORT_NOT_FOUND') {
          checked = true;
        }
      }
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  void accept(Json value) {
    final expected = pending!;
    if (![
          'requestId',
          'userId',
          'workspaceId',
          'agentId',
          'conversationId',
          'primaryRevision',
        ].every((key) => value[key] == expected[key]) ||
        value['messageId'] is! String ||
        ![
          'queued',
          'delivered',
          'running',
          'completed',
          'error',
          'cancelled',
          'interrupted',
          'missing',
        ].contains(value['status'])) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    receipt = value;
  }

  Future<bool> submit(String content) async {
    final source = content.trim();
    if (!canSubmit ||
        source.isEmpty ||
        source.length > 16000 ||
        source.contains('\u0000')) {
      return false;
    }
    final primary = readiness!['primary'] as Json;
    if (primary['agentId'] is! String ||
        primary['conversationId'] is! String ||
        primary['revision'] is! String) {
      return false;
    }
    final marker = <String, dynamic>{
      'requestId': requestId(),
      'userId': scope.userId,
      'workspaceId': scope.workspaceId,
      'agentId': primary['agentId'],
      'conversationId': primary['conversationId'],
      'primaryRevision': primary['revision'],
    };
    busy = true;
    checked = false;
    error = null;
    notify();
    try {
      await ledger.claim(marker);
      guard();
      pending = marker;
      if (!allowed) throw const ApiException('FORBIDDEN', 'unavailable');
      final value = await scope.request(
        'POST',
        '/memory-imports',
        body: {
          'requestId': marker['requestId'],
          'expectedPrimaryRevision': marker['primaryRevision'],
          'content': source,
        },
      );
      guard();
      accept(value);
      checked = true;
      await scope.refresh();
      return active;
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestUnknown';
        if (e is ApiException &&
            e.code == 'MEMORY_IMPORT_NOT_STARTED' &&
            [400, 409, 413, 422].contains(e.status) &&
            pending != null) {
          try {
            await ledger.clear(marker);
            guard();
            pending = null;
          } catch (_) {
            error = 'requestUnknown';
          }
        } else if (e is ApiException && e.code == 'PENDING_OPERATION') {
          final saved = await ledger.read();
          guard();
          pending = saved;
        }
      }
      return false;
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<bool> acknowledge({bool abandon = false}) async {
    if (!active ||
        busy ||
        !checked ||
        pending == null ||
        (abandon ? receipt != null : receipt == null)) {
      return false;
    }
    busy = true;
    try {
      await ledger.clear(pending!);
      guard();
      pending = null;
      receipt = null;
      readiness = null;
      checked = false;
      return true;
    } catch (_) {
      if (active) error = 'requestUnknown';
      return false;
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
