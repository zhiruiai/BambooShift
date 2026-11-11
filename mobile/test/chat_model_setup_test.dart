import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/settings/model_settings.dart';

import 'chat_drafts_widgets_test.dart' show composerText, waitForComposer;
import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final locale in [const Locale('en'), const Locale('zh')]) {
    final chinese = locale.languageCode == 'zh';
    final notice = chinese
        ? '连接模型后即可发送消息。'
        : 'Connect a model to start sending messages.';
    final profiles = chinese ? '模型配置库' : 'Model profiles';

    testWidgets('320dp $locale owner connects the model from the same chat', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final models = ModelsServer();
      models.profiles = [
        modelProfile('profile-a')
          ..addAll({'configured': false, 'hasApiKey': false, 'baseUrl': ''}),
      ];
      Json snapshot() => {
        ...bootstrap(
          agents: [
            {'id': 'bot-a', 'name': 'Research'},
          ],
        ),
        'settings': models.settings,
      };
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.url.path.endsWith('/bootstrap')) {
          return jsonResponse(snapshot());
        }
        expect(request.url.path, '/api/workspaces/space-a/model-profiles');
        return models.handle(request);
      });
      f.scope.data = snapshot();
      f.scope.saveChatDraft('chat-a', 'Existing draft');
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: locale,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(notice), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      await tester.tap(find.widgetWithText(TextButton, profiles));
      await waitFor(
        tester,
        () => find.text('Profile profile-a').evaluate().isNotEmpty,
      );
      expect(find.byType(ModelSettings), findsOneWidget);
      expect(models.writes, isEmpty);

      await tester.tap(
        find.widgetWithText(TextButton, chinese ? '编辑' : 'Edit'),
      );
      await tester.pumpAndSettle();
      final key = find.byWidgetPredicate(
        (widget) => widget is TextField && widget.obscureText,
      );
      await tester.scrollUntilVisible(
        key,
        150,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.enterText(key, 'synthetic-only');
      final save = find.widgetWithText(
        FilledButton,
        chinese ? '保存配置' : 'Save profile',
      );
      await tester.scrollUntilVisible(
        save,
        150,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(save);
      await waitFor(
        tester,
        () =>
            find.byType(ModelSettings).evaluate().isNotEmpty &&
            models.writes.isNotEmpty,
      );
      expect(models.writes.single.method, 'POST');
      expect(find.byType(ModelSettings), findsOneWidget);
      Navigator.of(tester.element(find.byType(ModelSettings))).pop();
      await tester.pumpAndSettle();
      await waitForComposer(tester);
      expect(find.text(notice), findsNothing);
      expect(composerText(tester), 'Existing draft');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });

    testWidgets('$locale member sees who can connect the model', (
      tester,
    ) async {
      final f = await fixture((_) async {
        fail('Rendering the blocked composer must not request model profiles.');
      });
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'chat-a'),
          locale: locale,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          chinese
              ? '请联系工作空间所有者连接模型，然后就能发送消息。'
              : 'Ask your workspace owner to connect a model so you can send messages.',
        ),
        findsOneWidget,
      );
      expect(find.text(profiles), findsNothing);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }
}
