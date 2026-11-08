import 'dart:convert';

import 'package:flutter/material.dart';

import 'api.dart';
import 'avatar_preferences.dart';
import 'avatar_theme_sync.dart';

class AppSession extends ChangeNotifier {
  AppSession(this.api) {
    avatarSync = AvatarThemeSync(api, _avatarIdentity);
    avatarSync.addListener(notifyListeners);
  }
  final ApiClient api;
  Json? user;
  List<Json> workspaces = [];
  Json? workspace;
  bool ready = false;
  bool busy = false;
  String? error;
  Locale locale = const Locale('zh');
  ThemeMode theme = ThemeMode.system;
  String _deviceAvatarTheme = defaultAvatarTheme;
  GeneratedAvatarTheme? _deviceCustomAvatar;
  bool _deviceUseCustomAvatar = false;
  late final AvatarThemeSync avatarSync;

  AvatarThemeSelection get avatarSelection =>
      avatarSync.effective ??
      (
        family: _deviceAvatarTheme,
        custom: _deviceCustomAvatar,
        useCustom: _deviceUseCustomAvatar,
      );
  String get avatarTheme => avatarSelection.family;
  set avatarTheme(String value) => _deviceAvatarTheme = value;
  GeneratedAvatarTheme? get customAvatarTheme => avatarSelection.custom;
  set customAvatarTheme(GeneratedAvatarTheme? value) =>
      _deviceCustomAvatar = value;
  bool get useCustomAvatarTheme => avatarSelection.useCustom;
  set useCustomAvatarTheme(bool value) => _deviceUseCustomAvatar = value;
  int _action = 0;
  bool _closed = false;

  String? get userId => user?['id'] as String?;
  String? get workspaceId => workspace?['id'] as String?;
  bool get owner => workspace?['role'] == 'owner';
  String get identityKey => '${api.server?.origin}:$userId:$workspaceId';

  AvatarThemeIdentity? _avatarIdentity() {
    final account = userId, selected = workspaceId, origin = api.server?.origin;
    if (_closed || account == null || selected == null || origin == null) {
      return null;
    }
    return (
      origin: origin,
      userId: account,
      workspaceId: selected,
      generation: api.generation,
    );
  }

  Future<void> initialize() async {
    try {
      final prefs = await api.vault.store.read('openbot.preferences.v1');
      if (prefs != null) {
        final p = jsonDecode(prefs);
        if (p is Map) {
          locale = Locale(p['language'] == 'en' ? 'en' : 'zh');
          theme = ThemeMode.values.firstWhere(
            (v) => v.name == p['theme'],
            orElse: () => ThemeMode.system,
          );
          avatarTheme = validAvatarTheme(p['avatars']);
          customAvatarTheme = GeneratedAvatarTheme.parse(
            p['customAvatarTheme'],
          );
          useCustomAvatarTheme =
              customAvatarTheme != null && p['useCustomAvatarTheme'] == true;
        }
      }
      api.language = locale.languageCode == 'en' ? 'en' : 'zh-CN';
      final origin = await api.vault.store.read('openbot.server.v1');
      if (origin != null) {
        await api.configure(parseServer(origin));
        await refresh();
      }
    } catch (e) {
      error = _message(e);
    }
    if (_closed) return;
    ready = true;
    notifyListeners();
  }

  Future<void> connect(String value) => _perform(() async {
    final origin = parseServer(value);
    avatarSync.clear();
    user = null;
    workspace = null;
    workspaces = [];
    await api.configure(origin);
    await api.vault.store.write('openbot.server.v1', origin.origin);
    await refresh();
  });

  Future<void> authenticate(Json body, {required bool register}) =>
      _perform(() async {
        avatarSync.clear();
        api.invalidate();
        final response = await api.request(
          'POST',
          register ? '/api/account/register' : '/api/account/login',
          body: body,
        );
        _accept(response);
      });

  Future<void> refresh() async {
    final stamp = api.generation;
    final expected = userId;
    final response = await api.request(
      'GET',
      '/api/account/session',
      expectedUser: expected,
    );
    api.guard(stamp);
    _accept(response);
    if (!_closed) notifyListeners();
  }

  void _accept(Json response) {
    if (response['authenticated'] != true) {
      avatarSync.clear();
      user = null;
      workspace = null;
      workspaces = [];
      return;
    }
    final next = response['user'];
    if (next is! Json || next['id'] is! String) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    final oldUser = userId;
    final oldWorkspace = workspaceId;
    user = next;
    workspaces = (response['workspaces'] as List? ?? [])
        .whereType<Json>()
        .toList();
    workspace = null;
    if (oldUser == userId && oldWorkspace != null) {
      for (final item in workspaces) {
        if (item['id'] == oldWorkspace && item['status'] == 'active') {
          workspace = item;
        }
      }
    }
    if (oldUser != userId || oldWorkspace != workspaceId) avatarSync.clear();
  }

  void selectWorkspace(Json? value) {
    if (value != null &&
        !workspaces.any(
          (w) => w['id'] == value['id'] && w['status'] == 'active',
        )) {
      return;
    }
    if (workspaceId != value?['id']) avatarSync.clear();
    workspace = value;
    error = null;
    notifyListeners();
  }

  Future<void> signOut() => _perform(() async {
    final expected = userId;
    if (expected == null) return;
    await api.request('POST', '/api/account/logout', expectedUser: expected);
    await api.clearSession();
    avatarSync.clear();
    user = null;
    workspace = null;
    workspaces = [];
  });

  Future<void> preferences({
    Locale? language,
    ThemeMode? mode,
    String? avatars,
    GeneratedAvatarTheme? customAvatar,
    bool useCustomAvatar = false,
  }) async {
    if (language != null) locale = language;
    if (mode != null) theme = mode;
    final family = avatarThemes.contains(avatars) ? avatars : null;
    if (family != null || customAvatar != null || useCustomAvatar) {
      final current = avatarSelection;
      final custom = customAvatar ?? current.custom;
      final useCustom =
          custom != null &&
          (customAvatar != null ||
              useCustomAvatar ||
              (family == null && current.useCustom));
      if (avatarSync.effective != null) {
        avatarSync.edit((
          family: family ?? current.family,
          custom: custom,
          useCustom: useCustom,
        ));
        if (language == null && mode == null) return;
      } else {
        _deviceAvatarTheme = family ?? current.family;
        _deviceCustomAvatar = custom;
        _deviceUseCustomAvatar = useCustom;
      }
    }
    api.language = locale.languageCode == 'en' ? 'en' : 'zh-CN';
    final snapshot = jsonEncode({
      'language': locale.languageCode,
      'theme': theme.name,
      'avatars': _deviceAvatarTheme,
      if (_deviceCustomAvatar != null)
        'customAvatarTheme': _deviceCustomAvatar!.toJson(),
      if (_deviceUseCustomAvatar) 'useCustomAvatarTheme': true,
    });
    notifyListeners();
    try {
      await api.vault.serial(
        () => api.vault.store.write('openbot.preferences.v1', snapshot),
      );
    } catch (e) {
      if (!_closed) {
        error = _message(e);
        notifyListeners();
      }
    }
  }

  Future<void> _perform(Future<void> Function() work) async {
    if (busy) return;
    final action = ++_action;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await work();
    } catch (e) {
      if (action == _action) error = _message(e);
    } finally {
      if (action == _action) {
        busy = false;
        notifyListeners();
      }
    }
  }

  String _message(Object e) => e is ApiException ? e.message : 'requestFailed';
  @override
  void dispose() {
    _closed = true;
    _action++;
    avatarSync.dispose();
    api.dispose();
    super.dispose();
  }
}
