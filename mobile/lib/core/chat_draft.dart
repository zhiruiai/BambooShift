import 'package:flutter/foundation.dart';

import 'api.dart';

typedef ChatAppPin = ({String connectionId, String revision});
typedef ChatDraftOptions = ({
  String? agentId,
  String? replyId,
  String? skillId,
  ChatAppPin? app,
  ChatGroupMentions? mentions,
});

const emptyChatOptions = (
  agentId: null,
  replyId: null,
  skillId: null,
  app: null,
  mentions: null,
);

extension ChatDraftChanges on ChatDraftOptions {
  ChatDraftOptions withReply(String? id) => (
    agentId: agentId,
    replyId: id,
    skillId: skillId,
    app: app,
    mentions: mentions,
  );

  ChatDraftOptions withSkill(String? id, {String? bot}) => (
    agentId: bot ?? agentId,
    replyId: replyId,
    skillId: id,
    app: app,
    mentions: mentions,
  );
}

String chatScopeKey(String conversationId, String? threadRootId) =>
    threadRootId == null ? conversationId : '$conversationId:$threadRootId';

String chatPendingPurpose(String userId, String workspaceId, String draftKey) =>
    'chat:$userId:$workspaceId:$draftKey';

String? chatThreadRoot(Json? message) {
  final root = message?['threadRootId'];
  return isChatReference(root) ? root as String : null;
}

Map<String, int> chatThreadCounts(
  Iterable<Json> messages,
  String conversation,
) {
  final counts = <String, int>{};
  for (final message in messages) {
    final root = chatThreadRoot(message);
    if (root != null &&
        message['conversationId'] == conversation &&
        message['role'] != 'system' &&
        message['kind'] != 'activity' &&
        message['kind'] != 'web_research') {
      counts.update(root, (count) => count + 1, ifAbsent: () => 1);
    }
  }
  return counts;
}

bool isChatReference(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(value);

ChatAppPin? chatAppPin(Object? value) {
  if (value is! Map) return null;
  final id = value['connectionId'], revision = value['revision'];
  if (!isChatReference(id) || !isChatReference(revision)) return null;
  return (connectionId: id as String, revision: revision as String);
}

Json appPinBody(ChatAppPin pin) => {
  'connectionId': pin.connectionId,
  'revision': pin.revision,
};

ChatAppPin? availableChatApp(Json app) {
  final count = app['toolCount'];
  if (app['status'] != 'connected' || count is! int || count <= 0) return null;
  return chatAppPin({'connectionId': app['id'], 'revision': app['revision']});
}

const maxChatMentionRecipients = 6;

class ChatGroupMentions {
  const ChatGroupMentions.everyone() : everyone = true, agentIds = const [];

  ChatGroupMentions.bots(Iterable<String> ids)
    : everyone = false,
      agentIds = List.unmodifiable(ids) {
    if (_agentIds(agentIds) == null) {
      throw ArgumentError('Invalid group mention recipients');
    }
  }

  final bool everyone;
  final List<String> agentIds;

  Json toBody() => everyone ? {'everyone': true} : {'agentIds': agentIds};

  @override
  bool operator ==(Object other) =>
      other is ChatGroupMentions &&
      other.everyone == everyone &&
      listEquals(other.agentIds, agentIds);

  @override
  int get hashCode => Object.hash(everyone, Object.hashAll(agentIds));
}

List<String>? _agentIds(Object? value) {
  if (value is! List ||
      value.isEmpty ||
      value.length > maxChatMentionRecipients ||
      !value.every(isChatReference) ||
      value.toSet().length != value.length) {
    return null;
  }
  return value.cast<String>();
}

ChatGroupMentions? chatGroupMentionRequest(Object? value) {
  if (value is! Map || value.length != 1) return null;
  if (value['everyone'] == true) return const ChatGroupMentions.everyone();
  final ids = _agentIds(value['agentIds']);
  return ids == null ? null : ChatGroupMentions.bots(ids);
}

typedef ChatGroupMentionReceipt = ({bool everyone, List<String> agentIds});

ChatGroupMentionReceipt? chatGroupMentionReceipt(Object? value) {
  if (value is! Map || value.length != (value['everyone'] == true ? 2 : 1)) {
    return null;
  }
  final ids = _agentIds(value['agentIds']);
  if (ids == null) return null;
  return (everyone: value['everyone'] == true, agentIds: ids);
}

bool groupMentionReceiptMatches(Object? receipt, Object? attempt) {
  if (attempt == null) return receipt == null;
  final expected = chatGroupMentionRequest(attempt);
  final actual = chatGroupMentionReceipt(receipt);
  return expected != null &&
      actual != null &&
      actual.everyone == expected.everyone &&
      (actual.everyone || listEquals(actual.agentIds, expected.agentIds));
}
