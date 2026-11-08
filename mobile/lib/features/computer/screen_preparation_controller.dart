import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import 'computer_controller.dart';
import 'computer_data.dart';

class ScreenPreparationController extends ChangeNotifier {
  ScreenPreparationController(this.computer) {
    computer.addListener(_changed);
    computer.scope.addListener(_changed);
    computer.scope.session.addListener(_changed);
  }
  final ComputerController computer;
  bool preparing = false,
      unknown = false,
      _closed = false,
      _retryVerified = false;
  String? error;
  bool get active => !_closed && computer.active;
  bool get hasCapacity {
    final capacity = computer.capacity;
    final ready = capacity?['ready'],
        configured = capacity?['configured'],
        assigned = capacity?['assigned'];
    return ready is int &&
        configured is int &&
        assigned is int &&
        ready > 0 &&
        configured > 0 &&
        assigned >= 0 &&
        assigned < configured;
  }

  bool get canPrepare =>
      active &&
      computer.scope.owner &&
      computer.canChangeConnection &&
      computer.error == null &&
      !preparing &&
      (!unknown || _retryVerified) &&
      hasCapacity &&
      computer.status?.status == 'unassigned' &&
      ![
        'running',
        'waiting_cleanup',
        'maintenance',
      ].contains(computer.status?.binding['task']?['status']) &&
      computer.status?.binding['lifecycle']?['state'] == 'ready';
  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> refresh({bool verifyRetry = true}) async {
    if (!active || !computer.visible || preparing || computer.busy) return;
    await computer.refresh();
    if (!active) return;
    // An unassigned read never proves a timed-out request did not run. Only a
    // separate user refresh may unlock an explicitly confirmed retry; the API
    // returns an existing binding instead of allocating this Bot a second one.
    if (computer.status?.ready == true) {
      if (unknown) error = null;
      unknown = false;
    }
    if (verifyRetry &&
        unknown &&
        computer.error == null &&
        computer.status?.status == 'unassigned') {
      _retryVerified = true;
    }
    _changed();
  }

  Future<void> prepare() async {
    if (!canPrepare || !computer.beginConnectionChange()) return;
    preparing = true;
    _retryVerified = false;
    error = null;
    _changed();
    try {
      final result = await computer.scope.request(
        'POST',
        '${computer.base}/prepare',
        body: {},
      );
      ComputerStatus(result, computer.agentId);
      if (!active) return;
      unknown = false;
    } catch (cause) {
      if (active) {
        error = cause is ApiException ? cause.message : 'requestUnknown';
        unknown =
            !(cause is ApiException &&
                cause.status >= 400 &&
                cause.status < 500 &&
                cause.status != 408);
      }
    } finally {
      preparing = false;
      computer.endConnectionChange();
      _changed();
    }
    if (active && computer.visible) await refresh(verifyRetry: false);
  }

  @override
  void dispose() {
    _closed = true;
    computer.removeListener(_changed);
    computer.scope.removeListener(_changed);
    computer.scope.session.removeListener(_changed);
    super.dispose();
  }
}
