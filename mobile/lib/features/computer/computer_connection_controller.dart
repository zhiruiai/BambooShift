import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import 'computer_controller.dart';
import 'computer_data.dart';

String? computerWorkerAddress(String raw) {
  final value = raw.trim();
  final uri = Uri.tryParse(value);
  if (value.length > 2048 ||
      RegExp(r'[?#\s]').hasMatch(value) ||
      uri == null ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      !(uri.scheme == 'https' ||
          (uri.scheme == 'http' &&
              ['localhost', '127.0.0.1', '::1'].contains(uri.host)))) {
    return null;
  }
  return value;
}

Json checkedConnection(Json value) {
  if (value['connected'] is! bool ||
      !['local', 'remote'].contains(value['mode']) ||
      !['browser', 'desktop'].contains(value['surface'])) {
    invalidComputer();
  }
  return value;
}

/// Connection changes share the same exclusion gate as cloud start and takeover.
/// Pairing credentials belong to the form and are never retained here.
class ComputerConnectionController extends ChangeNotifier {
  ComputerConnectionController(this.computer)
    : _workspaceTarget = computerWorkspaceTarget(
        computer.scope.data?['computer'],
      ) {
    computer.addListener(_changed);
    computer.scope.addListener(_changed);
    computer.scope.session.addListener(_changed);
  }
  final ComputerController computer;
  Json? machine;
  String? error;
  bool loading = false, changing = false, _closed = false;
  int _read = 0;
  String? _workspaceTarget;
  bool get active => !_closed && computer.active;
  bool get unknown => computer.connectionUnknownFor('manual');
  bool get canChange =>
      active &&
      computer.scope.owner &&
      computer.canChangeConnection &&
      !loading &&
      !changing &&
      machine != null;
  bool get connected => machine?['connected'] == true;
  String get location => computerExecutionLocation(machine);
  bool get canConnectLocal => canChange && (!connected || location != 'server');
  bool get canReconnect => canChange && machine?['savedRemote'] is Map;
  bool get canSelectDesktop {
    final desktop = computer.status?.value['desktop'];
    return canChange &&
        computer.status?.ready == true &&
        desktop is Map &&
        desktop['available'] == true &&
        desktop['authorized'] == true;
  }

  void _changed() {
    if (_closed) return;
    final next = computerWorkspaceTarget(computer.scope.data?['computer']);
    if (next != _workspaceTarget) {
      _workspaceTarget = next;
      final value = computer.scope.data?['computer'];
      try {
        machine = value is Json ? checkedConnection(value) : null;
      } catch (_) {
        machine = null;
      }
    }
    notifyListeners();
  }

  Future<void> refresh({bool acknowledge = true}) async {
    if (!active || !computer.visible || loading || changing || computer.busy) {
      return;
    }
    final read = ++_read;
    loading = true;
    _changed();
    try {
      final next = checkedConnection(
        await computer.scope.request('GET', '/computer/status'),
      );
      if (!active || !computer.visible || read != _read) return;
      machine = next;
      if (acknowledge) {
        error = null;
        computer.setConnectionUnknown(false);
      }
    } catch (cause) {
      if (active && computer.visible && read == _read) {
        error = cause is ApiException ? cause.message : 'requestFailed';
      }
    } finally {
      if (read == _read) loading = false;
      _changed();
    }
  }

  Future<void> connectLocal() async {
    if (canConnectLocal) await _change('/connect', {'mode': 'local'});
  }

  Future<void> connectRemote(String address, String token) async {
    final url = computerWorkerAddress(address);
    if (!canChange || url == null || token.trim().isEmpty) return;
    await _change('/connect', {'mode': 'remote', 'url': url, 'token': token});
  }

  Future<void> reconnect() async {
    if (canReconnect) await _change('/reconnect', {});
  }

  Future<void> disconnect() async {
    if (canChange && connected) await _change('/disconnect', {});
  }

  Future<void> selectSurface(String surface) async {
    if (!canChange ||
        computer.status?.ready != true ||
        computer.status?.surface == surface ||
        !['browser', 'desktop'].contains(surface) ||
        (surface == 'desktop' && !canSelectDesktop)) {
      return;
    }
    await _change('/bots/${computer.agentId}/surface', {
      'surface': surface,
      'confirm': true,
    });
  }

  Future<void> _change(String path, Json body) async {
    if (!canChange || !computer.beginConnectionChange()) return;
    changing = true;
    _read++;
    error = null;
    _changed();
    bool succeeded = false;
    try {
      final next = checkedConnection(
        await computer.scope.request('POST', '/computer$path', body: body),
      );
      if (!active) return;
      if (!path.contains('/bots/')) machine = next;
      succeeded = true;
    } catch (cause) {
      if (active) {
        error = cause is ApiException ? cause.message : 'requestUnknown';
        computer.setConnectionUnknown(
          !(cause is ApiException &&
              cause.status >= 400 &&
              cause.status < 500 &&
              cause.status != 408),
        );
      }
    } finally {
      changing = false;
      computer.endConnectionChange();
      _changed();
    }
    if (!active || !computer.visible) return;
    if (succeeded) {
      await computer.scope.refresh();
      if (active && computer.visible) await computer.refresh();
    }
    // A lost response is observed, never replayed. Only a user refresh clears it.
    await refresh(acknowledge: false);
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
