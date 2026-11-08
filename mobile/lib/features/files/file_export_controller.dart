import 'dart:ui';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../chat/file_preview_data.dart';

const fileExportLimit = 10 * 1024 * 1024;

enum FileExportResult { selected, dismissed, unknown, saved }

abstract interface class FileExportDestination {
  bool get supported;
  Future<FileExportResult> export(
    FileBytes data,
    String name,
    Rect origin, {
    required Future<void> Function() authorize,
    required void Function() guard,
  });
}

class FileExportController extends ChangeNotifier {
  FileExportController(
    this.scope,
    this.conversationId,
    this.file,
    this.destination,
  ) {
    scope.addListener(changed);
    scope.session.addListener(changed);
  }
  final WorkspaceController scope;
  final String? conversationId;
  final ChatFile file;
  final FileExportDestination destination;
  bool busy = false, _closed = false;
  String? error, notice;
  String? _version;
  ByteReadCancellation? _cancel;

  List<Json> _items(Json? data, String kind) =>
      (data?[kind] as List? ?? []).whereType<Json>().toList();

  Json? _registered(Json? data) {
    final files = _items(data, 'files').where((v) => v['id'] == file.id);
    final value = files.length == 1 ? files.single : null;
    if (value == null ||
        value['name'] is! String ||
        value['size'] != file.size ||
        (value['name'] as String).split(RegExp(r'[/\\]')).last != file.name) {
      return null;
    }
    if (conversationId == null) {
      return value['conversationId'] == null ? value : null;
    }
    if (!_items(data, 'conversations').any((c) => c['id'] == conversationId)) {
      return null;
    }
    if (value['conversationId'] != conversationId &&
        !(value['conversationId'] == null &&
            _items(data, 'messages').any(
              (m) =>
                  m['kind'] == 'file' &&
                  m['conversationId'] == conversationId &&
                  m['metadata'] is Map &&
                  m['metadata']['fileId'] == file.id,
            ))) {
      return null;
    }
    return value;
  }

  Json? get registered => _registered(scope.data);
  String? _fileVersion(Json? value) {
    if (value == null) return null;
    return [
      value['id'],
      value['name'],
      value['size'],
      value['type'],
      value['createdAt'],
      value['conversationId'],
    ].map((v) => '$v').join('\u0000');
  }

  String? get version => _fileVersion(registered);

  bool get active => !_closed && scope.active && registered != null;
  bool get canExport =>
      active &&
      !busy &&
      destination.supported &&
      file.size >= 0 &&
      file.size <= fileExportLimit;
  void guard() {
    if (!active ||
        _cancel?.cancelled == true ||
        (_version != null && version != _version)) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  void changed() {
    if (!active || (busy && _version != null && version != _version)) {
      _cancel?.cancel();
    }
    if (!_closed) notifyListeners();
  }

  Future<void> authorize() async {
    guard();
    final latest = await scope.requestValue(
      'GET',
      '/bootstrap',
      cancellation: _cancel,
    );
    guard();
    if (latest is! Json || _fileVersion(_registered(latest)) != _version) {
      throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
    }
  }

  Future<void> export(Rect origin) async {
    if (!canExport) return;
    busy = true;
    error = notice = null;
    _version = version;
    _cancel = ByteReadCancellation();
    notifyListeners();
    try {
      await authorize();
      final bytes = await scope.session.api.downloadWorkspaceFile(
        scope.workspaceId,
        file.id,
        expectedUser: scope.userId,
        isCurrent: () => active && version == _version,
        cancellation: _cancel!,
      );
      guard();
      if (bytes.bytes.length != file.size) {
        throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
      }
      await authorize();
      final result = await destination.export(
        bytes,
        file.name,
        origin,
        authorize: authorize,
        guard: guard,
      );
      guard();
      notice = switch (result) {
        FileExportResult.selected => 'mobileFilesExportSelected',
        FileExportResult.dismissed => 'mobileFilesExportDismissed',
        FileExportResult.unknown => 'mobileFilesExportUnknown',
        FileExportResult.saved => 'mobileFilesExportSaved',
      };
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'mobileFilesExportFailed';
      }
    } finally {
      busy = false;
      _version = null;
      if (!_closed) notifyListeners();
    }
  }

  void cancel() {
    _cancel?.cancel();
  }

  @override
  void dispose() {
    _closed = true;
    _cancel?.cancel();
    scope.removeListener(changed);
    scope.session.removeListener(changed);
    super.dispose();
  }
}
