import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../voice/voice_memo_data.dart';

const chatReactions = ['👍', '❤️', '🎉', '👀', '✅'];
const _rejectedMentionRequests = {
  'CHAT_MENTIONS_INVALID': 'chatMentionsInvalid',
  'CHAT_MENTIONS_GROUP_REQUIRED': 'chatMentionsInvalid',
  'CHAT_MENTIONS_TOO_MANY': 'chatMentionsTooMany',
  'CHAT_MENTION_UNAVAILABLE': 'chatMentionUnavailable',
};

List<Object?> reactionMembers(Json message, String emoji) {
  final reactions = message['reactionMembers'];
  final members = reactions is Map ? reactions[emoji] : null;
  return members is List ? members : const [];
}

class ChatController extends ChangeNotifier {
  ChatController(
    this.scope,
    this.conversationId, {
    this.threadRootId,
    this.onAccepted,
  }) : _origin = scope.session.api.server!.origin;
  final WorkspaceController scope;
  final String conversationId;
  final String? threadRootId;
  final Future<void> Function(String content)? onAccepted;
  Json? pending, lastReceipt;
  bool busy = false;
  bool ready = false;
  String? error;
  final reactionPending = <String>{};
  bool _closed = false;
  bool get active => !_closed && scope.active;
  void _guard() {
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  final String _origin;
  String get _purpose =>
      chatPendingPurpose(scope.userId, scope.workspaceId, draftKey);
  String get draftKey => chatScopeKey(conversationId, threadRootId);
  List<Json> get messages => scope
      .items('messages')
      .where(
        (m) =>
            m['conversationId'] == conversationId &&
            (chatThreadRoot(m) == threadRootId ||
                (threadRootId != null && m['id'] == threadRootId)),
      )
      .toList();
  Future<void> initialize() async {
    try {
      final saved = await scope.session.api.vault.read(_origin, _purpose);
      if (!active) return;
      if (saved != null) {
        final value = jsonDecode(saved);
        if (value is! Json ||
            !isRequestId(value['clientId']) ||
            value['content'] is! String ||
            (value['content'] as String).isEmpty ||
            (value['content'] as String).length > 32000 ||
            value['mode'] != 'followUp' ||
            value['threadRootId'] != threadRootId ||
            (value.containsKey('voiceCallId') &&
                (!isRequestId(value['voiceCallId']) ||
                    threadRootId != null ||
                    [
                      'agentId',
                      'replyToMessageId',
                      'appContext',
                      'mentions',
                    ].any(value.containsKey))) ||
            (value.containsKey('requestVoiceMemo') &&
                (value['requestVoiceMemo'] != true ||
                    threadRootId != null ||
                    [
                      'agentId',
                      'replyToMessageId',
                      'appContext',
                      'mentions',
                      'voiceCallId',
                    ].any(value.containsKey))) ||
            (value.containsKey('agentId') &&
                !isChatReference(value['agentId'])) ||
            (value.containsKey('replyToMessageId') &&
                !isChatReference(value['replyToMessageId'])) ||
            (value.containsKey('appContext') &&
                chatAppPin(value['appContext']) == null) ||
            (value.containsKey('mentions') &&
                (chatGroupMentionRequest(value['mentions']) == null ||
                    value.containsKey('agentId') ||
                    value.containsKey('appContext')))) {
          throw const ApiException('INVALID_PENDING', 'requestFailed');
        }
        pending = value;
      }
      ready = true;
      if (pending != null) await check();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    }
    if (active) notifyListeners();
  }

  Future<bool> send(
    String text, {
    String? agentId,
    String? replyToMessageId,
    ChatAppPin? app,
    ChatGroupMentions? mentions,
    String? voiceCallId,
    bool requestVoiceMemo = false,
  }) async {
    if (!active || busy || !ready || pending != null || text.trim().isEmpty) {
      return false;
    }
    if (mentions != null &&
        (agentId != null ||
            app != null ||
            scope.find('conversations', conversationId)?['isGroup'] != true)) {
      return false;
    }
    if (voiceCallId != null &&
        (!isRequestId(voiceCallId) ||
            threadRootId != null ||
            agentId != null ||
            replyToMessageId != null ||
            app != null ||
            mentions != null ||
            scope.find('conversations', conversationId)?['isGroup'] == true)) {
      return false;
    }
    if (requestVoiceMemo &&
        (voiceCallId != null ||
            threadRootId != null ||
            agentId != null ||
            replyToMessageId != null ||
            app != null ||
            mentions != null ||
            !canRequestVoiceMemo(
              scope,
              conversationId,
              threadRootId,
              emptyChatOptions,
            ))) {
      return false;
    }
    lastReceipt = null;
    pending = {
      'clientId': requestId(),
      'content': text,
      'mode': 'followUp',
      'voiceCallId': ?voiceCallId,
      if (requestVoiceMemo) 'requestVoiceMemo': true,
      'agentId': ?agentId,
      'replyToMessageId': ?(replyToMessageId ?? threadRootId),
      'threadRootId': ?threadRootId,
      if (app != null) 'appContext': appPinBody(app),
      if (mentions != null) 'mentions': mentions.toBody(),
    };
    busy = true;
    error = null;
    notifyListeners();
    try {
      await scope.session.api.vault.write(
        _origin,
        _purpose,
        jsonEncode(pending),
        allowed: () => active,
      );
      _guard();
      return await _post();
    } catch (e) {
      await _sendError(e);
      return false;
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<bool> _post() async {
    final attempt = pending!;
    await scope.session.api.vault.write(
      _origin,
      _purpose,
      jsonEncode(attempt),
      allowed: () => active,
    );
    _guard();
    final response = await scope.request(
      'POST',
      '/conversations/$conversationId/messages',
      body: attempt,
    );
    _guard();
    final message = response['message'];
    if (message is! Json || !_matches(message, attempt)) {
      throw const ApiException('INVALID_RESPONSE', 'requestUnknown');
    }
    await _complete(message);
    await scope.refresh();
    return true;
  }

  bool _matches(Json message, Json attempt) {
    final delivery = message['delivery'], reply = message['replyTo'];
    final metadata = message['metadata'];
    final voiceId = metadata is Map ? metadata['voiceCallId'] : null;
    final memo = metadata is Map && metadata['requestVoiceMemo'] == true;
    return message['conversationId'] == conversationId &&
        message['role'] == 'user' &&
        voiceId == attempt['voiceCallId'] &&
        memo == (attempt['requestVoiceMemo'] == true) &&
        (attempt['voiceCallId'] == null || isChatReference(message['id'])) &&
        message['userId'] == scope.userId &&
        message['threadRootId'] == attempt['threadRootId'] &&
        delivery is Map &&
        delivery['clientId'] == attempt['clientId'] &&
        delivery['explicitAgentId'] == attempt['agentId'] &&
        (reply is Map ? reply['id'] : null) == attempt['replyToMessageId'] &&
        chatAppPin(message['appContext']) ==
            chatAppPin(attempt['appContext']) &&
        groupMentionReceiptMatches(message['mentions'], attempt['mentions']);
  }

  Future<void> _sendError(Object cause) async {
    if (!active) return;
    final rejection = cause is ApiException
        ? _rejectedMentionRequests[cause.code] ??
              switch (cause.code) {
                'APP_CONTEXT_UNAVAILABLE' ||
                'APP_CONTEXT_LOCAL_BOT_ONLY' => 'chatAppChanged',
                'THREAD_CONTEXT_UNAVAILABLE' => 'chatThreadUnavailable',
                'VOICE_CALL_ENDED' || 'VOICE_CALL_NOT_FOUND' => 'voiceEnded',
                'VOICE_CALL_BUSY' || 'VOICE_CALL_ACTIVE' => 'voiceBusy',
                'VOICE_MEMO_INVALID' ||
                'VOICE_MEMO_SCOPE' ||
                'VOICE_MEMO_UNAVAILABLE' => 'voiceMemoRequestUnavailable',
                'VOICE_CALL_INVALID' ||
                'VOICE_CALL_UNAVAILABLE' => 'voiceUnavailable',
                _ => null,
              }
        : null;
    if (rejection != null) {
      // These rejections come after the server checks for an existing receipt.
      try {
        await scope.session.api.vault.delete(_origin, _purpose);
        if (!active) return;
        pending = null;
        error = rejection;
      } catch (_) {
        if (active) error = 'requestUnknown';
      }
      return;
    }
    error = cause is ApiException ? cause.message : 'requestFailed';
  }

  Future<void> react(String id, String emoji) async {
    if (!active || !isChatReference(id) || !chatReactions.contains(emoji)) {
      return;
    }
    final row = scope.find('messages', id);
    if (row == null ||
        row['conversationId'] != conversationId ||
        !reactionPending.add(id)) {
      return;
    }
    error = null;
    notifyListeners();
    try {
      final receipt = await scope.request(
        'POST',
        '/messages/$id/reactions',
        body: {
          'emoji': emoji,
          'active': !reactionMembers(row, emoji).contains(scope.userId),
        },
      );
      if (active) scope.acceptMessageReactions(conversationId, id, receipt);
    } catch (cause) {
      if (active) {
        error = cause is ApiException ? cause.message : 'requestFailed';
      }
    } finally {
      reactionPending.remove(id);
      if (active) notifyListeners();
    }
  }

  Future<void> _complete(Json receipt) async {
    _guard();
    final content = pending!['content'] as String;
    try {
      if (pending?['voiceCallId'] == null) await onAccepted?.call(content);
    } catch (_) {
      // Local presentation cleanup cannot undo an accepted message.
    }
    _guard();
    await scope.session.api.vault.delete(_origin, _purpose);
    if (active) {
      pending = null;
      lastReceipt = receipt;
      error = null;
    }
  }

  Future<void> check() async {
    if (!active || busy || pending == null) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await scope.refresh();
      if (!active) return;
      final receipt = messages.where((m) => _matches(m, pending!)).firstOrNull;
      if (receipt != null) await _complete(receipt);
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestFailed';
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> retry() async {
    if (!active || busy || pending == null) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await _post();
    } catch (e) {
      await _sendError(e);
    } finally {
      if (active) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> stop() async {
    if (!active || busy) return;
    try {
      final query = threadRootId == null
          ? 'scope=main'
          : 'threadRootId=${Uri.encodeQueryComponent(threadRootId!)}';
      await scope.request('POST', '/conversations/$conversationId/stop?$query');
      await scope.refresh();
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'requestFailed';
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
