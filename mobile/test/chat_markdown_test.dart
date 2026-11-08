import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/chat_markdown.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

void main() {
  testWidgets('chat replies render selectable Markdown in a narrow bubble', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final f = await fixture((_) async => jsonResponse({}));
    addTearDown(f.session.dispose);
    addTearDown(f.scope.dispose);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ChatMessage(
                scope: f.scope,
                message: const {
                  'role': 'assistant',
                  'metadata': {
                    'author': {'name': 'Research Bot'},
                  },
                  'content': '''
# Status report

- **First result**
- Second result

| Region | Status | Next step |
| --- | --- | --- |
| North | Done | Review |

```text
one very long line of code that must scroll inside the bubble
```
''',
                },
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(find.text('Status report'), findsOneWidget);
    expect(find.text('First result'), findsOneWidget);
    expect(find.text('# Status report'), findsNothing);
    expect(find.byType(Table), findsOneWidget);
    expect(find.text('Review'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is SingleChildScrollView &&
            widget.scrollDirection == Axis.horizontal,
      ),
      findsNWidgets(2),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('links open only on tap, and Markdown images stay passive', (
    tester,
  ) async {
    final opened = <Uri>[];
    var active = true;
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ChatMarkdown(
            text: '''
[Public reference](https://docs.example.test/guide)

[Executable URI](javascript:alert)

[Relative request](/api/account/session)

[Credential URI](https://private@docs.example.test/)

![Remote illustration](https://outside.example.test/image.png)
''',
            canOpenLink: () => active,
            openLink: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(opened, isEmpty);
    expect(find.text('Remote illustration'), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    for (final label in [
      'Executable URI',
      'Relative request',
      'Credential URI',
    ]) {
      await tester.tapOnText(find.textRange.ofSubstring(label));
    }
    expect(opened, isEmpty);
    await tester.tapOnText(find.textRange.ofSubstring('Public reference'));
    expect(opened, [Uri.parse('https://docs.example.test/guide')]);
    active = false;
    await tester.tapOnText(find.textRange.ofSubstring('Public reference'));
    expect(opened, hasLength(1));
  });
}
