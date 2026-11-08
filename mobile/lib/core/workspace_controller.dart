import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'app_session.dart';
import 'byte_read.dart';
import 'chat_draft.dart';
import 'events.dart';
import 'selected_attachment.dart';

class WorkspaceController extends ChangeNotifier {
  WorkspaceController(this.session)
    : userId = session.userId!,
      workspaceId = session.workspaceId!,
      stamp = session.api.generation;
  final AppSession session;
  final String userId;
  final String workspaceId;
  final int stamp;
  final _chatDrafts = <String, String>{};
  final _chatOptions = <String, ChatDraftOptions>{};
  final _attachmentDrafts = <String, List<SelectedAttachment>>{};
  final _inboundRevisions = <String, int>{};
  Json? data;
  bool loading = false;
  bool disconnected = false;
  String? error;
  bool _closed = false;
  bool _paused = false;
  int _eventsEpoch = 0;
  int _read = 0;
  Timer? _refreshTimer;
  EventConnection? _events;
  bool get active =>
      !_closed &&
      session.api.generation == stamp &&
      session.userId == userId &&
      session.workspaceId == workspaceId;
  bool get owner => session.workspace?['role'] == 'owner';
  bool get personalOwner =>
      active && owner && session.workspace?['kind'] == 'personal';
  String path(String suffix) => '/api/workspaces/$workspaceId$suffix';
  List<Json> items(String key) =>
      (data?[key] as List? ?? []).whereType<Json>().toList();
  Json? find(String key, String id) {
    for (final value in items(key)) {
      if (value['id'] == id) return value;
    }
    return null;
  }

  String chatDraft(String conversationId) =>
      active ? _chatDrafts[conversationId] ?? '' : '';

  void saveChatDraft(String conversationId, String text) {
    if (!active) return;
    if (text.isEmpty) {
      _chatDrafts.remove(conversationId);
    } else {
      _chatDrafts[conversationId] = text;
    }
  }

  ChatDraftOptions chatOptions(String conversationId) => active
      ? _chatOptions[conversationId] ?? emptyChatOptions
      : emptyChatOptions;

  void saveChatOptions(String conversationId, ChatDraftOptions options) {
    if (!active) return;
    if (options == emptyChatOptions) {
      _chatOptions.remove(conversationId);
    } else {
      _chatOptions[conversationId] = options;
    }
  }

  List<SelectedAttachment> attachmentDrafts(String draftKey) =>
      active ? _attachmentDrafts[draftKey] ?? const [] : const [];

  void saveAttachmentDrafts(String draftKey, List<SelectedAttachment> items) {
    if (!active) return;
    if (items.isEmpty) {
      _attachmentDrafts.remove(draftKey);
    } else {
      _attachmentDrafts[draftKey] = List.unmodifiable(items);
    }
  }

  int inboundDraftRevision(String draftKey) => _inboundRevisions[draftKey] ?? 0;

  int get sharedDraftBytes => _attachmentDrafts.values
      .expand((items) => items)
      .where((item) => item.receivedFromShare)
      .fold(0, (bytes, item) => bytes + item.size);

  void applyInboundDraft(
    String conversationId,
    String text,
    List<SelectedAttachment> files,
  ) {
    guard();
    if (find('conversations', conversationId) == null) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
    saveChatDraft(conversationId, text);
    saveAttachmentDrafts(conversationId, [
      ...attachmentDrafts(conversationId),
      ...files,
    ]);
    _inboundRevisions.update(
      conversationId,
      (revision) => revision + 1,
      ifAbsent: () => 1,
    );
    notifyListeners();
  }

  void acceptCreation(Json receipt) {
    guard();
    if (receipt['status'] != 'created' ||
        receipt['userId'] != userId ||
        receipt['workspaceId'] != workspaceId ||
        receipt['conversation'] is! Json ||
        receipt['agents'] is! List) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    final conversation = receipt['conversation'] as Json;
    if (conversation['id'] != receipt['conversationId']) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    final agents = items('agents');
    final conversations = items('conversations');
    for (final agent in (receipt['agents'] as List).whereType<Json>()) {
      if (!agents.any((a) => a['id'] == agent['id'])) agents.add(agent);
    }
    if (!conversations.any((c) => c['id'] == conversation['id'])) {
      conversations.add(conversation);
    }
    _read++;
    data = {...?data, 'agents': agents, 'conversations': conversations};
    notifyListeners();
  }

  void acceptMessageReactions(String conversationId, String id, Json receipt) {
    guard();
    if (receipt['id'] != id ||
        receipt['conversationId'] != conversationId ||
        receipt['reactions'] is! List ||
        receipt['reactionMembers'] is! Map) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    final messages = items('messages');
    final index = messages.indexWhere(
      (row) => row['id'] == id && row['conversationId'] == conversationId,
    );
    if (index < 0) return;
    messages[index] = {
      ...messages[index],
      'reactions': receipt['reactions'],
      'reactionMembers': receipt['reactionMembers'],
    };
    _read++;
    data = {...?data, 'messages': messages};
    notifyListeners();
  }

  void guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  Future<Json> request(String method, String suffix, {Json? body}) async {
    final value = await requestValue(method, suffix, body: body);
    if (value is! Json) {
      throw const ApiException('INVALID_RESPONSE', 'requestFailed');
    }
    return value;
  }

  Future<Object?> requestValue(
    String method,
    String suffix, {
    Json? body,
    ByteReadCancellation? cancellation,
  }) async {
    guard();
    final value = await session.api.requestValue(
      method,
      path(suffix),
      body: body,
      expectedUser: userId,
      isCurrent: () => active,
      cancellation: cancellation,
    );
    guard();
    return value;
  }

  Future<void> start() async {
    final epoch = ++_eventsEpoch;
    await refresh();
    if (active && !_paused && epoch == _eventsEpoch) unawaited(_listen(epoch));
  }

  void pause() {
    _paused = true;
    _eventsEpoch++;
    _refreshTimer?.cancel();
    _events?.close();
  }

  void resume() {
    if (!_paused || !active) return;
    _paused = false;
    unawaited(start());
  }

  Future<void> refresh() async {
    if (!active) return;
    final read = ++_read;
    loading = data == null;
    notifyListeners();
    try {
      final next = await request('GET', '/bootstrap');
      if (!active || read != _read) return;
      final oldSync = data?['sync'];
      final newSync = next['sync'];
      if (oldSync is Map &&
          newSync is Map &&
          oldSync['epoch'] == newSync['epoch'] &&
          oldSync['revision'] is num &&
          newSync['revision'] is num &&
          newSync['revision'] < oldSync['revision']) {
        return;
      }
      data = next;
      if (_chatDrafts.isNotEmpty ||
          _chatOptions.isNotEmpty ||
          _attachmentDrafts.isNotEmpty ||
          _inboundRevisions.isNotEmpty) {
        final conversations = items(
          'conversations',
        ).map((row) => row['id']).toSet();
        _chatDrafts.removeWhere(
          (key, _) => !conversations.contains(key.split(':').first),
        );
        _chatOptions.removeWhere(
          (key, _) => !conversations.contains(key.split(':').first),
        );
        _attachmentDrafts.removeWhere(
          (key, _) => !conversations.contains(key.split(':').first),
        );
        _inboundRevisions.removeWhere((key, _) => !conversations.contains(key));
      }
      error = null;
    } catch (e) {
      if (active && read == _read) {
        error = e is ApiException ? e.message : 'requestFailed';
        if (e is ApiException && (e.status == 401 || e.status == 403)) {
          unawaited(_lostAccess());
        }
      }
    } finally {
      if (active && read == _read) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> _lostAccess() async {
    try {
      await session.refresh();
    } catch (_) {
      if (active) session.selectWorkspace(null);
    }
  }

  void _scheduleRefresh() {
    if (!active) return;
    _read++;
    _refreshTimer?.cancel();
    _refreshTimer = Timer(
      const Duration(milliseconds: 180),
      () => unawaited(refresh()),
    );
  }

  Future<void> _listen(int epoch) async {
    var delay = 1;
    while (active && !_paused && epoch == _eventsEpoch) {
      final connection = EventConnection(session.api);
      _events = connection;
      try {
        await for (final event in connection.listen(path('/events'), userId)) {
          if (!active || _paused || epoch != _eventsEpoch) break;
          disconnected = false;
          delay = 1;
          if ([
            'sync',
            'connected',
            'message',
            'update',
            'message_updated',
          ].contains(event['type'])) {
            _scheduleRefresh();
          }
        }
      } catch (e) {
        if (active &&
            e is ApiException &&
            (e.status == 401 || e.status == 403)) {
          await _lostAccess();
          return;
        }
      } finally {
        connection.close();
      }
      if (!active || _paused || epoch != _eventsEpoch) return;
      disconnected = true;
      notifyListeners();
      await Future<void>.delayed(Duration(seconds: delay));
      delay = (delay * 2).clamp(1, 10).toInt();
    }
  }

  @override
  void dispose() {
    _closed = true;
    _chatDrafts.clear();
    _chatOptions.clear();
    _attachmentDrafts.clear();
    _inboundRevisions.clear();
    _read++;
    _refreshTimer?.cancel();
    _events?.close();
    super.dispose();
  }
}
