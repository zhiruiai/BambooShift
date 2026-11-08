import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'request_ids.dart';
import 'routine_access.dart';
import 'routine_operation_data.dart';
import 'routine_public_search.dart';
import 'workspace_controller.dart';

class RoutineOperationController extends ChangeNotifier {
  RoutineOperationController(this.scope, this.agentId)
    : _origin = scope.session.api.server!.origin;
  final WorkspaceController scope;
  final String agentId;
  final String _origin;
  Json? _pending, _receipt;
  String? error;
  bool busy = false, ready = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get locked => !ready || busy || _pending != null || !active;
  Json? get pending => _pending == null ? null : cloneRoutineData(_pending!);
  Json? get receipt => _receipt == null ? null : cloneRoutineData(_receipt!);
  String get _purpose =>
      'routine-operation:${scope.userId}:${scope.workspaceId}:$agentId';
  String get _key => scope.session.api.vault.key(_origin, _purpose);
  String get _id => _pending!['body']['requestId'] as String;

  void _guard({bool owner = true}) {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    if (owner && !scope.owner) {
      throw const ApiException('OWNER_REQUIRED', 'readOnly', 403);
    }
  }

  Json _parse(String raw) =>
      parseRoutinePending(raw, scope.userId, scope.workspaceId, agentId);

  Future<void> initialize() async {
    await _work(() async {
      final raw = await scope.session.api.vault.read(_origin, _purpose);
      _guard(owner: false);
      if (raw != null) _pending = _parse(raw);
      ready = true;
    }, owner: false);
    if (active && ready && _pending != null && scope.owner) await check();
  }

  Future<void> create(Json config) async {
    if (locked || !scope.owner) return;
    final submitted = routineConfig(config);
    if (submitted['schedule'] == 'webhook' &&
        !routineLocalWebhookOwner(
          scope,
          agentId,
          submitted['conversationId'],
        )) {
      error = 'routineWebhookTarget';
      notifyListeners();
      return;
    }
    if (submitted.containsKey(routinePublicSearchField)) {
      final queries = normalizeRoutinePublicQueries(
        submitted[routinePublicSearchField],
      );
      if (queries == null ||
          (queries.isNotEmpty &&
              !routineLocalDirectOwner(
                scope,
                agentId,
                submitted['conversationId'],
              ))) {
        error = queries == null
            ? 'routinePublicSearchInvalid'
            : 'routinePublicSearchTarget';
        notifyListeners();
        return;
      }
      submitted[routinePublicSearchField] = queries;
    }
    await _start({'kind': 'create', ...submitted});
  }

  Future<void> run(Json routine) => _start({
    'kind': 'run',
    'routineId': routine['id'],
    'expectedRoutine': routineConfig(routine),
  });

  Future<void> _start(Json fields) async {
    if (locked || !scope.owner) return;
    final candidate = cloneRoutineData({
      'version': 1,
      'userId': scope.userId,
      'workspaceId': scope.workspaceId,
      'agentId': agentId,
      'body': {...fields, 'requestId': requestId()},
    });
    await _work(() async {
      final fresh = await scope.session.api.vault.serial(() async {
        _guard();
        final raw = await scope.session.api.vault.store.read(_key);
        _guard();
        if (raw != null) {
          _pending = _parse(raw);
          return false;
        }
        _parse(jsonEncode(candidate));
        await scope.session.api.vault.store.write(_key, jsonEncode(candidate));
        _guard();
        _pending = candidate;
        return true;
      });
      _guard();
      if (!fresh) {
        error = 'pendingRoutineOperation';
        return;
      }
      _accept(
        await scope.request(
          'POST',
          '/routine-operations',
          body: cloneRoutineData(_pending!['body'] as Json),
        ),
      );
    });
  }

  Future<void> _verifyStored() async {
    final raw = await scope.session.api.vault.read(_origin, _purpose);
    _guard();
    if (raw == null || jsonEncode(_parse(raw)) != jsonEncode(_pending)) {
      throw const ApiException('RECOVERY_CHANGED', 'routineRecoveryChanged');
    }
  }

  Future<void> check() async {
    if (_pending == null) return;
    await _work(() async {
      await _verifyStored();
      _accept(await scope.request('GET', '/routine-operations/$_id'));
    });
  }

  Future<void> cancel() async {
    if (_pending == null) return;
    await _work(() async {
      await _verifyStored();
      final response = await scope.request(
        'POST',
        '/routine-operations/$_id/cancel',
        body: {},
      );
      _guard();
      if (response['status'] == 'not_submitted') {
        if (response['requestId'] != _id ||
            response['userId'] != scope.userId ||
            response['workspaceId'] != scope.workspaceId) {
          throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
        }
        await _clear();
      } else {
        _accept(response);
      }
    });
  }

  Future<bool> finish() async {
    if (_receipt == null) return false;
    await _work(_clear);
    return active && _pending == null;
  }

  void _accept(Json value) {
    _guard();
    validateRoutineReceipt(value, _pending!);
    _receipt = cloneRoutineData(value);
  }

  Future<void> _clear() async {
    final expected = jsonEncode(_pending);
    await scope.session.api.vault.serial(() async {
      _guard();
      final raw = await scope.session.api.vault.store.read(_key);
      _guard();
      if (raw == null || jsonEncode(_parse(raw)) != expected) {
        throw const ApiException('RECOVERY_CHANGED', 'routineRecoveryChanged');
      }
      await scope.session.api.vault.store.delete(_key);
      _guard();
      _pending = null;
      _receipt = null;
      error = null;
    });
  }

  Future<void> _work(
    Future<void> Function() operation, {
    bool owner = true,
  }) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      _guard(owner: owner);
      await operation();
    } catch (e) {
      if (active) {
        if (_pending != null &&
            e is ApiException &&
            [409, 410].contains(e.status) &&
            e.code == 'ROUTINE_OPERATION_CLOSED') {
          try {
            await _clear();
          } catch (_) {
            error = 'routineRecoveryChanged';
          }
        } else {
          error =
              e is ApiException &&
                  e.status == 404 &&
                  e.code == 'ROUTINE_OPERATION_NOT_FOUND'
              ? 'routineNotFoundYet'
              : e is ApiException
              ? routineConfigError(e)
              : 'requestFailed';
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
    super.dispose();
  }
}
