import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/chat_draft.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'attachment_data.dart';
import 'attachment_selection.dart';
import 'attachment_storage.dart';

class AttachmentController extends ChangeNotifier {
  AttachmentController(
    this.scope,
    this.conversationId, {
    AttachmentPicker? picker,
    bool Function()? isEditable,
    String? threadRootId,
  }) : picker = picker ?? pickAttachment,
       editable = isEditable ?? (() => true),
       draftKey = chatScopeKey(conversationId, threadRootId),
       storage = AttachmentStorage(scope, conversationId, threadRootId) {
    scope.session.addListener(changed);
    scope.addListener(changed);
  }
  final WorkspaceController scope;
  final String conversationId;
  final AttachmentPicker picker;
  final bool Function() editable;
  final AttachmentStorage storage;
  final String draftKey;
  final cancellation = ByteReadCancellation();
  List<SelectedAttachment> get selections => scope.attachmentDrafts(draftKey);
  SelectedAttachment? get selected => selections.firstOrNull;
  bool ready = false, busy = false, _closed = false;
  String? error;
  List<Json> candidates = [];
  Json? get pending => storage.pending;
  List<Json> get files => storage.files;
  bool get active =>
      !_closed &&
      scope.active &&
      scope.find('conversations', conversationId) != null;
  bool get canEdit => active && ready && !busy && editable();
  bool get canPick =>
      canEdit &&
      pending == null &&
      files.length + selections.length < attachmentCount;
  bool get canUpload =>
      canEdit &&
      pending == null &&
      files.length < attachmentCount &&
      selections.isNotEmpty;
  bool get blocksSend =>
      !ready || busy || pending != null || selections.isNotEmpty;
  void guard() {
    if (!active || cancellation.cancelled) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  void changed() {
    if (!active) {
      cancellation.cancel();
      candidates = [];
    }
    if (!_closed) notifyListeners();
  }

  void notify() {
    if (active) notifyListeners();
  }

  Future<void> initialize() async {
    try {
      guard();
      await storage.load();
      guard();
      ready = true;
      if (pending != null || files.isNotEmpty) await check();
    } catch (_) {
      if (active) error = 'requestUnknown';
    }
    notify();
  }

  Future<void> choose() async {
    if (!canPick) return;
    busy = true;
    error = null;
    notify();
    try {
      final next = await picker();
      guard();
      if (!editable()) return;
      if (next != null) {
        attachmentName(next.name);
        if (next.size < 0 || next.size > attachmentLimit) {
          throw const ApiException('FILE_TOO_LARGE', 'mobileFilesLimit');
        }
        if (files.length + selections.length >= attachmentCount) {
          throw const ApiException('FILE_LIMIT', 'mobileFilesLimit');
        }
        scope.saveAttachmentDrafts(draftKey, [...selections, next]);
      }
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'mobileFilesReadFailed';
      }
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  void removeSelection([SelectedAttachment? selection]) {
    if (canEdit) {
      _removeSelection(selection ?? selected);
      error = null;
      notify();
    }
  }

  void _removeSelection(SelectedAttachment? selection) =>
      scope.saveAttachmentDrafts(
        draftKey,
        selections.where((item) => !identical(item, selection)).toList(),
      );

  Future<void> removeFile(String id) async {
    if (!canEdit) return;
    try {
      await storage.remove({id});
      guard();
    } catch (_) {
      if (active) error = 'requestUnknown';
    }
    notify();
  }

  Future<void> _refresh() async {
    await scope.refresh();
    guard();
    if (scope.error != null) {
      throw const ApiException('READ_FAILED', 'requestFailed');
    }
    candidates = [];
    final marker = pending;
    if (marker == null) return;
    final authored = scope
        .items('messages')
        .where(
          (m) =>
              m['conversationId'] == conversationId &&
              m['role'] == 'user' &&
              m['kind'] == 'file' &&
              m['userId'] == scope.userId,
        )
        .map((m) => m['metadata'] is Map ? m['metadata']['fileId'] : null)
        .toSet();
    for (final file in scope.items('files')) {
      if (!authored.contains(file['id']) ||
          (marker['baseline'] as List).contains(file['id']) ||
          !possibleAttachment(file, marker)) {
        continue;
      }
      candidates.add(attachmentFile(file, conversationId));
    }
  }

  Future<void> check() async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notify();
    try {
      await storage.load();
      guard();
      await _refresh();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<bool> upload([SelectedAttachment? requested]) async {
    final selection = requested ?? selected;
    if (!canUpload || selection == null || !selections.contains(selection)) {
      return false;
    }
    busy = true;
    error = null;
    notify();
    try {
      final bytes = await readAttachment(selection, cancellation, guard);
      guard();
      if (!editable()) return false;
      await _refresh();
      if (!editable() || !selections.contains(selection)) return false;
      final marker = <String, dynamic>{
        'operationId': requestId(),
        'userId': scope.userId,
        'workspaceId': scope.workspaceId,
        'conversationId': conversationId,
        'name': selection.name,
        'size': bytes.length,
        'type': attachmentType(selection.type),
        'sha256': sha256.convert(bytes).toString(),
        'baseline': scope
            .items('files')
            .where((f) => f['conversationId'] == conversationId)
            .map((f) => f['id'])
            .toList(),
      };
      if ((marker['baseline'] as List).length > 2000) {
        throw const ApiException('FILE_LIMIT', 'mobileFilesRecoveryLimit');
      }
      await storage.claim(marker);
      guard();
      _removeSelection(selection);
      if (!editable()) {
        throw const ApiException('DRAFT_CHANGED', 'requestUnknown');
      }
      final value = await scope.requestValue(
        'POST',
        '/files',
        body: {
          'name': marker['name'],
          'type': marker['type'],
          'content': base64Encode(bytes),
          'conversationId': conversationId,
        },
        cancellation: cancellation,
      );
      guard();
      final file = attachmentFile(value, conversationId);
      if (!possibleAttachment(file, marker)) {
        throw const ApiException('INVALID_FILE', 'requestUnknown');
      }
      await storage.complete(marker, file);
      guard();
      try {
        await _refresh();
      } catch (_) {
        guard();
        error = 'requestFailed';
      }
      return true;
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestUnknown';
        if (e is ApiException && e.code == 'PENDING') {
          try {
            await storage.load();
            guard();
          } catch (_) {
            if (active) error = 'requestUnknown';
          }
        }
      }
      return false;
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<void> useCandidate(String id) async {
    if (!canEdit || pending == null) return;
    final marker = pending!;
    busy = true;
    error = null;
    notify();
    try {
      await _refresh();
      guard();
      final file = candidates.where((f) => f['id'] == id).firstOrNull;
      if (file == null) {
        throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
      }
      await storage.complete(marker, file);
      guard();
      candidates = [];
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  Future<void> abandon() async {
    if (!canEdit || pending == null) return;
    final marker = pending!;
    busy = true;
    error = null;
    notify();
    try {
      await _refresh();
      guard();
      await storage.abandon(marker);
      guard();
      candidates = [];
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (active) {
        busy = false;
        notify();
      }
    }
  }

  String compose(String text) {
    guard();
    if (blocksSend) {
      throw const ApiException('PENDING_FILE', 'mobileFilesUploadFirst');
    }
    for (final file in files) {
      final current = scope.find('files', file['id']);
      if (current == null ||
          current['conversationId'] != conversationId ||
          current['name'] != file['name'] ||
          current['size'] != file['size']) {
        throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
      }
    }
    return [
      text.trim(),
      ...files.map((f) => attachmentReference(f, scope.workspaceId)),
    ].where((s) => s.isNotEmpty).join('\n');
  }

  Future<void> acknowledgeSent(String content) async {
    if (!active) return;
    try {
      await storage.load();
      guard();
      await storage.remove(
        files
            .where(
              (f) =>
                  content.contains(attachmentReference(f, scope.workspaceId)),
            )
            .map((f) => f['id'] as String)
            .toSet(),
      );
      guard();
      notify();
    } catch (_) {
      if (active) {
        error = 'requestUnknown';
        notify();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    cancellation.cancel();
    scope.session.removeListener(changed);
    scope.removeListener(changed);
    super.dispose();
  }
}
