import 'dart:convert';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import 'apps_data.dart';

String pendingTarget(Json marker) =>
    marker['kind'] == 'add' ? 'add' : marker['connectionId'] as String;

class AppsPendingChecks {
  AppsPendingChecks(this.scope)
    : key = scope.session.api.vault.key(
        scope.session.api.server!.origin,
        'apps.${scope.userId}.${scope.workspaceId}',
      );
  final WorkspaceController scope;
  final String key;
  Map<String, Json> entries = {};

  Map<String, Json> _decode(String? text) {
    if (text == null) return {};
    if (text.length > 65536) {
      throw const ApiException('INVALID_PENDING', 'mobileAppsStorage');
    }
    final value = jsonDecode(text);
    final List values;
    if (value is Json && value['version'] == 1) {
      values = [value];
    } else if (value is Json &&
        value['version'] == 2 &&
        value.keys.every((k) => {'version', 'entries'}.contains(k)) &&
        value['entries'] is List) {
      values = value['entries'];
    } else {
      throw const ApiException('INVALID_PENDING', 'mobileAppsStorage');
    }
    if (values.length > 21) {
      throw const ApiException('INVALID_PENDING', 'mobileAppsStorage');
    }
    final result = <String, Json>{};
    for (final value in values) {
      final marker = pendingData(jsonEncode(value));
      final target = pendingTarget(marker);
      if (result.containsKey(target)) {
        throw const ApiException('INVALID_PENDING', 'mobileAppsStorage');
      }
      result[target] = marker;
    }
    return result;
  }

  Future<void> load() async {
    scope.guard();
    final text = await scope.session.api.vault.store.read(key);
    scope.guard();
    entries = _decode(text);
  }

  Future<void> _write(Map<String, Json> next) async {
    scope.guard();
    if (next.isEmpty) {
      await scope.session.api.vault.store.delete(key);
    } else {
      await scope.session.api.vault.store.write(
        key,
        jsonEncode({'version': 2, 'entries': next.values.toList()}),
      );
    }
    scope.guard();
    entries = next;
  }

  Future<void> claim(Json marker, {bool cancelOAuth = false}) =>
      scope.session.api.vault.serial(() async {
        await load();
        final target = pendingTarget(marker), previous = entries[target];
        if (previous != null &&
            !(cancelOAuth && previous['kind'].toString().startsWith('oauth'))) {
          throw const ApiException('PENDING', 'mobileAppsUnknown');
        }
        if (previous == null && entries.length >= 21) {
          throw const ApiException('PENDING_LIMIT', 'mobileAppsStorage');
        }
        await _write({...entries, target: marker});
      });

  Future<void> resolve(Json marker) => scope.session.api.vault.serial(() async {
    await load();
    final target = pendingTarget(marker);
    if (entries[target]?['operationId'] != marker['operationId']) return;
    final next = {...entries}..remove(target);
    await _write(next);
  });
}
