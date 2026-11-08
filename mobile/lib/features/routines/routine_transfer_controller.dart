import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/routine_operation_data.dart';
import '../../core/workspace_controller.dart';
import 'routine_transfer_data.dart';

class RoutineTransferController extends ChangeNotifier {
  RoutineTransferController(this.scope, this.routineId)
    : _key = transferStorageKey(scope) {
    scope.session.addListener(_identityChanged);
  }
  final WorkspaceController scope;
  final String routineId, _key;
  Json? pending, receipt;
  String? error, notice;
  bool busy = false, ready = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get locked => !active || !ready || busy || pending != null;
  void _identityChanged() {
    if (!_closed) {
      if (!active) receipt = null;
      notifyListeners();
    }
  }

  void _guard({bool owner = false}) {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    if (owner && !scope.owner) {
      throw const ApiException('OWNER_REQUIRED', 'readOnly', 403);
    }
  }

  Json _parse(String raw) => transferPending(raw, scope, routineId);

  Future<void> initialize() async {
    await _work(() async {
      final raw = await scope.session.api.vault.store.read(_key);
      _guard();
      if (raw != null) pending = _parse(raw);
      ready = true;
    });
    if (active && ready && pending != null) await check();
  }

  Future<void> start(Json reviewed, Json target) async {
    if (locked || !canTransferRoutine(scope, reviewed)) return;
    final current = scope.find('routines', routineId);
    if (current == null ||
        reviewed['id'] != routineId ||
        !sameRoutineConfig(current, reviewed)) {
      error = 'mobileWorkspaceTransferChanged';
      notifyListeners();
      return;
    }
    final agent = target['agent'], chat = target['conversation'];
    if (agent is! Json ||
        chat is! Json ||
        agent['id'] == reviewed['agentId'] ||
        !transferId(agent['id']) ||
        transferDirectChat(scope, agent['id'])?['id'] != chat['id']) {
      return;
    }
    final record = <String, dynamic>{
      'version': 1,
      'requestId': requestId(),
      'routineId': routineId,
      'userId': scope.userId,
      'workspaceId': scope.workspaceId,
      'sourceAgentId': reviewed['agentId'],
      'sourceConversationId': reviewed['conversationId'],
      'targetAgentId': agent['id'],
      'targetConversationId': chat['id'],
    };
    final body = cloneRoutineData({
      'requestId': record['requestId'],
      'expectedRoutine': routineConfig(reviewed),
      'targetAgentId': agent['id'],
      'targetConversationId': chat['id'],
    });
    await _work(() async {
      final fresh = await scope.session.api.vault.serial(() async {
        _guard(owner: true);
        final raw = await scope.session.api.vault.store.read(_key);
        _guard(owner: true);
        if (raw != null) {
          pending = _parse(raw);
          return false;
        }
        _parse(jsonEncode(record));
        await scope.session.api.vault.store.write(_key, jsonEncode(record));
        _guard(owner: true);
        pending = record;
        return true;
      });
      _guard(owner: true);
      if (!fresh) return;
      _accept(
        await scope.request(
          'POST',
          '/routines/$routineId/transfer',
          body: body,
        ),
      );
      await scope.refresh();
    });
  }

  Future<void> _verify() async {
    final raw = await scope.session.api.vault.store.read(_key);
    _guard();
    if (raw == null || jsonEncode(_parse(raw)) != jsonEncode(pending)) {
      throw const ApiException(
        'TRANSFER_CHANGED',
        'mobileWorkspaceTransferRecoveryChanged',
      );
    }
  }

  void _accept(Json value) {
    _guard();
    receipt = cloneRoutineData(checkedTransfer(value, pending!));
  }

  Future<void> check() async {
    if (pending == null) return;
    await _work(() async {
      await _verify();
      _accept(
        await scope.request(
          'GET',
          '/routine-transfers/${pending!['requestId']}',
        ),
      );
      await scope.refresh();
    });
  }

  Future<void> cancel() async {
    if (pending == null || !scope.owner) return;
    await _work(() async {
      await _verify();
      _guard(owner: true);
      final value = await scope.request(
        'POST',
        '/routine-transfers/${pending!['requestId']}/cancel',
        body: {},
      );
      _guard();
      if (value['status'] == 'not_transferred') {
        if (![
          'requestId',
          'userId',
          'workspaceId',
        ].every((key) => value[key] == pending![key])) {
          throw const ApiException(
            'INVALID_TRANSFER',
            'mobileWorkspaceTransferInvalid',
          );
        }
        await _clear();
        notice = 'mobileWorkspaceTransferClosed';
      } else {
        _accept(value);
        await scope.refresh();
      }
    });
  }

  Future<void> _clear() async {
    final expected = jsonEncode(pending);
    await scope.session.api.vault.serial(() async {
      _guard();
      final raw = await scope.session.api.vault.store.read(_key);
      _guard();
      if (raw == null || jsonEncode(_parse(raw)) != expected) {
        throw const ApiException(
          'TRANSFER_CHANGED',
          'mobileWorkspaceTransferRecoveryChanged',
        );
      }
      await scope.session.api.vault.store.delete(_key);
      _guard();
      pending = null;
      receipt = null;
    });
  }

  Future<bool> finish() async {
    if (receipt == null) return false;
    await _work(_clear);
    return active && pending == null;
  }

  Future<void> _work(Future<void> Function() task) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      _guard();
      await task();
    } catch (e) {
      if (active) {
        if (pending != null &&
            e is ApiException &&
            e.status == 410 &&
            e.code == 'ROUTINE_TRANSFER_CLOSED') {
          try {
            await _clear();
            notice = 'mobileWorkspaceTransferClosed';
          } catch (_) {
            error = 'mobileWorkspaceTransferRecoveryChanged';
          }
        } else {
          error = e is ApiException && e.status == 404
              ? 'mobileWorkspaceTransferNotFound'
              : e is ApiException
              ? e.message
              : 'requestUnknown';
        }
      }
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    scope.session.removeListener(_identityChanged);
    super.dispose();
  }
}
