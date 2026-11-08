import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/metadata_operation.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'roster_data.dart';

class RosterController extends ChangeNotifier {
  RosterController(this.scope) : ledger = MetadataOperation(scope, 'roster');
  final WorkspaceController scope;
  final MetadataOperation ledger;
  Json? state, pending;
  String? error;
  bool ready = false, busy = false, checked = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get editable => active && ready && !busy && pending == null;

  void _notify() {
    if (active) notifyListeners();
  }

  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<void> initialize() async {
    if (busy) return;
    busy = true;
    ready = false;
    _notify();
    try {
      pending = await ledger.read();
      _guard();
      if (pending != null &&
          (!isRequestId(pending!['operationId']) ||
              pending!['expectedRevision'] is! String ||
              pending!['type'] is! String)) {
        throw const ApiException('INVALID_PENDING', 'requestUnknown');
      }
      await _read();
      ready = true;
      checked = pending != null;
      error = null;
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> _read() async {
    final next = readRoster(await scope.request('GET', '/sidebar-roster'));
    _guard();
    state = next;
  }

  Future<bool> update(Json operation) async {
    if (!editable || state == null) return false;
    final frozen = jsonDecode(jsonEncode(operation)) as Json;
    busy = true;
    checked = false;
    error = null;
    final marker = <String, dynamic>{
      'operationId': requestId(),
      'expectedRevision': state!['revision'],
      'type': frozen['type'],
    };
    _notify();
    try {
      await ledger.claim(marker);
      _guard();
      pending = marker;
      final next = readRoster(
        await scope.request(
          'PUT',
          '/sidebar-roster',
          body: {
            'expectedRevision': marker['expectedRevision'],
            'operation': frozen,
          },
        ),
      );
      _guard();
      if (next['revision'] == marker['expectedRevision']) {
        throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
      }
      state = next;
      await ledger.clear(marker);
      _guard();
      pending = null;
      await scope.refresh();
      return active;
    } catch (e) {
      if (active) {
        if (e is ApiException && e.code == 'PENDING_OPERATION') {
          try {
            pending = await ledger.read();
          } catch (_) {
            ready = false;
          }
        }
        error = 'mobileRosterUnknown';
      }
      return false;
    } finally {
      if (active) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> check() async {
    if (!active || busy || pending == null) return;
    busy = true;
    checked = false;
    _notify();
    try {
      await _read();
      await scope.refresh();
      _guard();
      if (scope.error != null) {
        throw const ApiException('READ_FAILED', 'requestFailed');
      }
      checked = true;
      error = null;
    } catch (_) {
      if (active) error = 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> acknowledge() async {
    if (!active || busy || pending == null || !checked) return;
    busy = true;
    _notify();
    try {
      await ledger.clear(pending!);
      _guard();
      pending = null;
      error = null;
      checked = false;
    } catch (_) {
      if (active) error = 'requestUnknown';
    } finally {
      if (active) {
        busy = false;
        _notify();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
