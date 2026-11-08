import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'model_profile_data.dart';

class ModelProfilesController extends ChangeNotifier {
  ModelProfilesController(this.scope)
    : _origin = scope.session.api.server!.origin {
    scope.session.addListener(_identityChanged);
  }
  final WorkspaceController scope;
  final String _origin;
  List<Json> profiles = [];
  String? activeId, error, notice;
  Json? pending;
  bool ready = false,
      busy = false,
      loading = false,
      checked = false,
      _closed = false;
  int _read = 0;
  bool get active => !_closed && scope.active;
  bool get canManage =>
      active && scope.owner && ready && !busy && !loading && pending == null;
  String get _key => scope.session.api.vault.key(
    _origin,
    'model-operation:${scope.userId}:${scope.workspaceId}',
  );
  Json? find(String id) => profiles.where((p) => p['id'] == id).firstOrNull;
  void guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  void notify() {
    if (active) notifyListeners();
  }

  void _identityChanged() {
    if (_closed) return;
    if (!active) {
      _read++;
      profiles = [];
      activeId = null;
    } else if (!scope.owner) {
      _read++;
      loading = false;
      try {
        final model = activeModel(scope.data?['settings'] as Json?);
        profiles = model == null ? [] : [model];
        activeId = model?['id'] as String?;
      } catch (_) {
        profiles = [];
        activeId = null;
      }
    }
    notifyListeners();
  }

  Future<void> initialize() async {
    try {
      final raw = await scope.session.api.vault.store.read(_key);
      guard();
      if (raw != null) {
        final value = jsonDecode(raw);
        if (value is! Json ||
            !isRequestId(value['operationId']) ||
            !['save', 'create', 'activate', 'delete'].contains(value['kind']) ||
            (value['id'] != null && value['id'] is! String)) {
          throw const ApiException(
            'INVALID_PENDING',
            'mobileModelsRecoveryFailed',
          );
        }
        pending = value;
      }
      ready = true;
      await refresh();
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'mobileModelsRecoveryFailed';
      }
    }
    notify();
  }

  Future<void> refresh() async {
    if (!active || busy) return;
    final read = ++_read;
    loading = true;
    error = null;
    checked = false;
    notify();
    try {
      if (!scope.owner) {
        await scope.refresh();
        guard();
        final model = activeModel(scope.data?['settings'] as Json?);
        if (read != _read) return;
        profiles = model == null ? [] : [model];
        activeId = model?['id'] as String?;
      } else {
        final value = await scope.request('GET', '/model-profiles');
        guard();
        if (read != _read) return;
        if (value['profiles'] is! List || value['activeProfileId'] is! String) {
          throw const ApiException('INVALID_RESPONSE', 'requestFailed');
        }
        final next = (value['profiles'] as List)
            .map((p) => publicModel(p as Json))
            .toList();
        if (next.map((p) => p['id']).toSet().length != next.length ||
            !next.any((p) => p['id'] == value['activeProfileId'])) {
          throw const ApiException('INVALID_RESPONSE', 'requestFailed');
        }
        profiles = next;
        activeId = value['activeProfileId'] as String;
      }
      checked = true;
    } catch (e) {
      if (active && read == _read) {
        error = e is ApiException ? e.message : 'requestFailed';
      }
    } finally {
      if (active && read == _read) {
        loading = false;
        notify();
      }
    }
  }

  Future<void> _clear(Json expected) async {
    await scope.session.api.vault.serial(() async {
      guard();
      final raw = await scope.session.api.vault.store.read(_key);
      guard();
      if (raw != jsonEncode(expected)) {
        throw const ApiException(
          'RECOVERY_CHANGED',
          'mobileModelsRecoveryFailed',
        );
      }
      await scope.session.api.vault.store.delete(_key);
      guard();
      pending = null;
    });
  }

  Future<bool> acknowledge() async {
    if (!active || busy || loading || !checked || pending == null) return false;
    try {
      await _clear(pending!);
      error = null;
      notify();
      return true;
    } catch (_) {
      if (active) error = 'mobileModelsRecoveryFailed';
      notify();
      return false;
    }
  }

  Future<Json?> write(String kind, {String? id, Json? fields}) async {
    if (!canManage ||
        !['save', 'create', 'activate', 'delete'].contains(kind)) {
      return null;
    }
    if (kind != 'create' && (id == null || find(id) == null)) return null;
    final record = <String, dynamic>{
      'operationId': requestId(),
      'kind': kind,
      'id': ?id,
    };
    var dispatched = false;
    busy = true;
    error = null;
    notice = null;
    checked = false;
    _read++;
    notify();
    Json? result;
    try {
      final canWrite = await scope.session.api.vault.serial(() async {
        guard();
        final existing = await scope.session.api.vault.store.read(_key);
        guard();
        if (existing != null) {
          pending = jsonDecode(existing) as Json;
          return false;
        }
        await scope.session.api.vault.store.write(_key, jsonEncode(record));
        guard();
        pending = record;
        return true;
      });
      guard();
      if (!canWrite || !scope.owner) return null;
      final path = kind == 'activate'
          ? '/model-profiles/$id/activate'
          : kind == 'delete'
          ? '/model-profiles/$id'
          : '/model-profiles';
      final body = ['create', 'save'].contains(kind)
          ? {
              for (final key in [...modelFields, 'apiKey', 'clearApiKey'])
                if (fields!.containsKey(key)) key: fields[key],
              if (kind == 'save') 'id': id,
              'activate': false,
            }
          : <String, dynamic>{};
      dispatched = true;
      final value = await scope.request(
        kind == 'delete' ? 'DELETE' : 'POST',
        path,
        body: body,
      );
      guard();
      if (['create', 'save'].contains(kind)) {
        result = publicModel(value['profile'] as Json);
        if (kind == 'save' && result['id'] != id) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
      } else if (kind == 'activate') {
        if (value['profileId'] != id) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
        result = find(id!);
      } else {
        if (value['ok'] != true) {
          throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
        }
        result = {'id': id};
      }
      await _clear(record);
      notice = kind == 'activate'
          ? 'mobileModelsActivated'
          : kind == 'delete'
          ? 'mobileModelsDeleted'
          : 'mobileModelsSaved';
    } catch (e) {
      if (active) {
        error = e is ApiException
            ? e.message
            : dispatched
            ? 'requestUnknown'
            : 'mobileModelsRecoveryFailed';
      }
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
    if (result != null && active) {
      await refresh();
      if (!active) return null;
      await scope.refresh();
    }
    return active ? result : null;
  }

  @override
  void dispose() {
    scope.session.removeListener(_identityChanged);
    _closed = true;
    _read++;
    super.dispose();
  }
}
