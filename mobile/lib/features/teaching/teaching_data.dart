import 'dart:convert';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

const teachingStates = {
  'recording',
  'review',
  'interrupted',
  'generating',
  'proposed',
  'error',
};
const teachingActions = {
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'key',
  'type',
  'navigate',
  'back',
};
bool teachingText(Object? v, int length) =>
    v is String && v.length <= length && !v.contains('\u0000');
Never invalidTeaching() =>
    throw const ApiException('INVALID_TEACHING', 'mobileTeachingInvalid');
Json teachingRecord(
  Object? raw,
  String agent, {
  String? conversation,
  String? id,
}) {
  if (raw is! Json ||
      !isRequestId(raw['id']) ||
      !isRequestId(raw['revision']) ||
      (id != null && raw['id'] != id) ||
      raw['agentId'] != agent ||
      raw['conversationId'] is! String ||
      (conversation != null && raw['conversationId'] != conversation) ||
      !teachingStates.contains(raw['status']) ||
      !teachingText(raw['goal'], 2000) ||
      raw['interrupted'] is! bool ||
      raw['screen'] is! Json ||
      raw['steps'] is! List ||
      (raw['steps'] as List).length > 60 ||
      DateTime.tryParse(raw['createdAt'] as String? ?? '') == null ||
      (raw['generationRequestId'] != null &&
          !isRequestId(raw['generationRequestId'])) ||
      (raw['skillId'] != null && !isRequestId(raw['skillId'])) ||
      utf8.encode(jsonEncode(raw)).length > 65536) {
    invalidTeaching();
  }
  final screen = raw['screen'] as Json;
  if (!['browser', 'desktop'].contains(screen['surface']) ||
      !isRequestId(screen['instanceId']) ||
      (screen['screenId'] != null &&
          (!teachingText(screen['screenId'], 128) ||
              (screen['screenId'] as String).isEmpty)) ||
      [
        'revision',
        'generation',
      ].any((field) => screen[field] != null && !isRequestId(screen[field]))) {
    invalidTeaching();
  }
  final ids = <String>{};
  for (final step in raw['steps'] as List) {
    if (step is! Json ||
        !isRequestId(step['id']) ||
        !ids.add(step['id']) ||
        !teachingActions.contains(step['action']) ||
        !teachingText(step['note'], 1000) ||
        DateTime.tryParse(step['recordedAt'] as String? ?? '') == null) {
      invalidTeaching();
    }
    final details = step['details'];
    if (details != null &&
        (details is! Json ||
            details.keys.any(
              (k) => !{
                'x',
                'y',
                'toX',
                'toY',
                'deltaX',
                'deltaY',
                'key',
                'destination',
              }.contains(k),
            ))) {
      invalidTeaching();
    }
    if (details is Json) {
      for (final value in details.values) {
        if ((value is num && !value.isFinite) ||
            (value is! num && !teachingText(value, 1000))) {
          invalidTeaching();
        }
      }
    }
  }
  return jsonDecode(jsonEncode(raw)) as Json;
}

String? teachingConversation(WorkspaceController scope, String agent) {
  final bot = scope.find('agents', agent);
  if (!scope.active || !scope.owner || bot == null || isManagedBot(bot)) {
    return null;
  }
  final chats = scope
      .items('conversations')
      .where(
        (c) =>
            c['isGroup'] != true &&
            c['agentIds'] is List &&
            (c['agentIds'] as List).length == 1 &&
            c['agentIds'][0] == agent,
      )
      .toList();
  return chats.length == 1 ? chats.single['id'] as String? : null;
}

Json teachingReview(Json value) => {
  'goal': value['goal'],
  'steps': [
    for (final step in value['steps'] as List)
      {'id': step['id'], 'note': step['note']},
  ],
};
String teachingFingerprint(Json value) => jsonEncode({
  for (final field in [
    'id',
    'name',
    'provider',
    'model',
    'baseUrl',
    'vision',
    'configured',
    'hasApiKey',
  ])
    field: value[field],
});
