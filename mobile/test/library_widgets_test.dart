import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/bot_library/library_screen.dart';
import 'package:openbot_mobile/features/bot_library/blueprint_preview.dart';
import 'package:openbot_mobile/features/bot_library/library_navigation.dart';
import 'package:openbot_mobile/features/bot_library/original_bot_template_data.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';
import 'library_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

Future<void> waitForLibrary(WidgetTester tester, bool Function() ready) async {
  // Mock responses and route transitions can finish on different event loops.
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
    if (ready() && !tester.binding.hasScheduledFrame) return;
  }
  expect(ready(), isTrue, reason: 'Expected library state did not appear.');
  expect(tester.binding.hasScheduledFrame, isFalse);
}

Future<void> libraryReach(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('bundled originals provide all seven localized profiles', (
    tester,
  ) async {
    final catalogs = await tester.runAsync(
      () => Future.wait([
        loadOriginalBotTemplates('zh'),
        loadOriginalBotTemplates('en'),
      ]),
    );
    expect(catalogs, isNotNull);
    for (final catalog in catalogs!) {
      expect(catalog.map((item) => item.id), [
        'research',
        'writing',
        'coordination',
        'engineering',
        'organization',
        'briefing',
        'support',
      ]);
      for (final item in catalog) {
        expect(item.profile.keys.toSet(), {
          'name',
          'role',
          'description',
          'instructions',
          'avatar',
          'color',
          'avatarImageId',
        });
        expect(item.profile['avatarImageId'], isNull);
      }
    }
    expect(catalogs.first.first.profile['name'], '研究员');
    expect(catalogs.last.first.profile['name'], 'Researcher');
    expect(
      filterOriginalBotTemplates(
        catalogs.last,
        'CODE verification',
        'engineering',
      ).single.id,
      'engineering',
    );
  });

  testWidgets(
    'original Bot template previews and edits locally before confirmed creation',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = LibraryServer();
      final writes = <Map<String, dynamic>>[];
      final f = await fixture((request) async {
        if (!request.url.path.endsWith('/creation-requests')) {
          return server.handle(request);
        }
        final payload = jsonDecode(request.body) as Map<String, dynamic>;
        writes.add(payload);
        final agent = {
          'id': 'new-bot',
          ...payload['profile'] as Map<String, dynamic>,
        };
        final chat = {
          'id': 'new-chat',
          'agentIds': ['new-bot'],
          'isGroup': false,
        };
        server.snapshot = {
          ...server.snapshot,
          'agents': [agent],
          'conversations': [chat],
        };
        return jsonResponse({
          'requestId': payload['requestId'],
          'kind': 'bot',
          'status': 'created',
          'workspaceId': 'space-a',
          'userId': 'user-a',
          'conversationId': 'new-chat',
          'agentIds': ['new-bot'],
          'conversation': chat,
          'agents': [agent],
        });
      });
      LibraryOpen? opened;
      await tester.pumpWidget(
        testApp(
          Builder(
            builder: (context) => Scaffold(
              body: FilledButton(
                onPressed: () async {
                  opened = await Navigator.push<LibraryOpen>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => BotLibraryScreen(scope: f.scope),
                    ),
                  );
                },
                child: const Text('Open fixture'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open fixture'));
      await waitForLibrary(
        tester,
        () => find.text('PandaMate originals').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('PandaMate originals'));
      final search = find.widgetWithText(
        TextField,
        'Search original templates',
      );
      await waitForLibrary(tester, () => search.evaluate().isNotEmpty);
      await tester.enterText(search, 'MORNING brief');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Morning Briefing Editor'));
      await tester.pumpAndSettle();
      expect(find.text('Changes, deadlines and decisions'), findsOneWidget);
      expect(writes, isEmpty);
      final use = find.text('Use template and edit');
      await tester.ensureVisible(use);
      await tester.tap(use);
      await waitForLibrary(
        tester,
        () => find.byType(CreateScreen).evaluate().isNotEmpty,
      );
      final name = find.widgetWithText(TextFormField, 'Name');
      await tester.enterText(name, 'Team Morning Brief');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      expect(writes, isEmpty);
      final create = find.widgetWithText(FilledButton, 'Create');
      final scrollable = find
          .descendant(
            of: find.byType(CreateScreen),
            matching: find.byType(Scrollable),
          )
          .first;
      final scroll = tester.state<ScrollableState>(scrollable).position;
      for (var step = 0; step < 3 && create.evaluate().isEmpty; step++) {
        scroll.jumpTo(scroll.maxScrollExtent);
        await tester.pumpAndSettle();
      }
      await tester.ensureVisible(create);
      await tester.tap(create);
      await waitForLibrary(tester, () => opened != null);
      expect(writes.single['profile']['name'], 'Team Morning Brief');
      expect(writes.single['profile']['avatar'], 'spark');
      expect(writes.single['profile']['color'], '#b96b22');
      expect(
        writes.single['profile']['role'],
        'Changes, deadlines and decisions',
      );
      expect(
        writes.single['profile']['instructions'],
        startsWith('Prepare a morning brief'),
      );
      expect(opened?.conversationId, 'new-chat');
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('320px member filters and reviews Chinese originals read-only', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = LibraryServer();
    final f = await fixture((request) async {
      if (request.url.path == '/api/account/session') {
        final account = libraryAccount();
        return jsonResponse({
          ...account,
          'workspaces': [
            for (final workspace in account['workspaces'] as List)
              if (workspace['id'] == 'space-a')
                {...workspace, 'role': 'member'}
              else
                workspace,
          ],
        });
      }
      return server.handle(request);
    });
    f.session.workspace!['role'] = 'member';
    await tester.pumpWidget(
      testApp(BotLibraryScreen(scope: f.scope), locale: const Locale('zh')),
    );
    final entry = find.text('PandaMate 原创模板');
    await waitForLibrary(tester, () => entry.evaluate().isNotEmpty);
    await tester.tap(entry);
    final search = find.widgetWithText(TextField, '搜索原创模板');
    await waitForLibrary(tester, () => search.evaluate().isNotEmpty);
    final category = find.byType(DropdownButtonFormField<String>);
    await tester.tap(category);
    await tester.pumpAndSettle();
    await tester.tap(find.text('编程').last);
    await tester.pumpAndSettle();
    expect(find.text('研究员'), findsNothing);
    await tester.enterText(search, '不存在的模板');
    await tester.pumpAndSettle();
    expect(find.text('没有匹配的原创模板。试试其他关键词或分类。'), findsOneWidget);
    await tester.enterText(search, '代码 实现');
    await tester.pumpAndSettle();
    await tester.tap(find.text('编程助手'));
    await tester.pumpAndSettle();
    expect(find.text('代码理解、实现与验证'), findsOneWidget);
    expect(find.byType(SelectableText), findsOneWidget);
    expect(find.text('使用模板并编辑'), findsNothing);
    expect(find.text('可以浏览全部模板。创建 Bot 需要空间拥有者权限。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('代码 实现'), findsOneWidget);
    expect(find.text('编程助手'), findsOneWidget);
    expect(
      server.requests.where((request) => request.method != 'GET'),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('New Bot keeps edited fields until a template replaces them', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = LibraryServer();
    final f = await fixture(server.handle);
    await tester.pumpWidget(testApp(CreateScreen(scope: f.scope, kind: 'bot')));
    final browse = find.widgetWithText(OutlinedButton, 'Start from a template');
    await waitForLibrary(
      tester,
      () => tester.widget<OutlinedButton>(browse).onPressed != null,
    );
    final name = find.widgetWithText(TextFormField, 'Name');
    await tester.enterText(name, 'My draft');
    Future<void> selectCoding() async {
      await tester.tap(browse);
      final search = find.widgetWithText(
        TextField,
        'Search original templates',
      );
      await waitForLibrary(tester, () => search.evaluate().isNotEmpty);
      await tester.enterText(search, 'Coding Assistant');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ListTile, 'Coding Assistant'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use template and edit'));
      await tester.pumpAndSettle();
      expect(
        find.text('Replace your unsaved profile edits with this template?'),
        findsOneWidget,
      );
    }

    await selectCoding();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('My draft'), findsOneWidget);
    await selectCoding();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('My draft'), findsNothing);
    expect(find.text('Coding Assistant'), findsOneWidget);
    expect(tester.widget<TextFormField>(name).enabled, isTrue);
    expect(
      server.requests.where((request) => request.method != 'GET'),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    '390px template preview imports only after explicit review and returns a verified target',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = LibraryServer();
      final f = await fixture(server.handle);
      LibraryOpen? opened;
      await tester.pumpWidget(
        testApp(
          Builder(
            builder: (context) => Scaffold(
              body: FilledButton(
                onPressed: () async {
                  opened = await Navigator.push<LibraryOpen>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => BotLibraryScreen(scope: f.scope),
                    ),
                  );
                },
                child: const Text('Open fixture'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open fixture'));
      await waitForLibrary(
        tester,
        () => find.text('Research Bot').evaluate().isNotEmpty,
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('My personal space').last);
      await waitForLibrary(
        tester,
        () => find.text('Research Bot').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('Research Bot'));
      await waitForLibrary(
        tester,
        () => find.byType(BlueprintPreview).evaluate().isNotEmpty,
      );
      await libraryReach(tester, find.text('Working instructions'));
      await tester.tap(find.text('Working instructions'));
      await tester.pumpAndSettle();
      expect(find.text('Exact synthetic instructions'), findsOneWidget);
      await libraryReach(tester, find.text('Import independent Bot'));
      expect(server.posts, isEmpty);
      await tester.tap(find.text('Import independent Bot'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitForLibrary(tester, () => server.installs == 1);
      expect(opened, isNull);
      expect(f.session.workspaceId, 'space-a');
      await libraryReach(tester, find.text('Open conversation'));
      await tester.tap(find.text('Open conversation'));
      await waitForLibrary(
        tester,
        () => find.byType(AlertDialog).evaluate().isNotEmpty,
      );
      expect(opened, isNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Done'));
      await waitForLibrary(tester, () => opened != null);
      expect(opened?.workspace['id'], 'space-b');
      expect(opened?.agentId, 'installed-bot');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'shared preview is read-only and clearly targets personal space',
    (tester) async {
      final server = LibraryServer();
      final f = await fixture(server.handle);
      await tester.pumpWidget(
        testApp(BotLibraryScreen(scope: f.scope), locale: const Locale('zh')),
      );
      await waitForLibrary(
        tester,
        () => find.text('Research Bot').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('共享 Bot'));
      await waitForLibrary(
        tester,
        () => find.text('Live Bot').evaluate().isNotEmpty,
      );
      expect(find.text('My personal space'), findsOneWidget);
      await tester.tap(find.text('Live Bot'));
      await waitForLibrary(
        tester,
        () => find.text('加入个人空间').evaluate().isNotEmpty,
      );
      expect(find.text('新 Bot 名称'), findsNothing);
      expect(server.posts, isEmpty);
      await libraryReach(tester, find.text('加入个人空间'));
      await tester.tap(find.text('加入个人空间'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '完成'));
      await waitForLibrary(tester, () => server.installs == 1);
      expect(
        server.posts.single.url.path,
        '/api/workspaces/space-b/shared-bot-references',
      );
      expect(f.session.workspaceId, 'space-a');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'changing an import name then leaving requires explicit draft confirmation',
    (tester) async {
      final server = LibraryServer();
      final f = await fixture(server.handle);
      await tester.pumpWidget(testApp(BotLibraryScreen(scope: f.scope)));
      await waitForLibrary(
        tester,
        () => find.text('Research Bot').evaluate().isNotEmpty,
      );
      await tester.tap(find.text('Research Bot'));
      await waitForLibrary(
        tester,
        () => find.byType(BlueprintPreview).evaluate().isNotEmpty,
      );
      final name = find.widgetWithText(TextFormField, 'New Bot name');
      await libraryReach(tester, name);
      await tester.enterText(name, 'Keep this draft');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Keep this draft'), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
