import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import 'computer_controller.dart';

class CloudComputerStatus {
  CloudComputerStatus(this.value) {
    if (value['configured'] is! bool ||
        ![
          'unconfigured',
          'running',
          'paused',
          'pausing',
          'unknown',
        ].contains(value['state']) ||
        value['canStart'] is! bool ||
        value['worker'] is! Map ||
        value['worker']['connected'] is! bool ||
        (value['expiresAt'] != null &&
            (value['expiresAt'] is! String ||
                DateTime.tryParse(value['expiresAt']) == null))) {
      throw const ApiException('INVALID_CLOUD', 'mobileCloudInvalid');
    }
  }
  final Json value;
  bool get configured => value['configured'] == true;
  String get state => value['state'] as String;
  bool get connected => value['worker']['connected'] == true;
  bool get canStart => value['canStart'] == true && value['operation'] == null;
  DateTime? get expiresAt =>
      DateTime.tryParse(value['expiresAt'] as String? ?? '');
  String? get error =>
      value['error'] is Map && value['error']['message'] is String
      ? value['error']['message'] as String
      : null;
}

/// Queries never wake a cloud computer. A POST only follows an explicit owner action.
class CloudComputerController extends ChangeNotifier {
  CloudComputerController(this.computer) {
    computer.addListener(_changed);
    computer.scope.addListener(_changed);
    computer.scope.session.addListener(_changed);
  }
  final ComputerController computer;
  CloudComputerStatus? status;
  String? error, actionError;
  bool loading = false, starting = false, unknown = false, _closed = false;
  int _read = 0;
  bool get active => !_closed && computer.active;
  bool get canStart =>
      active &&
      computer.scope.owner &&
      computer.canChangeConnection &&
      !starting &&
      !loading &&
      !unknown &&
      status?.configured == true &&
      status!.canStart;
  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> refresh({bool acknowledge = true}) async {
    if (!active || !computer.visible || loading || starting) return;
    final read = ++_read;
    loading = true;
    _changed();
    try {
      final result = CloudComputerStatus(
        await computer.scope.request('GET', '/cloud-computer'),
      );
      if (!active || read != _read) return;
      status = result;
      error = result.error;
      if (acknowledge &&
          result.state != 'unknown' &&
          result.value['operation'] == null) {
        unknown = false;
      }
    } catch (cause) {
      if (active && read == _read) {
        error = cause is ApiException ? cause.message : 'requestFailed';
      }
    } finally {
      if (read == _read) loading = false;
      _changed();
    }
  }

  Future<void> start() async {
    if (!canStart || !computer.beginConnectionChange()) return;
    starting = true;
    actionError = null;
    unknown = false;
    _changed();
    bool success = false;
    try {
      final result = CloudComputerStatus(
        await computer.scope.request('POST', '/cloud-computer/start', body: {}),
      );
      if (!active) return;
      status = result;
      error = result.error;
      success = true;
    } catch (cause) {
      if (active) {
        actionError = cause is ApiException ? cause.message : 'requestUnknown';
        unknown =
            !(cause is ApiException &&
                cause.status >= 400 &&
                cause.status < 500 &&
                cause.status != 408);
      }
    } finally {
      starting = false;
      computer.endConnectionChange();
      _changed();
    }
    if (!active || !computer.visible) return;
    if (success) {
      await computer.scope.refresh();
      if (active && computer.visible) await computer.refresh();
    } else {
      // Observe a partial outcome once; never replay the lifecycle operation.
      await refresh(acknowledge: false);
    }
  }

  @override
  void dispose() {
    _closed = true;
    _read++;
    computer.removeListener(_changed);
    computer.scope.removeListener(_changed);
    computer.scope.session.removeListener(_changed);
    super.dispose();
  }
}
