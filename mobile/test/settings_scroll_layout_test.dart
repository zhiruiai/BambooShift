import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/token_prompt.dart';
import 'package:openbot_mobile/features/roster/roster_dialogs.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_generator.dart';
import 'package:openbot_mobile/features/settings/device_settings.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

void main() {
  for (final locale in [const Locale('en'), const Locale('zh')]) {
    testWidgets(
      'settings uses one page scroll and reachable themes in $locale',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = const Size(320, 480);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = await fixture(
          (_) async => throw StateError('No network expected'),
        );
        await tester.pumpWidget(
          testApp(DeviceSettings(session: f.session), locale: locale),
        );
        await tester.pumpAndSettle();
        final scroll = find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first;
        final header = tester.getRect(find.byType(AppBar));
        final title = locale.languageCode == 'en' ? 'Elephants' : '大象';
        await tester.scrollUntilVisible(
          find.text(title).hitTestable(),
          200,
          scrollable: scroll,
        );
        await tester.tap(find.text(title));
        await tester.pumpAndSettle();
        expect(f.session.avatarTheme, 'elephants');
        expect(tester.getRect(find.byType(AppBar)), header);
        expect(find.byType(ListView), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
    for (final kind in ['roster', 'token', 'avatar']) {
      testWidgets('$kind dialog keeps actions above the keyboard in $locale', (
        tester,
      ) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = const Size(320, 560);
        tester.platformDispatcher.textScaleFactorTestValue = 1.3;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetViewInsets);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final f = await fixture(
          (_) async => throw StateError('No network expected'),
        );
        final apps = AppsController(f.scope);
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  onPressed: () {
                    if (kind == 'roster') {
                      rosterName(context, value: 'Synthetic section');
                    } else {
                      showDialog<void>(
                        context: context,
                        builder: (_) => kind == 'token'
                            ? AppTokenPrompt(controller: apps)
                            : AvatarThemeGenerator(scope: f.scope),
                      );
                    }
                  },
                  child: const Text('Open'),
                ),
              ),
            ),
            locale: locale,
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        if (kind != 'avatar') {
          final body = find.descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(SingleChildScrollView),
          );
          final bodyScroll = find
              .descendant(of: body, matching: find.byType(Scrollable))
              .first;
          expect(
            tester.state<ScrollableState>(bodyScroll).position.maxScrollExtent,
            0,
          );
        }
        tester.view.viewInsets = const FakeViewPadding(bottom: 300);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        final actions = find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byWidgetPredicate(
            (widget) => widget is ButtonStyleButton,
          ),
        );
        for (final action in actions.evaluate()) {
          final finder = find.byWidget(action.widget);
          expect(tester.getRect(finder).bottom, lessThanOrEqualTo(260));
        }
        final cancel = find.widgetWithText(
          TextButton,
          locale.languageCode == 'en' ? 'Cancel' : '取消',
        );
        expect(cancel.hitTestable(), findsOneWidget);
        expect(tester.getRect(cancel).bottom, lessThanOrEqualTo(260));
        await tester.tap(cancel);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        await tester.pumpWidget(const SizedBox());
        apps.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
    }
  }
}
