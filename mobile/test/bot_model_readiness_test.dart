import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/chat_draft.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/voice/voice_memo_data.dart';

import 'attachment_support.dart';
import 'chat_drafts_widgets_test.dart' show composerText, waitForComposer;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    for (final configured in [true, false]) {
      testWidgets(
        '$language chat and voice use Bot model readiness $configured before the workspace default',
        (tester) async {
          tester.view
            ..physicalSize = const Size(320, 640)
            ..devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final server = AttachmentServer();
          Json snapshot() => {
            ...bootstrap(
              agents: [
                {
                  'id': 'bot-a',
                  'name': 'Synthetic researcher',
                  'modelConfigured': configured,
                  'modelProfileId': 'b9ae5e6e-3b26-4c4d-8ad0-a0d236ce9f74',
                },
              ],
              messages: server.messages,
            ),
            'settings': {'configured': !configured},
            'voiceMemo': {'available': true},
          };
          final f = await fixture(
            (request) => request.url.path.endsWith('/bootstrap')
                ? Future.value(jsonResponse(snapshot()))
                : server.handle(request),
          );
          f.scope.data = snapshot();
          await tester.pumpWidget(
            testApp(
              ChatScreen(scope: f.scope, conversationId: 'chat-a'),
              locale: Locale(language),
            ),
          );
          final text = find.byType(TextField);
          if (configured) {
            await waitForComposer(tester);
          } else {
            await tester.pumpAndSettle();
          }
          expect(tester.widget<TextField>(text).enabled, configured);
          expect(
            canRequestVoiceMemo(f.scope, 'chat-a', null, emptyChatOptions),
            configured,
          );
          if (configured) {
            await tester.enterText(text, 'Synthetic research task');
            await tester.pump();
            final send = find.descendant(
              of: find.byTooltip(language == 'en' ? 'Send' : '发送'),
              matching: find.byType(FilledButton),
            );
            expect(tester.widget<FilledButton>(send).onPressed, isNotNull);
            await tester.tap(send);
            await waitFor(
              tester,
              () =>
                  server.messages.isNotEmpty &&
                  composerText(tester).isEmpty &&
                  tester.widget<TextField>(text).enabled == true,
            );
            expect(
              server.messages.single['content'],
              'Synthetic research task',
            );
          } else {
            expect(server.messages, isEmpty);
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          f.scope.dispose();
          f.session.dispose();
        },
      );
    }
  }
}
