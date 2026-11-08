import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../computer/computer_controller.dart';
import '../settings/model_profile_data.dart';
import 'teaching_data.dart';
import 'teaching_pending.dart';

part 'teaching_requests.dart';

class TeachingController extends ChangeNotifier {
  TeachingController(this.computer)
    : scope = computer.scope,
      recovery = TeachingPending(computer.scope, computer.agentId) {
    // Close the input gate synchronously, before the first recovery read starts.
    computer.teachingBlocked = scope.owner;
    _lastFrame = computer.frame?.serial ?? 0;
    computer.addListener(_computerChanged);
    scope.addListener(_identity);
    scope.session.addListener(_identity);
  }
  final ComputerController computer;
  final WorkspaceController scope;
  final TeachingPending recovery;
  final cancellation = ByteReadCancellation();
  Json? record, draft;
  String? baseRevision, selectedModel, modelSnapshot, error;
  List<Json> history = [], models = [];
  bool busy = false, ready = false, blocked = false, _closed = false;
  bool acceptPartial = false;
  String? _leaseId, _binding, _botRevision;
  int editorVersion = 0, _lastFrame = 0;
  Timer? _poll;
  bool _cleaning = false;
  bool get active =>
      !_closed && scope.active && scope.owner && computer.visible;
  Json? get pending => recovery.value;
  bool get uncertain => pending != null && pending!['kind'] != 'idle';
  bool get dirty =>
      draft != null &&
      record != null &&
      jsonEncode(draft) != jsonEncode(teachingReview(record!));
  bool get changed => record != null && record!['revision'] != baseRevision;
  bool get local => teachingConversation(scope, computer.agentId) != null;
  bool get canStart =>
      active &&
      ready &&
      !blocked &&
      !busy &&
      !computer.busy &&
      local &&
      pending == null &&
      record == null &&
      computer.lease != null &&
      !computer.lease!.expired &&
      computer.canInput &&
      scope.find('agents', computer.agentId)?['status'] != 'working';
  bool get editable =>
      active &&
      local &&
      !busy &&
      !uncertain &&
      ['review', 'interrupted', 'error'].contains(record?['status']);
  bool get liveRecording =>
      active &&
      local &&
      record?['status'] == 'recording' &&
      !uncertain &&
      _leaseId != null &&
      computer.lease?.id == _leaseId &&
      computer.lease?.expired == false &&
      computer.status?.fingerprint == _binding &&
      record?['screen']?['surface'] == computer.status?.surface &&
      record?['screen']?['screenId'] == computer.status?.binding['screenId'] &&
      scope.find('agents', computer.agentId)?['configRevision'] == _botRevision;
  void guard() {
    scope.guard();
    if (!active) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  void _syncBlock() {
    computer.blockTeaching(
      scope.owner &&
          (!ready ||
              blocked ||
              busy ||
              uncertain ||
              (record?['status'] == 'recording' && !liveRecording)),
    );
  }

  void notify() {
    if (!_closed) {
      _syncBlock();
      notifyListeners();
    }
  }

  void _identity() {
    if (_leaseId != null &&
        (record?['status'] == 'recording' || pending?['kind'] == 'start') &&
        (!local ||
            scope.find('agents', computer.agentId)?['configRevision'] !=
                _botRevision)) {
      _cleanup();
    }
    if (!active) {
      if (!scope.active || !scope.owner) {
        cancellation.cancel();
      }
      _poll?.cancel();
      draft = null;
      selectedModel = null;
      modelSnapshot = null;
    }
    notify();
  }

  void _computerChanged() {
    if (_closed) {
      return;
    }
    if ((record?['status'] == 'recording' || pending?['kind'] == 'start') &&
        _leaseId != null &&
        (!computer.visible ||
            computer.lease?.id != _leaseId ||
            computer.status?.fingerprint != _binding ||
            scope.find('agents', computer.agentId)?['configRevision'] !=
                _botRevision)) {
      _cleanup();
    }
    final serial = computer.frame?.serial;
    if (serial != null && serial != _lastFrame) {
      _lastFrame = serial;
      if (active &&
          record?['status'] == 'recording' &&
          !computer.busy &&
          !busy) {
        unawaited(check());
      }
    }
    _syncBlock();
    if (!busy) {
      _schedule();
    }
  }

  Future<Object?> send(String method, String path, [Json? body]) async {
    guard();
    final value = await scope.requestValue(
      method,
      path,
      body: body,
      cancellation: cancellation,
    );
    guard();
    return value;
  }

  Future<void> work(Future<void> Function() action) async {
    if (!active || busy) {
      return;
    }
    busy = true;
    error = null;
    notify();
    try {
      await action();
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestUnknown';
      }
    } finally {
      busy = false;
      notify();
      _schedule();
    }
  }

  void _schedule() {
    _poll?.cancel();
    if (active && ['recording', 'generating'].contains(record?['status'])) {
      _poll = Timer(const Duration(seconds: 2), () => unawaited(check()));
    }
  }

  void _accept(Json next, {bool load = false}) {
    final replace = load || !dirty || record?['id'] != next['id'];
    record = next;
    if (replace) {
      loadDraft();
    }
  }

  void loadDraft() {
    if (record == null) {
      return;
    }
    draft = teachingReview(record!);
    baseRevision = record!['revision'];
    editorVersion++;
    acceptPartial = false;
    notify();
  }

  void updateGoal(String goal) {
    if (!editable || draft == null || !teachingText(goal, 2000)) {
      return;
    }
    draft = {...draft!, 'goal': goal};
    notify();
  }

  void updateNote(String id, String note) {
    if (!editable || draft == null || !teachingText(note, 1000)) {
      return;
    }
    draft = {
      ...draft!,
      'steps': [
        for (final s in draft!['steps'] as List)
          s['id'] == id ? {'id': id, 'note': note} : s,
      ],
    };
    notify();
  }

  void removeStep(String id) {
    if (!editable || draft == null) {
      return;
    }
    draft = {
      ...draft!,
      'steps': (draft!['steps'] as List).where((s) => s['id'] != id).toList(),
    };
    notify();
  }

  void chooseModel(String? id) {
    if (!editable) {
      return;
    }
    final profile = models
        .where((m) => m['id'] == id && m['configured'] == true)
        .firstOrNull;
    selectedModel = profile?['id'];
    modelSnapshot = profile == null ? null : teachingFingerprint(profile);
    notify();
  }

  Future<void> _models() async {
    final raw = await send('GET', '/model-profiles');
    if (raw is! Json || raw['profiles'] is! List) {
      invalidTeaching();
    }
    models = (raw['profiles'] as List)
        .whereType<Json>()
        .map(publicModel)
        .where((m) => m['configured'] == true)
        .toList();
    if (selectedModel != null &&
        !models.any(
          (m) =>
              m['id'] == selectedModel &&
              teachingFingerprint(m) == modelSnapshot,
        )) {
      selectedModel = null;
      modelSnapshot = null;
      error = 'mobileTeachingModelChanged';
    }
  }

  Future<void> initialize() => work(() async {
    try {
      await recovery.load();
      guard();
      blocked = false;
    } catch (_) {
      blocked = true;
      rethrow;
    }
    await _check();
    await _models();
  });
  Future<void> check() => ready ? work(_check) : initialize();
  Future<void> _check() async {
    if (pending != null) {
      final marker = Map<String, dynamic>.from(pending!);
      try {
        final next = teachingRecord(
          await send('GET', '/teaching/${marker['id']}'),
          computer.agentId,
          conversation: marker['conversationId'],
          id: marker['id'],
        );
        await _observed(marker, next);
      } on ApiException catch (e) {
        if (e.status == 410 && e.code == 'TEACHING_CLOSED') {
          await recovery.clear(marker);
          guard();
          record = null;
          draft = null;
        } else {
          rethrow;
        }
      }
    }
    final rows = await send('GET', '/teaching');
    if (rows is! List || rows.length > 30 || rows.any((r) => r is! Json)) {
      invalidTeaching();
    }
    history = rows
        .whereType<Json>()
        .where((r) => r['agentId'] == computer.agentId)
        .map((r) => teachingRecord(r, computer.agentId))
        .toList();
    if (pending == null && record == null) {
      final running = history
          .where((r) => ['recording', 'generating'].contains(r['status']))
          .toList();
      if (running.length > 1) {
        invalidTeaching();
      }
      if (running.isNotEmpty) {
        final next = teachingRecord(
          await send('GET', '/teaching/${running.single['id']}'),
          computer.agentId,
          conversation: running.single['conversationId'],
          id: running.single['id'],
        );
        await recovery.replace(
          _marker('idle', next['id'], next['conversationId']),
          null,
        );
        guard();
        _accept(next, load: true);
      }
    }
    ready = true;
  }

  Future<void> select(Json item) => work(() async {
    if (uncertain || ['recording', 'generating'].contains(record?['status'])) {
      return;
    }
    final next = teachingRecord(
      await send('GET', '/teaching/${item['id']}'),
      computer.agentId,
      id: item['id'],
    );
    await recovery.replace(
      _marker('idle', next['id'], next['conversationId']),
      pending,
    );
    guard();
    _leaseId = null;
    _accept(next, load: true);
  });
  Future<void> newRecording() => work(() async {
    if (uncertain || ['recording', 'generating'].contains(record?['status'])) {
      return;
    }
    if (pending != null) {
      await recovery.clear(pending!);
    }
    guard();
    record = null;
    draft = null;
    _leaseId = null;
    selectedModel = null;
    modelSnapshot = null;
    _cleaning = false;
  });
  void _cleanup() {
    if (_cleaning || pending == null || !scope.active || !scope.owner) {
      return;
    }
    _cleaning = true;
    final marker = Map<String, dynamic>.from(pending!);
    // The cancellation endpoint fences a late start or generation, without replaying either.
    unawaited(() async {
      try {
        await recovery.replace({
          ...marker,
          'kind': 'cancel',
          'operationId': requestId(),
        }, marker);
        if (scope.active && scope.owner) {
          await scope.request(
            'POST',
            '/teaching/${marker['id']}/cancel',
            body: {},
          );
        }
      } catch (_) {
      } finally {
        if (!_closed) {
          notify();
        }
      }
    }());
  }

  @override
  void dispose() {
    if (uncertain || ['recording', 'generating'].contains(record?['status'])) {
      _cleanup();
    }
    _closed = true;
    _poll?.cancel();
    cancellation.cancel();
    draft = null;
    computer.removeListener(_computerChanged);
    scope.removeListener(_identity);
    scope.session.removeListener(_identity);
    // The screen owns the controller and may be disposing its listeners now.
    computer.teachingBlocked = scope.owner;
    super.dispose();
  }
}
