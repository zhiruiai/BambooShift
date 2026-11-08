import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/metadata_operation.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

class KnowledgeEditorController extends ChangeNotifier {
  KnowledgeEditorController(this.scope, this.agentId, this.kind)
    : ledger = MetadataOperation(scope, 'knowledge:$agentId:$kind');
  final WorkspaceController scope;
  final String agentId, kind;
  final MetadataOperation ledger;
  Json? pending, accepted;
  String? error;
  bool ready = false, busy = false, checked = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get allowed {
    final bot = scope.find('agents', agentId);
    return active &&
        bot != null &&
        (kind == 'memories' ||
            (kind == 'skills' && scope.owner && !isManagedBot(bot)));
  }

  void notify() {
    if (active) notifyListeners();
  }

  void guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<void> initialize() async {
    ready = false;
    try {
      final value = await ledger.read();
      guard();
      if (value != null &&
          (!isRequestId(value['operationId']) ||
              value['agentId'] != agentId ||
              value['kind'] != kind ||
              !['create', 'edit'].contains(value['action']) ||
              (value['id'] != null && value['id'] is! String))) {
        throw const ApiException('INVALID_PENDING', 'requestUnknown');
      }
      pending = value;
      ready = true;
    } catch (e) {
      if (active) error = 'requestUnknown';
    }
    notify();
  }

  Future<bool> save(Json fields, {String? id}) async {
    if (!ready || busy || pending != null || !allowed) return false;
    if (id != null && kind != 'memories') return false;
    busy = true;
    error = null;
    checked = false;
    final marker = <String, dynamic>{
      'operationId': requestId(),
      'agentId': agentId,
      'kind': kind,
      'action': id == null ? 'create' : 'edit',
      'id': id,
    };
    notify();
    try {
      await ledger.claim(marker);
      guard();
      pending = marker;
      if (!allowed) throw const ApiException('FORBIDDEN', 'unavailable');
      final value = await scope.request(
        id == null ? 'POST' : 'PATCH',
        '/$kind${id == null ? '' : '/$id'}',
        body: {...fields, if (id == null) 'agentId': agentId},
      );
      guard();
      if (value['agentId'] != agentId ||
          value['id'] is! String ||
          (id != null && value['id'] != id) ||
          (kind == 'skills' && value['status'] != 'proposed')) {
        throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
      }
      accepted = value;
      await ledger.clear(marker);
      guard();
      pending = null;
      await scope.refresh();
      return active;
    } catch (e) {
      if (active) {
        if (e is ApiException && e.code == 'PENDING_OPERATION') {
          await initialize();
        }
        error = e is ApiException ? e.message : 'requestUnknown';
      }
      return false;
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<void> check() async {
    if (!active || busy || pending == null) return;
    busy = true;
    checked = false;
    notify();
    try {
      await scope.refresh();
      guard();
      if (scope.error != null) {
        throw const ApiException('READ_FAILED', 'requestFailed');
      }
      checked = true;
      error = null;
    } catch (e) {
      if (active) error = 'requestUnknown';
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<void> forget() async {
    if (!active || busy || !checked || pending == null) return;
    busy = true;
    final marker = pending!;
    try {
      await ledger.clear(marker);
      guard();
      pending = null;
      accepted = null;
      checked = false;
      error = null;
    } catch (_) {
      if (active) error = 'requestUnknown';
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
