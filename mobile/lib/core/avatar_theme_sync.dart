import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'avatar_preferences.dart';
import 'byte_read.dart';

typedef AvatarThemeSelection = ({
  String family,
  GeneratedAvatarTheme? custom,
  bool useCustom,
});

typedef AvatarThemeIdentity = ({
  String origin,
  String userId,
  String workspaceId,
  int generation,
});

Json _themeData(AvatarThemeSelection value) => {
  'avatarTheme': value.family,
  'customAvatarTheme': value.custom?.toJson(),
  'useCustomAvatarTheme': value.useCustom,
};

bool _sameTheme(AvatarThemeSelection? left, AvatarThemeSelection? right) {
  if (left == null || right == null) return left == right;
  return jsonEncode(_themeData(left)) == jsonEncode(_themeData(right));
}

typedef _Snapshot = ({int revision, AvatarThemeSelection? theme});

_Snapshot _snapshot(Object? value) {
  if (value is Json && value.length == 2 && value.containsKey('theme')) {
    final revision = value['revision'];
    final data = value['theme'];
    if (revision is int && revision >= 0 && revision < 9007199254740991) {
      if (data == null) return (revision: revision, theme: null);
      if (data is Json &&
          data.length == 3 &&
          data.containsKey('customAvatarTheme')) {
        final family = data['avatarTheme'];
        final recipe = data['customAvatarTheme'];
        final useCustom = data['useCustomAvatarTheme'];
        final custom = GeneratedAvatarTheme.parse(recipe);
        if (family is String &&
            avatarThemes.contains(family) &&
            useCustom is bool &&
            (recipe == null || custom != null) &&
            (!useCustom || custom != null)) {
          return (
            revision: revision,
            theme: (family: family, custom: custom, useCustom: useCustom),
          );
        }
      }
    }
  }
  throw const ApiException('INVALID_AVATAR_THEME', 'requestFailed');
}

class AvatarThemeSync extends ChangeNotifier {
  AvatarThemeSync(this.api, this._currentIdentity);
  final ApiClient api;
  final AvatarThemeIdentity? Function() _currentIdentity;
  AvatarThemeIdentity? _identity;
  ByteReadCancellation? _pending;
  _Snapshot? _saved;
  AvatarThemeSelection? _draft;
  ({AvatarThemeSelection? theme, AvatarThemeSelection? draft})? _unconfirmed;
  String? _problem;
  bool _busy = false, _writing = false, _closed = false;

  bool get _current =>
      !_closed && _identity != null && _identity == _currentIdentity();
  bool get busy => _current && _busy;
  bool get writing => _current && _writing;
  String? get problem => _current ? _problem : null;
  bool get synced => _current && _saved?.theme != null;
  bool get hasDraft => _current && _draft != null;
  AvatarThemeSelection? get effective =>
      _current ? _draft ?? _saved?.theme : null;
  bool get _canWrite =>
      _current && !_busy && _problem == null && _saved != null;
  bool get canRemove => _canWrite && _saved?.theme != null;
  bool canSave(AvatarThemeSelection theme) =>
      _canWrite && !_sameTheme(theme, _saved?.theme);

  void clear() {
    _pending?.cancel();
    _pending = null;
    _identity = null;
    _saved = null;
    _draft = null;
    _unconfirmed = null;
    _problem = null;
    _busy = _writing = false;
  }

  void edit(AvatarThemeSelection theme) {
    if (effective == null || writing) return;
    _draft = _sameTheme(theme, _saved?.theme) ? null : theme;
    notifyListeners();
  }

  void discard() {
    if (!hasDraft || writing) return;
    _draft = null;
    notifyListeners();
  }

  Future<void> reload() async {
    final identity = _currentIdentity();
    if (_closed || identity == null || busy) return;
    if (_identity != identity) clear();
    _identity = identity;
    await _request('GET', 'avatarThemeSyncReadFailed');
  }

  Future<void> save(AvatarThemeSelection? theme) async {
    if (theme == null ? !canRemove : !canSave(theme)) return;
    final revision = _saved!.revision;
    await _request(
      'PUT',
      'avatarThemeSyncUnknown',
      body: {
        'theme': theme == null ? null : _themeData(theme),
        'revision': revision,
      },
      expected: (theme: theme, revision: revision + 1),
    );
  }

  Future<void> _request(
    String method,
    String errorKey, {
    Json? body,
    _Snapshot? expected,
  }) async {
    final identity = _identity!;
    final token = _pending = ByteReadCancellation();
    bool current() =>
        _current && _identity == identity && identical(_pending, token);
    _busy = true;
    _writing = method == 'PUT';
    _problem = null;
    notifyListeners();
    try {
      final result = _snapshot(
        await api.requestValue(
          method,
          '/api/workspaces/${Uri.encodeComponent(identity.workspaceId)}/avatar-theme',
          body: body,
          expectedUser: identity.userId,
          isCurrent: current,
          cancellation: token,
        ),
      );
      if (!current()) return;
      if ((expected != null &&
              (result.revision != expected.revision ||
                  !_sameTheme(result.theme, expected.theme))) ||
          result.revision < (_saved?.revision ?? 0)) {
        throw const ApiException('INVALID_AVATAR_THEME', 'requestFailed');
      }
      _saved = result;
      if (expected != null ||
          _sameTheme(_draft, result.theme) ||
          (_unconfirmed != null &&
              _sameTheme(_unconfirmed!.theme, result.theme) &&
              _sameTheme(_unconfirmed!.draft, _draft))) {
        _draft = null;
      }
      _unconfirmed = null;
    } catch (error) {
      if (current()) {
        if (expected != null) {
          _unconfirmed = (theme: expected.theme, draft: _draft);
        }
        _problem =
            error is ApiException && error.code == 'AVATAR_THEME_CONFLICT'
            ? 'avatarThemeSyncConflict'
            : errorKey;
      }
    } finally {
      if (current()) {
        _pending = null;
        _busy = _writing = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    clear();
    super.dispose();
  }
}
