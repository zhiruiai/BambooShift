import 'dart:convert';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/request_ids.dart';

const teamStates = {'generating', 'ready', 'committed', 'cancelled', 'error'};
bool identifier(Object? value) =>
    value is String && RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(value);
bool boundedText(Object? value, int max, {bool empty = true}) =>
    value is String &&
    value.length <= max &&
    !value.contains('\u0000') &&
    (empty || value.trim().isNotEmpty);
Json copyJson(Json value) => jsonDecode(jsonEncode(value)) as Json;
String canonical(Object? value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${canonical(value[key])}').join(',')}}';
  }
  if (value is List) return '[${value.map(canonical).join(',')}]';
  return jsonEncode(value);
}

Json teamPlan(Object? value) {
  if (value is! Json ||
      !isRequestId(value['id']) ||
      !isRequestId(value['revision']) ||
      !isRequestId(value['requestId']) ||
      !teamStates.contains(value['status']) ||
      !boundedText(value['goal'], 6000, empty: false)) {
    throw const ApiException('INVALID_PLAN', 'mobileCollaborationInvalid');
  }
  if (value['draft'] != null &&
      draftProblem(value['draft'], const [], saved: true) != null) {
    throw const ApiException('INVALID_DRAFT', 'mobileCollaborationInvalid');
  }
  if (value['status'] == 'ready' && value['draft'] == null) {
    throw const ApiException('INVALID_DRAFT', 'mobileCollaborationInvalid');
  }
  if (value['status'] == 'committed') teamResult(value['result']);
  return copyJson(value);
}

Json teamResult(Object? value) {
  if (value is! Json ||
      !identifier(value['conversationId']) ||
      !identifier(value['leadAgentId']) ||
      value['memberAgentIds'] is! List ||
      value['createdAgentIds'] is! List ||
      !(value['memberAgentIds'] as List).every(identifier) ||
      !(value['createdAgentIds'] as List).every(identifier) ||
      (value['memberAgentIds'] as List).length > 6 ||
      !(value['memberAgentIds'] as List).contains(value['leadAgentId'])) {
    throw const ApiException('INVALID_RESULT', 'mobileCollaborationInvalid');
  }
  return value;
}

String? draftProblem(
  Object? value,
  List<Json> agents, {
  bool saved = false,
  bool commit = false,
}) {
  if (value is! Json ||
      !boundedText(value['title'], 100, empty: false) ||
      !boundedText(value['summary'], 2000, empty: false) ||
      value['members'] is! List) {
    return 'mobileCollaborationInvalid';
  }
  final members = value['members'] as List,
      keys = <String>{},
      used = <String>{},
      names = <String>{};
  if (members.length < (commit ? 2 : 1) || members.length > 6) {
    return 'mobileCollaborationCount';
  }
  for (final row in members) {
    if (row is! Json ||
        !identifier(row['key']) ||
        (row['key'] as String).length > 40 ||
        !keys.add(row['key']) ||
        !boundedText(row['assignment'], 2000, empty: false)) {
      return 'mobileCollaborationInvalid';
    }
    Json? profile;
    if (row['kind'] == 'reuse') {
      if (!identifier(row['agentId']) || !used.add(row['agentId'])) {
        return 'mobileCollaborationInvalid';
      }
      profile = agents.where((a) => a['id'] == row['agentId']).firstOrNull;
      if (commit && !botAvailable(profile)) {
        return 'mobileCollaborationBotMissing';
      }
    } else if (row['kind'] == 'create') {
      profile = row;
      if (!boundedText(row['name'], 40, empty: false) ||
          !boundedText(row['role'], 80, empty: false) ||
          !boundedText(row['description'], 1000) ||
          !boundedText(row['instructions'], 16000) ||
          !{
            'orb',
            'drop',
            'leaf',
            'spark',
            'gem',
            'arch',
          }.contains(row['avatar']) ||
          row['color'] is! String ||
          !RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(row['color']) ||
          (row['avatarImageId'] != null &&
              !isRequestId(row['avatarImageId'])) ||
          (row['modelProfileId'] != null &&
              !isRequestId(row['modelProfileId']))) {
        return 'mobileCollaborationInvalid';
      }
    } else {
      return 'mobileCollaborationInvalid';
    }
    if (!saved &&
        commit &&
        profile != null &&
        !names.add((profile['name'] as String).trim().toLowerCase())) {
      return 'mobileCollaborationDuplicate';
    }
  }
  return keys.contains(value['leadKey']) ? null : 'mobileCollaborationLead';
}

Json? teamCard(Json message) {
  if (message['role'] != 'assistant' ||
      message['kind'] != 'text' ||
      message['status'] != 'done' ||
      !identifier(message['id']) ||
      !identifier(message['agentId']) ||
      !identifier(message['conversationId'])) {
    return null;
  }
  final metadata = message['metadata'];
  final card = metadata is Json ? metadata['teamProposal'] : null;
  if (card is! Json ||
      !isRequestId(card['planId']) ||
      !isRequestId(card['revision']) ||
      !teamStates.contains(card['status']) ||
      !boundedText(card['goal'], 6000) ||
      !boundedText(card['title'], 100) ||
      !boundedText(card['summary'], 2000) ||
      card['members'] is! List ||
      (card['members'] as List).length > 6) {
    return null;
  }
  final keys = <String>{};
  for (final row in card['members'] as List) {
    if (row is! Json ||
        !identifier(row['key']) ||
        !keys.add(row['key']) ||
        !{'reuse', 'create'}.contains(row['kind']) ||
        !boundedText(row['name'], 40) ||
        !boundedText(row['role'], 80) ||
        !boundedText(row['assignment'], 2000) ||
        (row['agentId'] != null && !identifier(row['agentId']))) {
      return null;
    }
  }
  if (card['status'] == 'ready' && !keys.contains(card['leadKey'])) return null;
  try {
    if (card['result'] != null) teamResult(card['result']);
  } catch (_) {
    return null;
  }
  return card;
}
