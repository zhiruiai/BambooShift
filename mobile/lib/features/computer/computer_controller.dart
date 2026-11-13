import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import 'computer_data.dart';
import 'computer_frame.dart';

class ComputerController extends ChangeNotifier {
  ComputerController(this.scope, this.agentId)
    : _workspaceTarget = computerWorkspaceTarget(scope.data?['computer']) {
    scope.addListener(_scopeChanged);
    scope.session.addListener(_scopeChanged);
  }
  final WorkspaceController scope;
  final String agentId;
  ComputerStatus? status;
  ComputerLease? lease;
  ComputerFrame? frame;
  List<Json> screens = [];
  Json? capacity;
  String? inventoryReason;
  bool _busy = false, _releasing = false, occupied = false, uncertain = false;
  bool _connectionChanging = false, _resumeRequested = false;
  final _unknownConnections = <String>{};
  bool get connectionUnknown => _unknownConnections.isNotEmpty;
  bool connectionUnknownFor(String source) =>
      _unknownConnections.contains(source);
  void setConnectionUnknown(bool value, {String source = 'manual'}) {
    final changed = value
        ? _unknownConnections.add(source)
        : _unknownConnections.remove(source);
    if (changed) _publish();
  }

  bool get busy => _busy || _releasing || _connectionChanging;
  bool get canChangeConnection =>
      visible &&
      !busy &&
      lease == null &&
      !occupied &&
      !unknownStart &&
      !connectionUnknown &&
      !uncertain &&
      !teachingBlocked;
  bool beginConnectionChange() {
    if (!canChangeConnection) return false;
    _connectionChanging = true;
    _epoch++;
    _read?.cancel();
    _clearFrame();
    _publish();
    return true;
  }

  void endConnectionChange() {
    _connectionChanging = false;
    _publish();
    _continueResume();
  }

  bool teachingBlocked = false;
  void blockTeaching(bool value) {
    if (teachingBlocked == value) return;
    teachingBlocked = value;
    _publish();
  }

  bool unknownStart = false, _closed = false, _paused = false;
  String? error;
  int _epoch = 0, _frameSerial = 0, _uncertainFrame = 0;
  String? _leaseBinding, _releaseAttempted, _workspaceTarget;
  bool get releaseUnknown => lease != null && _releaseAttempted == lease!.id;
  Timer? _expiry;
  ByteReadCancellation? _read;
  bool get active =>
      !_closed && scope.active && scope.find('agents', agentId) != null;
  bool get visible => active && !_paused;
  String get base => '/computer/bots/$agentId';
  bool get canStart =>
      visible &&
      !busy &&
      status?.ready == true &&
      status?.privateTakeover == true &&
      lease == null &&
      !occupied &&
      !unknownStart &&
      !connectionUnknown &&
      !uncertain;
  bool get canInput =>
      !teachingBlocked &&
      visible &&
      !busy &&
      !uncertain &&
      !connectionUnknown &&
      !releaseUnknown &&
      lease != null &&
      !lease!.expired &&
      status?.ready == true &&
      frame?.isPrivate == true &&
      frame!.binding == _leaseBinding &&
      frame!.binding == status!.fingerprint &&
      frame!.source.width == lease!.width &&
      frame!.source.height == lease!.height &&
      (lease!.surface == null || lease!.surface == status!.surface);
  bool get canAcknowledge =>
      visible &&
      !busy &&
      uncertain &&
      !releaseUnknown &&
      frame != null &&
      (lease == null || frame!.isPrivate) &&
      frame!.serial > _uncertainFrame;

  void _publish() {
    if (!_closed) notifyListeners();
  }

  void _clearFrame() {
    frame?.dispose();
    frame = null;
  }

  void _clearLease() {
    lease = null;
    _leaseBinding = null;
    _releaseAttempted = null;
    _expiry?.cancel();
  }

  void _scopeChanged() {
    final next = computerWorkspaceTarget(scope.data?['computer']);
    final changed = _workspaceTarget != next;
    _workspaceTarget = next;
    if (active && !changed) return;
    _epoch++;
    _read?.cancel();
    _clearFrame();
    if (changed) status = null;
    if (!scope.active) {
      _clearLease();
    } else if (lease != null) {
      uncertain = true;
      _leaseBinding = null;
      if (!busy) unawaited(_releaseKnown());
    }
    _publish();
  }

  void _check(int epoch) {
    if (!visible || epoch != _epoch) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  Future<Json> _get(String suffix) async {
    final value = await scope.requestValue('GET', suffix, cancellation: _read);
    if (value is! Json) invalidComputer();
    return value;
  }

  Future<void> _inspect(int epoch) async {
    final next = ComputerStatus(await _get('$base/status'), agentId);
    _check(epoch);
    final changed = status != null && next.fingerprint != status!.fingerprint;
    status = next;
    if (changed || !next.ready || (lease != null && !next.privateTakeover)) {
      _clearFrame();
      if (lease != null) {
        uncertain = true;
        _uncertainFrame = _frameSerial;
        await _releaseKnown();
        _check(epoch);
      }
    }
    if (!next.ready) {
      occupied = false;
      return;
    }
    final takeover = await _get('$base/takeover/status');
    _check(epoch);
    final dimensions = checkedTakeover(takeover);
    occupied = takeover['active'] == true;
    if (!occupied) {
      if (lease != null) _clearFrame();
      _clearLease();
      unknownStart = false;
    } else if (lease != null &&
        (lease!.expired ||
            dimensions.$1 != lease!.width ||
            dimensions.$2 != lease!.height ||
            (takeover['surface'] != null &&
                takeover['surface'] != lease!.surface))) {
      uncertain = true;
      _uncertainFrame = _frameSerial;
      _clearFrame();
      await _releaseKnown();
      _check(epoch);
    }
  }

  Future<void> refresh() async {
    if (!visible || busy) return;
    await _operation((epoch) async {
      final inventory = await _get('/computer/bots');
      _check(epoch);
      if (inventory['bots'] is! List) invalidComputer();
      capacity = inventory['capacity'] is Json
          ? inventory['capacity'] as Json
          : null;
      inventoryReason = inventory['reason'] is String
          ? inventory['reason'] as String
          : null;
      screens = (inventory['bots'] as List)
          .whereType<Json>()
          .where(
            (b) =>
                b['agentId'] is String &&
                scope.find('agents', b['agentId']) != null,
          )
          .toList();
      await _inspect(epoch);
      if (status!.ready) await _capture(epoch);
    });
  }

  Future<void> _capture(int epoch) async {
    final previous = status!;
    final binding = previous.fingerprint;
    final original = lease;
    _clearFrame();
    _publish();
    if ((original == null && (occupied || unknownStart)) || releaseUnknown) {
      return;
    }
    bool current() =>
        visible &&
        epoch == _epoch &&
        identical(original, lease) &&
        (original == null || (!original.expired && _leaseBinding == binding));
    void check() {
      if (!current()) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
    }

    check();
    final bytes = await scope.session.api.readComputerScreenshot(
      scope.workspaceId,
      agentId,
      expectedUser: scope.userId,
      isCurrent: current,
      cancellation: _read!,
      leaseId: original?.id,
    );
    try {
      check();
      final after = ComputerStatus(await _get('$base/status'), agentId);
      check();
      final wrongPrivate =
          original != null &&
          (!after.privateTakeover ||
              bytes.width != original.width ||
              bytes.height != original.height ||
              bytes.surface != original.surface);
      if (!after.ready ||
          binding != after.fingerprint ||
          (bytes.surface != null && bytes.surface != after.surface) ||
          wrongPrivate) {
        status = after;
        uncertain = original != null;
        _uncertainFrame = _frameSerial;
        if (original != null) await _releaseKnown();
        throw const ApiException('SCREEN_CHANGED', 'mobileComputerChanged');
      }
      final image = await decodeComputerFrame(bytes, check);
      try {
        check();
        frame = ComputerFrame(image, bytes, binding, ++_frameSerial);
      } catch (_) {
        image.dispose();
        rethrow;
      }
    } finally {
      if (bytes.isPrivate) bytes.bytes.fillRange(0, bytes.bytes.length, 0);
    }
  }

  Future<void> start() async {
    if (!canStart) return;
    await _operation((epoch) async {
      await _inspect(epoch);
      final screen = status!;
      if (!screen.ready || !screen.privateTakeover || occupied || uncertain) {
        return;
      }
      final binding = screen.fingerprint;
      unknownStart = true;
      _clearFrame();
      _publish();
      final response = await scope.request(
        'POST',
        '$base/takeover/start',
        body: {},
      );
      final accepted = ComputerLease.parse(response);
      lease = accepted;
      _leaseBinding = binding;
      occupied = true;
      unknownStart = false;
      if (!visible || epoch != _epoch || status?.fingerprint != binding) {
        await _releaseKnown();
        return;
      }
      _expiry = Timer(accepted.expiresAt.difference(DateTime.now()), () {
        _epoch++;
        _read?.cancel();
        _clearFrame();
        uncertain = true;
        _publish();
      });
      await _inspect(epoch);
      if (lease != null) await _capture(epoch);
    });
  }

  Future<bool> input(Json action, {int? frameSerial}) async {
    if (!canInput || (frameSerial != null && frameSerial != frame!.serial)) {
      return false;
    }
    var succeeded = false;
    final original = lease!;
    final binding = _leaseBinding;
    final selectedFrame = frame!.serial;
    await _operation((epoch) async {
      await _inspect(epoch);
      if (lease != original ||
          _leaseBinding != binding ||
          frame?.serial != selectedFrame ||
          status!.fingerprint != binding) {
        return;
      }
      validateComputerAction(
        action,
        original,
        virtualDesktop: status!.virtualDesktop,
      );
      _uncertainFrame = _frameSerial;
      uncertain = true;
      _clearFrame();
      final result = await scope.request(
        'POST',
        '$base/takeover/input',
        body: {...action, 'leaseId': original.id},
      );
      _check(epoch);
      if (result['ok'] != true) invalidComputer();
      succeeded = true;
      uncertain = false;
      await _inspect(epoch);
      if (status!.ready) await _capture(epoch);
    });
    return succeeded;
  }

  void acknowledge() {
    if (!canAcknowledge) return;
    uncertain = false;
    error = null;
    _publish();
  }

  Future<bool> end() async {
    if (!active || busy || lease == null) return lease == null && !unknownStart;
    var ended = false;
    await _operation((_) async {
      ended = await _releaseKnown();
    });
    return ended;
  }

  Future<bool> _releaseKnown() async {
    final original = lease;
    if (original == null) return true;
    if (_releaseAttempted == original.id) return false;
    _releaseAttempted = original.id;
    _clearFrame();
    if (!scope.active) {
      _clearLease();
      return false;
    }
    _releasing = true;
    _publish();
    try {
      final result = await scope.request(
        'POST',
        '$base/takeover/end',
        body: {'leaseId': original.id},
      );
      if (result['active'] != false) invalidComputer();
      if (lease == original) {
        _clearLease();
        occupied = false;
        uncertain = false;
      }
      return true;
    } catch (_) {
      uncertain = true;
      error = 'mobileComputerEndUnknown';
      return false;
    } finally {
      _releasing = false;
      _publish();
      _continueResume();
    }
  }

  Future<void> _operation(Future<void> Function(int) work) async {
    final epoch = ++_epoch;
    _busy = true;
    error = null;
    _read?.cancel();
    _read = ByteReadCancellation();
    _publish();
    try {
      await work(epoch);
    } catch (e) {
      if (visible && epoch == _epoch) {
        _clearFrame();
        if (lease != null) uncertain = true;
        error = e is ApiException ? e.message : 'mobileComputerRequestFailed';
      }
    } finally {
      if ((!visible || _closed || _leaseBinding == null) && lease != null) {
        await _releaseKnown();
      }
      _busy = false;
      _publish();
      _continueResume();
    }
  }

  void suspend() {
    _paused = true;
    _epoch++;
    _read?.cancel();
    _clearFrame();
    if (!busy && lease != null) {
      unawaited(_releaseKnown().then((_) => _publish()));
    }
    _publish();
  }

  void resume() {
    if (!active || !_paused) return;
    _paused = false;
    _resumeRequested = true;
    _publish();
    _continueResume();
  }

  void _continueResume() {
    if (!_resumeRequested || !visible || busy) return;
    _resumeRequested = false;
    unawaited(_resumeRead());
  }

  Future<void> _resumeRead() async {
    // A backgrounded window never resumes control with its old lease. If its
    // release is uncertain, read the current status but keep input disabled.
    if (lease != null) await end();
    if (visible && !busy) await refresh();
  }

  @override
  void dispose() {
    _closed = true;
    _epoch++;
    _read?.cancel();
    _expiry?.cancel();
    _clearFrame();
    if (!busy && lease != null) unawaited(_releaseKnown());
    scope.removeListener(_scopeChanged);
    scope.session.removeListener(_scopeChanged);
    super.dispose();
  }
}
