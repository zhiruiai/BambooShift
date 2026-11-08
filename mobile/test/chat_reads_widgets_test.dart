import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/chat_read_observer.dart';

import 'chat_reads_test.dart' show renderedChat;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  testWidgets(
    'an attached message list with zero visible height cannot acknowledge arrivals',
    (tester) async {
      var writes = 0;
      var height = 0.0;
      final value = await fixture((request) async {
        if (request.method == 'PATCH') {
          writes++;
        }
        return jsonResponse(request.method == 'GET' ? bootstrap() : {});
      });
      final scroll = ScrollController();
      late StateSetter rebuild;
      await tester.pumpWidget(
        testApp(
          StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return Scaffold(
                body: Column(
                  children: [
                    ChatReadObserver(
                      scope: value.scope,
                      conversationId: 'chat-a',
                      rendered: renderedChat,
                      scroll: scroll,
                    ),
                    SizedBox(
                      height: height,
                      child: ListView(
                        controller: scroll,
                        reverse: true,
                        children: const [
                          SizedBox(height: 100, child: Text('Unseen reply')),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(scroll.hasClients, true);
      expect(scroll.position.viewportDimension, 0);
      expect(writes, 0);
      rebuild(() => height = 200);
      await waitFor(tester, () => writes == 1);
      await tester.pumpWidget(const SizedBox());
      scroll.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  testWidgets(
    'scrolling back and covering a chat never acknowledges unseen arrivals',
    (tester) async {
      var writes = 0, through = 7;
      final value = await fixture((request) async {
        if (request.method == 'PATCH') writes++;
        return jsonResponse(request.method == 'GET' ? bootstrap() : {});
      });
      final scroll = ScrollController();
      late StateSetter rebuild;
      late BuildContext pageContext;
      await tester.pumpWidget(
        testApp(
          StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              pageContext = context;
              return Scaffold(
                body: Column(
                  children: [
                    ChatReadObserver(
                      scope: value.scope,
                      conversationId: 'chat-a',
                      rendered: {...renderedChat, 'readThrough': through},
                      scroll: scroll,
                    ),
                    Expanded(
                      child: ListView(
                        controller: scroll,
                        reverse: true,
                        children: [
                          for (var i = 0; i < 30; i++)
                            SizedBox(height: 100, child: Text('Message $i')),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      );
      await waitFor(tester, () => writes == 1);
      scroll.jumpTo(300);
      rebuild(() => through = 8);
      await tester.pumpAndSettle();
      expect(writes, 1);
      Navigator.of(pageContext).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Covering settings')),
        ),
      );
      await tester.pumpAndSettle();
      scroll.jumpTo(0);
      rebuild(() => through = 9);
      await tester.pumpAndSettle();
      expect(writes, 1);
      Navigator.of(pageContext).pop();
      await waitFor(tester, () => writes == 2);
      await tester.pumpWidget(const SizedBox());
      scroll.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );

  testWidgets(
    'a paused app acknowledges only after returning to the foreground',
    (tester) async {
      var writes = 0;
      final value = await fixture((request) async {
        if (request.method == 'PATCH') writes++;
        return jsonResponse(request.method == 'GET' ? bootstrap() : {});
      });
      final scroll = ScrollController();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ChatReadObserver(
              scope: value.scope,
              conversationId: 'chat-a',
              rendered: renderedChat,
              scroll: scroll,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(writes, 0);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await waitFor(tester, () => writes == 1);
      await tester.pumpWidget(const SizedBox());
      scroll.dispose();
      value.scope.dispose();
      value.session.dispose();
    },
  );
}
