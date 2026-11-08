import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class DeviceSecretStore implements SecretStore {
  DeviceSecretStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

class SessionVault {
  SessionVault(this.store);
  final SecretStore store;
  Future<void> _tail = Future.value();

  String key(String origin, String purpose) =>
      'openbot.v1.${base64Url.encode(utf8.encode(origin))}.$purpose';

  Future<T> serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<String?> read(String origin, String purpose) =>
      serial(() => store.read(key(origin, purpose)));
  Future<void> write(
    String origin,
    String purpose,
    String value, {
    bool Function()? allowed,
  }) => serial(() async {
    if (allowed == null || allowed()) {
      await store.write(key(origin, purpose), value);
    }
  });
  Future<void> delete(String origin, String purpose) =>
      serial(() => store.delete(key(origin, purpose)));
}
