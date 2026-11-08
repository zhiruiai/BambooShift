import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import 'private_skill_data.dart';

typedef _Intent = ({PrivateSkillKey key, String targetId, bool enabled});

class PrivateSkillController extends ChangeNotifier {
  PrivateSkillController(this.scope) {
    scope.session.addListener(_scopeChanged);
  }
  final WorkspaceController scope;
  final _cancellation = ByteReadCancellation();
  PrivateSkillShelf shelf = const PrivateSkillShelf([], []);
  bool busy = false, authoritative = false, _closed = false;
  String? feedback;
  _Intent? _unconfirmed;
  bool get active =>
      !_closed && !_cancellation.cancelled && scope.personalOwner;
  bool get canWrite => active && authoritative && !busy && _unconfirmed == null;

  void _scopeChanged() {
    if (active || _closed) return;
    _cancellation.cancel();
    shelf = const PrivateSkillShelf([], []);
    feedback = null;
    _unconfirmed = null;
    notifyListeners();
  }

  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<Object?> _request(String method, String path, {Json? body}) async {
    _guard();
    final result = await scope.requestValue(
      method,
      path,
      body: body,
      cancellation: _cancellation,
    );
    _guard();
    return result;
  }

  Future<void> _read() async {
    final result = await _request('GET', '/private-skills');
    if (result is! Json) {
      throw const ApiException(
        'INVALID_RESPONSE',
        'mobileAppsPrivateSkillsInvalid',
      );
    }
    shelf = PrivateSkillShelf.parse(result);
    authoritative = true;
  }

  void _reconcile() {
    final intent = _unconfirmed;
    if (intent == null) return;
    _unconfirmed = null;
    final actual =
        shelf.find(intent.key)?.enabledAgentIds.contains(intent.targetId) ??
        false;
    feedback = actual != intent.enabled
        ? 'mobileAppsPrivateSkillCurrentState'
        : actual
        ? 'mobileAppsPrivateSkillEnabled'
        : 'mobileAppsPrivateSkillDisabled';
    if (actual == intent.enabled) unawaited(scope.refresh());
  }

  Future<void> refresh() async {
    if (!active || busy) return;
    busy = true;
    feedback = null;
    notifyListeners();
    try {
      await _read();
      _reconcile();
    } catch (error) {
      if (active) {
        authoritative = false;
        feedback = _unconfirmed != null
            ? 'mobileAppsPrivateSkillUnconfirmed'
            : error is ApiException && error.status == 404
            ? 'mobileAppsPrivateSkillsUnsupported'
            : 'mobileAppsPrivateSkillsInvalid';
      }
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  bool canChange(PrivateSkill skill, String? target, bool enabled) {
    final live = shelf.find(skill.key);
    return canWrite &&
        live != null &&
        target != null &&
        live.enabledAgentIds.contains(target) != enabled &&
        shelf.targets(live).any((bot) => bot.id == target) &&
        (!enabled || (live.available && shelf.earlier(live, target) == null));
  }

  Future<void> change(PrivateSkill skill, String target, bool enabled) async {
    if (!canChange(skill, target, enabled)) return;
    final intent = (key: skill.key, targetId: target, enabled: enabled);
    busy = true;
    feedback = null;
    _unconfirmed = intent;
    notifyListeners();
    String? conflict;
    try {
      try {
        final response = await _request(
          'PUT',
          '/private-skills/${skill.id}/bots/$target',
          body: {'enabled': enabled, 'expectedRevision': skill.revision},
        );
        if (response is! Json || response['enabled'] != enabled) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
      } on ApiException catch (error) {
        if (error.status == 409) {
          conflict = switch (error.code) {
            'PRIVATE_SKILL_CHANGED' => 'mobileAppsPrivateSkillChanged',
            'PRIVATE_SKILL_NAME_CONFLICT' =>
              'mobileAppsPrivateSkillNameConflict',
            _ => null,
          };
        }
      }
      if (conflict != null) _unconfirmed = null;
      await _read();
      _reconcile();
      if (conflict != null) feedback = conflict;
    } catch (_) {
      if (active) {
        authoritative = false;
        feedback = conflict ?? 'mobileAppsPrivateSkillUnconfirmed';
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
    scope.session.removeListener(_scopeChanged);
    _cancellation.cancel();
    super.dispose();
  }
}
