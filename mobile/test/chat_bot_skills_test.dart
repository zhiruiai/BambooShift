import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/bots/knowledge_editor.dart';
import 'package:openbot_mobile/features/bots/knowledge_screen.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

Json _skill(String id, String name, String state, {String bot = 'bot-a'}) => {
  'id': id,
  'agentId': bot,
  'name': name,
  'status': state,
  'content': 'Work from verified evidence.',
  'version': 1,
};

Json _directChat({String variant = 'older'}) =>
    bootstrap(
        agents: [
          {
            'id': 'bot-a',
            'name': 'Research partner',
            if (variant == 'shared')
              'sharedBot': {'status': 'active', 'available': true},
          },
          {'id': 'bot-b', 'name': 'Other Bot'},
        ],
      )
      ..['settings'] = {'configured': true}
      ..['conversations'] = [
        {
          'id': 'chat-a',
          'title': 'Example conversation',
          'agentIds': ['bot-a'],
          if (variant == 'group') 'isGroup': true,
          if (variant == 'demo') 'demo': true,
        },
      ]
      ..['skills'] = [
        _skill('skill-d', 'Inactive workflow', 'disabled'),
        _skill('skill-p', 'Review this draft', 'proposed'),
        _skill('skill-a', 'Ready to research', 'active'),
        _skill('skill-b', 'Different Bot skill', 'active', bot: 'bot-b'),
      ];

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(320, 680);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('direct chat opens its own Bot skills and the import editor', (
    tester,
  ) async {
    _phone(tester);
    final data = _directChat();
    final writes = <String>[];
    final f = await fixture((request) async {
      if (request.method != 'GET') writes.add(request.url.path);
      return jsonResponse(data);
    });
    f.scope.data = data;
    f.scope.saveChatOptions(
      'chat-a',
      emptyChatOptions.withSkill(null, bot: 'bot-b'),
    );
    await tester.pumpWidget(
      testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Conversation actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Bot skills'));
    await tester.pumpAndSettle();

    expect(find.byType(KnowledgeScreen), findsOneWidget);
    expect(find.text('Research partner'), findsOneWidget);
    expect(find.text('Enabled'), findsOneWidget);
    expect(find.text('Awaiting review'), findsOneWidget);
    expect(find.text('Disabled and previous versions'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Ready to research')).dy,
      lessThan(tester.getTopLeft(find.text('Review this draft')).dy),
    );
    expect(find.text('Different Bot skill'), findsNothing);
    expect(find.text('Start from a workflow template'), findsOneWidget);
    await tester.tap(find.byTooltip('Add'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<KnowledgeEditor>(find.byType(KnowledgeEditor)).agentId,
      'bot-a',
    );
    expect(find.text('Import SKILL.md'), findsOneWidget);
    expect(writes, isEmpty);

    await tester.pageBack();
    await tester.pumpAndSettle();
    f.session.selectWorkspace(null);
    await tester.pumpAndSettle();
    expect(find.text('Ready to research'), findsNothing);
    expect(
      find.text(
        'Your account or space has changed. Open it again to continue.',
      ),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('a team member can see read-only skill status in Chinese', (
    tester,
  ) async {
    _phone(tester);
    final data = _directChat();
    data['skills'] = [
      _skill('skill-p', '待审核的工作流', 'proposed'),
      _skill('skill-b', '别的 Bot 的技能', 'active', bot: 'bot-b'),
    ];
    final f = await fixture((_) async => jsonResponse(data));
    f.session.workspace!['kind'] = 'team';
    f.session.workspace!['role'] = 'member';
    f.scope.data = data;
    await tester.pumpWidget(
      testApp(
        ChatScreen(scope: f.scope, conversationId: 'chat-a'),
        locale: const Locale('zh'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('会话操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Bot 技能'));
    await tester.pumpAndSettle();

    expect(find.text('此 Bot 还没有已启用的技能。'), findsOneWidget);
    expect(find.text('待审核的工作流'), findsOneWidget);
    expect(find.text('别的 Bot 的技能'), findsNothing);
    expect(find.text('从工作流模板起草'), findsNothing);
    expect(find.byTooltip('新增'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  for (final variant in ['group', 'shared', 'demo', 'thread']) {
    testWidgets('does not offer the direct skills route for $variant', (
      tester,
    ) async {
      _phone(tester);
      final data = _directChat(variant: variant);
      final f = await fixture((_) async => jsonResponse(data));
      f.scope.data = data;
      await tester.pumpWidget(
        testApp(
          ChatScreen(
            scope: f.scope,
            conversationId: 'chat-a',
            threadRootId: variant == 'thread' ? 'thread-a' : null,
          ),
        ),
      );
      await tester.pumpAndSettle();
      final menu = find.byTooltip('Conversation actions');
      if (menu.evaluate().isNotEmpty) {
        await tester.tap(menu);
        await tester.pumpAndSettle();
      }
      expect(find.text('Bot skills'), findsNothing);
      expect(find.byTooltip('Bot skills'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }
}
