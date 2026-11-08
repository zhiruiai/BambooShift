import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/roster/roster_data.dart';

Json chat(String id, String bot, {bool group = false, int day = 1}) => {
  'id': id,
  'title': id,
  'agentIds': [bot],
  'isGroup': group,
  'updatedAt': '2026-11-${day.toString().padLeft(2, '0')}T00:00:00Z',
};
Json entry(
  String bot, {
  bool hidden = false,
  bool pinned = false,
  String? section,
}) => {
  'target': {'kind': 'bot', 'id': bot},
  'hidden': hidden,
  'pinned': pinned,
  'sectionId': section,
};
Json roster({
  List<Json> entries = const [],
  List<Json> sections = const [],
  String revision = 'revision-a',
}) => {'revision': revision, 'entries': entries, 'sections': sections};
Json withChats(
  List<Json> chats, {
  Json? state,
  Json? primary,
  List<Json> bots = const [],
}) => {
  'conversations': chats,
  'agents': bots,
  'sidebarRoster': ?state,
  'primaryBot': ?primary,
};

void main() {
  test('Bot preference applies to every DM while its group stays visible', () {
    final projection = RosterProjection(
      withChats([
        chat('dm-a', 'bot-a'),
        chat('dm-b', 'bot-a', day: 2),
        chat('group-a', 'bot-a', group: true),
      ], state: roster(entries: [entry('bot-a', hidden: true)])),
    );
    expect(projection.hidden.map((c) => c['id']), ['dm-b']);
    expect(projection.ungrouped.map((c) => c['id']), ['group-a']);
    expect(rosterTarget(chat('group-a', 'bot-a', group: true)), {
      'kind': 'conversation',
      'id': 'group-a',
    });
  });

  test(
    'hiding primary never forces it visible and recovery selects canonical DM',
    () {
      final projection = RosterProjection(
        withChats(
          [chat('canonical', 'bot-a'), chat('newer', 'bot-a', day: 7)],
          state: roster(entries: [entry('bot-a', hidden: true)]),
          primary: {
            'available': true,
            'agentId': 'bot-a',
            'conversationId': 'canonical',
          },
          bots: [
            {'id': 'bot-a'},
          ],
        ),
      );
      expect(projection.primary?['id'], 'canonical');
      expect(projection.standalone, isNull);
      expect(projection.empty, true);
      expect(projection.hidden.single['id'], 'canonical');
    },
  );

  test(
    'pinned primary comes first and sections retain collapse and empty state',
    () {
      final projection = RosterProjection(
        withChats(
          [
            chat('primary', 'bot-a'),
            chat('recent', 'bot-b', day: 7),
            chat('section', 'bot-c', day: 3),
            chat('other', 'bot-d'),
          ],
          bots: [
            {'id': 'bot-a'},
          ],
          primary: {
            'available': true,
            'agentId': 'bot-a',
            'conversationId': 'primary',
          },
          state: roster(
            entries: [
              entry('bot-a', pinned: true),
              entry('bot-b', pinned: true),
              entry('bot-c', section: 'section-a'),
            ],
            sections: [
              {'id': 'section-a', 'name': 'Research', 'collapsed': true},
              {'id': 'section-b', 'name': 'Empty', 'collapsed': false},
            ],
          ),
        ),
      );
      expect(projection.pinned.map((c) => c['id']), ['primary', 'recent']);
      expect(projection.sections.length, 2);
      expect(projection.sections.first.value['collapsed'], true);
      expect(projection.sections.first.conversations.single['id'], 'section');
      expect(projection.sections.last.conversations, isEmpty);
      expect(projection.ungrouped.single['id'], 'other');
    },
  );

  test(
    'shared aliases and malformed primary DM are never promoted to primary',
    () {
      for (final shared in [true, false]) {
        final projection = RosterProjection(
          withChats(
            [chat('primary', 'bot-a', group: !shared)],
            primary: {
              'available': true,
              'agentId': 'bot-a',
              'conversationId': 'primary',
            },
            bots: [
              {
                'id': 'bot-a',
                if (shared) 'sharedBot': {'id': 'shared-a'},
              },
            ],
          ),
        );
        expect(projection.primary, isNull);
        expect(projection.standalone, isNull);
        expect(projection.ungrouped.single['id'], 'primary');
      }
    },
  );

  test('legacy pinned state is used only while no personal roster exists', () {
    final legacy = {...chat('dm-a', 'bot-a'), 'pinned': true};
    expect(RosterProjection(withChats([legacy])).pinned.single['id'], 'dm-a');
    final personal = RosterProjection(withChats([legacy], state: roster()));
    expect(personal.pinned, isEmpty);
    expect(personal.ungrouped.single['id'], 'dm-a');
  });

  test('invalid and duplicate server entries do not become editable state', () {
    for (final value in [
      {},
      roster(entries: [entry('a'), entry('a')]),
      roster(
        sections: [
          {'id': 's', 'name': 'Name'},
        ],
      ),
      roster(
        entries: [
          {
            'target': {'kind': 'user', 'id': 'a'},
            'pinned': false,
            'hidden': false,
            'sectionId': null,
          },
        ],
      ),
    ]) {
      expect(() => readRoster(value), throwsA(isA<ApiException>()));
    }
  });
}
