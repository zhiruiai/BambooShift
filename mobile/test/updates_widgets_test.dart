import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/updates/updates_controller.dart';
import 'package:openbot_mobile/features/updates/updates_screen.dart';

import 'model_profiles_layout_test.dart' show expectReadableText;
import 'support.dart';
import 'updates_test.dart' show released;
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets(
      'service version is distinct and release opens only on tap in $language',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        var launches = 0, checks = 0;
        final value = await fixture((request) async {
          if (request.method == 'POST') checks++;
          return jsonResponse(released());
        });
        await tester.pumpWidget(
          testApp(
            UpdatesScreen(
              scope: value.scope,
              openRelease: (uri) async {
                launches++;
                expect(uri.host, 'github.com');
                return true;
              },
            ),
            locale: Locale(language),
          ),
        );
        final model =
            (tester.state(find.byType(UpdatesScreen)) as dynamic).model
                as UpdatesController;
        await waitFor(tester, () => !model.busy && model.data != null);
        expect(launches, 0);
        expect(checks, 0);
        expect(
          find.text(language == 'en' ? 'Connected service version' : '当前服务版本'),
          findsOneWidget,
        );
        final link = find.widgetWithText(
          OutlinedButton,
          language == 'en' ? 'Open release on GitHub' : '在 GitHub 查看发行版',
        );
        await tester.ensureVisible(link);
        await tester.pumpAndSettle();
        await tester.tap(link);
        await tester.pumpAndSettle();
        expect(launches, 1);
        expect(checks, 0);
        expect(tester.takeException(), isNull);
        for (final paragraph in tester.renderObjectList<RenderParagraph>(
          find.byType(RichText),
        )) {
          expectReadableText(paragraph.text);
        }
        await tester.pumpWidget(const SizedBox());
        value.scope.dispose();
        value.session.dispose();
      },
    );
  }
}
