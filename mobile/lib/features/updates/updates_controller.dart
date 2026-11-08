import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';

bool validRepository(String value) =>
    RegExp(
      r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$',
    ).hasMatch(value) &&
    !value.split('/').first.contains('--') &&
    !['.', '..'].contains(value.split('/').last);

Json checkedUpdates(Json value, WorkspaceController scope) {
  bool date(Object? text) =>
      text is String && text.length <= 64 && DateTime.tryParse(text) != null;
  Never invalid() =>
      throw const ApiException('INVALID_UPDATES', 'mobileUpdatesInvalid');
  final identity = value['scope'];
  final version = value['serviceVersion'], repository = value['repository'];
  if (identity is! Json ||
      identity['userId'] != scope.userId ||
      identity['workspaceId'] != scope.workspaceId ||
      version is! String ||
      version.isEmpty ||
      version.length > 128 ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(version) ||
      ![
        'unconfigured',
        'unavailable',
        'current',
        'update_available',
        'unknownVersion',
      ].contains(value['status']) ||
      (repository != null &&
          (repository is! String || !validRepository(repository))) ||
      (value['checkedAt'] != null && !date(value['checkedAt'])) ||
      ![
        null,
        'not_checked',
        'network',
        'timeout',
        'rate_limited',
        'not_found',
        'invalid_release',
        'response_too_large',
      ].contains(value['reason'])) {
    invalid();
  }
  final release = value['release'];
  if (value['status'] == 'unconfigured' &&
      (repository != null || release != null)) {
    invalid();
  }
  if (release != null) {
    if (release is! Json || repository == null) invalid();
    final tag = release['tag'];
    if (tag is! String ||
        !RegExp(r'^[A-Za-z0-9._+-]{1,128}$').hasMatch(tag) ||
        ['.', '..'].contains(tag) ||
        release['url'] != 'https://github.com/$repository/releases/tag/$tag' ||
        release['name'] is! String ||
        (release['name'] as String).length > 400 ||
        release['notes'] is! String ||
        (release['notes'] as String).length > 64000 ||
        !date(release['publishedAt']) ||
        (release['version'] != null &&
            release['version'] != tag.replaceFirst(RegExp(r'^v'), ''))) {
      invalid();
    }
  }
  if ([
        'current',
        'update_available',
        'unknownVersion',
      ].contains(value['status']) &&
      (repository == null || release == null)) {
    invalid();
  }
  return value;
}

class UpdatesController extends ChangeNotifier {
  UpdatesController(this.scope);
  final WorkspaceController scope;
  Json? data;
  String? error;
  bool busy = false, _closed = false;
  bool get active => !_closed && scope.active;
  bool get canCheck => active && !busy && data?['repository'] != null;

  Future<void> read({bool check = false}) async {
    if (!active || busy || (check && !canCheck)) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      final result = checkedUpdates(
        await scope.request(
          check ? 'POST' : 'GET',
          '/updates',
          body: check ? {} : null,
        ),
        scope,
      );
      if (active) data = result;
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Uri? get releaseUri {
    if (!active || data == null) return null;
    checkedUpdates(data!, scope);
    final url = data!['release']?['url'];
    return url is String ? Uri.parse(url) : null;
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
