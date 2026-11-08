import '../../core/api.dart';
import '../../core/bot_access.dart';

Json rosterTarget(Json conversation) {
  final ids = conversation['agentIds'] as List? ?? [];
  final single = conversation['isGroup'] != true && ids.length == 1;
  return {
    'kind': single ? 'bot' : 'conversation',
    'id': single ? ids.first : conversation['id'],
  };
}

String rosterKey(Json target) => '${target['kind']}:${target['id']}';

Json readRoster(Object? value) {
  if (value is! Json ||
      value['revision'] is! String ||
      value['sections'] is! List ||
      value['entries'] is! List) {
    throw const ApiException('INVALID_ROSTER', 'requestFailed');
  }
  final ids = <String>{};
  for (final section in value['sections'] as List) {
    if (section is! Json ||
        section['id'] is! String ||
        section['name'] is! String ||
        section['collapsed'] is! bool ||
        !ids.add(section['id'] as String)) {
      throw const ApiException('INVALID_ROSTER', 'requestFailed');
    }
  }
  final targets = <String>{};
  for (final entry in value['entries'] as List) {
    if (entry is! Json ||
        entry['target'] is! Json ||
        !['bot', 'conversation'].contains(entry['target']['kind']) ||
        entry['target']['id'] is! String ||
        entry['pinned'] is! bool ||
        entry['hidden'] is! bool ||
        (entry['sectionId'] != null && entry['sectionId'] is! String) ||
        !targets.add(rosterKey(entry['target'] as Json))) {
      throw const ApiException('INVALID_ROSTER', 'requestFailed');
    }
  }
  return value;
}

Json rosterEntry(Json conversation, Json? state) {
  final target = rosterTarget(conversation);
  for (final entry in (state?['entries'] as List? ?? []).whereType<Json>()) {
    if (entry['target'] is Json &&
        rosterKey(entry['target'] as Json) == rosterKey(target)) {
      return entry;
    }
  }
  return {
    'target': target,
    'pinned': state == null && conversation['pinned'] == true,
    'hidden': false,
    'sectionId': null,
  };
}

class RosterSection {
  RosterSection(this.value);
  final Json value;
  final List<Json> conversations = [];
}

class RosterProjection {
  RosterProjection(Json data, {Json? state}) {
    state ??= data['sidebarRoster'] is Json
        ? data['sidebarRoster'] as Json
        : null;
    final chats = (data['conversations'] as List? ?? []).whereType<Json>();
    final bots = (data['agents'] as List? ?? []).whereType<Json>();
    final primaryState = data['primaryBot'];
    if (primaryState is Json && primaryState['available'] == true) {
      final bot = bots.where((b) => b['id'] == primaryState['agentId']);
      if (bot.length == 1 && !isManagedBot(bot.single)) {
        for (final chat in chats) {
          final ids = chat['agentIds'] as List? ?? [];
          if (chat['id'] == primaryState['conversationId'] &&
              chat['isGroup'] != true &&
              ids.length == 1 &&
              ids.single == primaryState['agentId']) {
            primary = chat;
          }
        }
      }
    }
    sections.addAll(
      (state?['sections'] as List? ?? []).whereType<Json>().map(
        RosterSection.new,
      ),
    );
    final sectionMap = {for (final s in sections) s.value['id']: s};
    final hiddenMap = <String, Json>{};
    for (final chat in chats) {
      final entry = rosterEntry(chat, state);
      if (entry['hidden'] == true) {
        final key = rosterKey(rosterTarget(chat));
        final prior = hiddenMap[key];
        if (prior == null ||
            chat['id'] == primary?['id'] ||
            (prior['id'] != primary?['id'] && _time(chat) > _time(prior))) {
          hiddenMap[key] = chat;
        }
      } else if (chat['id'] == primary?['id'] &&
          entry['pinned'] != true &&
          entry['sectionId'] == null) {
        standalone = chat;
      } else if (entry['pinned'] == true) {
        pinned.add(chat);
      } else if (sectionMap.containsKey(entry['sectionId'])) {
        sectionMap[entry['sectionId']]!.conversations.add(chat);
      } else {
        ungrouped.add(chat);
      }
    }
    int order(Json a, Json b) {
      final primaryOrder =
          (b['id'] == primary?['id'] ? 1 : 0) -
          (a['id'] == primary?['id'] ? 1 : 0);
      if (primaryOrder != 0) return primaryOrder;
      final timeOrder = _time(b).compareTo(_time(a));
      return timeOrder != 0
          ? timeOrder
          : (a['id'] as String).compareTo(b['id'] as String);
    }

    pinned.sort(order);
    ungrouped.sort(order);
    hidden.addAll(hiddenMap.values.toList()..sort(order));
    for (final section in sections) {
      section.conversations.sort(order);
    }
  }

  Json? primary, standalone;
  final List<Json> pinned = [], ungrouped = [], hidden = [];
  final List<RosterSection> sections = [];
  bool get empty =>
      standalone == null &&
      pinned.isEmpty &&
      ungrouped.isEmpty &&
      sections.every((s) => s.conversations.isEmpty);
}

int _time(Json conversation) =>
    DateTime.tryParse(
      conversation['updatedAt'] as String? ?? '',
    )?.millisecondsSinceEpoch ??
    0;
