import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../apps/app_approval_data.dart';
import 'action_data.dart';

class ActionController extends ChangeNotifier {
  ActionController(
    this.scope,
    this.messageId,
    this.conversationId,
    this.initial,
  ) : _origin = scope.session.api.server!.origin;
  final WorkspaceController scope;
  final String messageId, conversationId, _origin;
  final ChatAction initial;
  bool ready = false, busy = false, uncertain = false, _closed = false;
  String? error;
  bool get active => !_closed && scope.active;
  ChatAction? get current {
    final message = scope.find('messages', messageId);
    if (message == null || message['conversationId'] != conversationId) {
      return null;
    }
    final value = ChatAction.fromMessage(message);
    return value?.id == initial.id && value?.kind == initial.kind
        ? value
        : null;
  }

  bool get canDecide =>
      active &&
      ready &&
      !busy &&
      !uncertain &&
      current?.status == 'pending' &&
      current!.canDecide(scope.userId, scope.owner);

  ExactAppRead? alwaysAllowReview(ChatAction action) =>
      scope.personalOwner &&
          action.value['requester'] is Map &&
          action.canDecide(scope.userId, scope.owner)
      ? action.exactAppRead
      : null;
  String get _key => scope.session.api.vault.key(
    _origin,
    'action-decision:${scope.userId}:${scope.workspaceId}:${initial.kind}:${initial.id}',
  );
  void guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<ChatAction?> fresh() async {
    final data = await scope.request('GET', '/bootstrap');
    guard();
    final messages = data['messages'];
    if (messages is! List) {
      throw const ApiException('INVALID_RESPONSE', 'mobileChatRefreshFailed');
    }
    for (final message in messages.whereType<Json>()) {
      if (message['id'] == messageId &&
          message['conversationId'] == conversationId) {
        final action = ChatAction.fromMessage(message);
        return action?.kind == initial.kind && action?.id == initial.id
            ? action
            : null;
      }
    }
    return null;
  }

  Future<void> initialize() async {
    try {
      final stored = await scope.session.api.vault.store.read(_key);
      guard();
      uncertain = stored != null;
      ready = true;
    } catch (e) {
      if (active) error = 'mobileChatDecisionStorage';
    }
    if (active) notifyListeners();
  }

  Future<void> refresh() async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await scope.refresh();
      guard();
      if (scope.error != null) {
        throw const ApiException('READ_FAILED', 'mobileChatRefreshFailed');
      }
      if (current == null) error = 'mobileChatActionMissing';
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  bool _matches(ChatAction? action, String displayed, bool alwaysAllow) =>
      action != null &&
      action.status == 'pending' &&
      action.fingerprint == displayed &&
      action.canDecide(scope.userId, scope.owner) &&
      (!alwaysAllow || alwaysAllowReview(action) != null);

  Future<void> _forgetDefinitiveRejection() async {
    await scope.session.api.vault.serial(() async {
      guard();
      await scope.session.api.vault.store.delete(_key);
    });
    guard();
    uncertain = false;
  }

  Future<void> decide(bool approve, {String? alwaysAllowFingerprint}) async {
    if (!canDecide) return;
    final displayed = current!.fingerprint;
    final alwaysAllow = alwaysAllowFingerprint != null;
    if (alwaysAllow &&
        (!approve ||
            alwaysAllowFingerprint != displayed ||
            alwaysAllowReview(current!) == null)) {
      error = 'mobileChatActionChanged';
      notifyListeners();
      return;
    }
    busy = true;
    error = null;
    notifyListeners();
    try {
      final action = await fresh();
      if (!_matches(action, displayed, alwaysAllow)) {
        throw const ApiException('ACTION_CHANGED', 'mobileChatActionChanged');
      }
      final dispatch = await scope.session.api.vault.serial(() async {
        guard();
        if (await scope.session.api.vault.store.read(_key) != null) {
          return false;
        }
        guard();
        try {
          await scope.session.api.vault.store.write(_key, 'submitted');
        } catch (_) {
          throw const ApiException(
            'STORAGE_FAILED',
            'mobileChatDecisionStorage',
          );
        }
        guard();
        return true;
      });
      guard();
      uncertain = true;
      if (!dispatch) return;
      final latest = current;
      if (!_matches(latest, displayed, alwaysAllow)) {
        await _forgetDefinitiveRejection();
        throw const ApiException('ACTION_CHANGED', 'mobileChatActionChanged');
      }
      final response = await scope.request(
        'POST',
        latest!.decisionPath(approve),
        body: latest.decisionBody(approve, alwaysAllow: alwaysAllow),
      );
      guard();
      if (response['id'] != initial.id ||
          !actionStates.contains(response['status'])) {
        throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
      }
      await scope.refresh();
      guard();
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestUnknown';
        if (alwaysAllow && e is ApiException && e.status == 409) {
          final copy = switch (e.code) {
            'APP_APPROVAL_RULE_CHANGED' => 'mobileAppsRuleChanged',
            'APP_APPROVAL_RULE_LIMIT' => 'mobileAppsRuleLimit',
            _ => null,
          };
          if (copy != null) {
            try {
              await _forgetDefinitiveRejection();
              error = copy;
              await scope.refresh();
            } catch (_) {
              if (active) error = 'mobileChatDecisionStorage';
            }
          }
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
