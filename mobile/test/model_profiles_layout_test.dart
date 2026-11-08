import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/settings/model_profiles_controller.dart';
import 'package:openbot_mobile/features/settings/model_settings.dart';

import 'model_profile_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void expectReadableText(InlineSpan span, [double? inherited]) {
  final size = span.style?.fontSize ?? inherited;
  if (span is! TextSpan) return;
  if ((span.text ?? '').trim().isNotEmpty) {
    expect(size, isNotNull);
    expect(size, greaterThanOrEqualTo(12));
  }
  for (final child in span.children ?? <InlineSpan>[]) {
    expectReadableText(child, size);
  }
}

void main() {
  for (final language in ['en', 'zh']) {
    testWidgets('model library and editable profile fit a phone in $language', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final f = await fixture(ModelsServer().handle);
      await tester.pumpWidget(
        testApp(ModelSettings(scope: f.scope), locale: Locale(language)),
      );
      final controller =
          (tester.state(find.byType(ModelSettings)) as dynamic).controller
              as ModelProfilesController;
      await waitFor(tester, () => controller.canManage);
      expect(find.text('Profile profile-a'), findsOneWidget);
      for (final paragraph in tester.renderObjectList<RenderParagraph>(
        find.byType(RichText),
      )) {
        expectReadableText(paragraph.text);
      }
      final edit = find
          .widgetWithText(TextButton, language == 'en' ? 'Edit' : '编辑')
          .first;
      await tester.ensureVisible(edit);
      await tester.tap(edit);
      await tester.pumpAndSettle();
      final save = find.widgetWithText(
        FilledButton,
        language == 'en' ? 'Save profile' : '保存配置',
      );
      await tester.scrollUntilVisible(
        save,
        250,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      expect(tester.takeException(), isNull);
      for (final paragraph in tester.renderObjectList<RenderParagraph>(
        find.byType(RichText),
      )) {
        expectReadableText(paragraph.text);
      }
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }
}
