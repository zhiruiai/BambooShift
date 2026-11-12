import 'dart:convert';
import 'dart:ui';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../files/file_export_controller.dart';

class ConversationExportController extends ChangeNotifier {
  ConversationExportController(
    this.scope,
    this.conversationId,
    this.destination,
  ) {
    scope.addListener(changed);
    scope.session.addListener(changed);
  }
  final WorkspaceController scope;
  final String conversationId;
  final FileExportDestination destination;
  bool busy = false, _closed = false;
  String? error, notice;
  int? messageCount;
  String? _filename;
  FileBytes? _data;
  ByteReadCancellation? _cancel;
  String get path =>
      '/conversations/${Uri.encodeComponent(conversationId)}/export';
  bool get active =>
      !_closed &&
      scope.active &&
      scope.find('conversations', conversationId) != null;
  bool get canExport =>
      active && !busy && _data != null && destination.supported;
  void guard() {
    if (!active || _cancel?.cancelled == true) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  void changed() {
    if (!active) {
      _cancel?.cancel();
      _data = null;
      messageCount = null;
    }
    if (!_closed) notifyListeners();
  }

  Future<void> authorize() async {
    guard();
    await scope.requestValue('HEAD', path, cancellation: _cancel);
    guard();
  }

  Future<void> prepare(String language) async {
    if (!active || busy) return;
    busy = true;
    error = notice = null;
    _data = null;
    messageCount = null;
    _cancel = ByteReadCancellation();
    notifyListeners();
    try {
      final value = await scope.requestValue(
        'GET',
        '$path?language=$language',
        cancellation: _cancel,
      );
      guard();
      if (value is! Json ||
          value['conversationId'] != conversationId ||
          value['complete'] != true ||
          value['content'] is! String ||
          value['filename'] is! String ||
          !RegExp(
            r'^conversation-[a-zA-Z0-9-]+\.md$',
          ).hasMatch(value['filename'] as String) ||
          value['messageCount'] is! int ||
          (value['messageCount'] as int) < 0 ||
          value['exportedAt'] is! String ||
          DateTime.tryParse(value['exportedAt'] as String) == null) {
        throw const ApiException('INVALID_CONVERSATION_EXPORT', 'exportFailed');
      }
      final bytes = utf8.encode(value['content'] as String);
      if (bytes.length > fileExportLimit) {
        throw const ApiException(
          'CONVERSATION_EXPORT_TOO_LARGE',
          'exportTooLarge',
        );
      }
      _data = FileBytes(
        Uint8List.fromList(bytes),
        'text/markdown;charset=utf-8',
      );
      _filename = value['filename'] as String;
      messageCount = value['messageCount'] as int;
    } catch (e) {
      failure(e);
    } finally {
      busy = false;
      if (!_closed) notifyListeners();
    }
  }

  void failure(Object e) {
    if (!active || _cancel?.cancelled == true) return;
    error = e is ApiException && e.code == 'CONVERSATION_EXPORT_TOO_LARGE'
        ? 'exportTooLarge'
        : 'exportFailed';
  }

  Future<void> export(Rect origin) async {
    if (!canExport) return;
    busy = true;
    error = notice = null;
    _cancel = ByteReadCancellation();
    notifyListeners();
    try {
      await authorize();
      final result = await destination.export(
        _data!,
        _filename!,
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
      failure(e);
    } finally {
      busy = false;
      if (!_closed) notifyListeners();
    }
  }

  void cancel() {
    _cancel?.cancel();
    _data = null;
    messageCount = null;
    notice = 'exportCancelled';
    if (!_closed) notifyListeners();
  }

  @override
  void dispose() {
    _closed = true;
    _cancel?.cancel();
    _data = null;
    scope.removeListener(changed);
    scope.session.removeListener(changed);
    super.dispose();
  }
}
