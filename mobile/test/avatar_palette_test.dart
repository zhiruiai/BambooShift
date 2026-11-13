import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:openbot_mobile/core/avatar_palette.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/features/bots/bot_form.dart';
import 'package:openbot_mobile/widgets/avatar_appearance.dart';
import 'package:openbot_mobile/widgets/avatar_face.dart';
import 'package:openbot_mobile/widgets/avatar_pack_face.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'widgets_test.dart' show testApp;

void main() {
  test('native avatar palette matches the shared Web contract', () {
    final shared = jsonDecode(
      File('../shared/avatar-palette.json').readAsStringSync(),
    );
    expect(defaultAvatarColor, shared['defaultColor']);
    expect(avatarColors, shared['colors']);
    expect(avatarRoleColors, shared['roles']);
    expect(legacyAvatarColors, shared['legacy']);
    expect(avatarPurpleRange, shared['purple']);
    for (final entry in legacyAvatarColors.entries) {
      expect(displayAvatarColor(entry.key.toUpperCase()), entry.value);
    }
    expect(displayAvatarColor('#9C42D4'), defaultAvatarColor);
    for (final custom in ['#336699', '#817F83', '#180523', '#EAACCC']) {
      expect(displayAvatarColor(custom), custom);
    }
    expect(
      displayAvatarColor(null, fallback: avatarRoleColors['drop']!),
      '#4D7F9A',
    );
    expect(displayAvatarColor('not-a-color'), defaultAvatarColor);
  });

  testWidgets(
    'legacy purple reaches the same natural fill in still and animated renderers',
    (tester) async {
      const profile = {'avatar': 'orb', 'color': '#76568d'};
      final theme = GeneratedAvatarTheme.parse({
        'name': 'Synthetic theme',
        'motif': 'pandas',
        'colors': ['#9c42d4', '#336699', '#879348'],
        'badge': 'none',
        'backdrop': 'halo',
      })!;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: Row(
              children: [
                const BotAvatar(bot: profile, family: 'pandas'),
                const BotAvatar(
                  bot: profile,
                  family: 'elephants',
                  motion: BotAvatarMotion.working,
                ),
                const BotAvatar(
                  bot: profile,
                  family: 'grokbot-bean',
                  motion: BotAvatarMotion.working,
                ),
                BotAvatar(bot: profile, family: 'pandas', previewTheme: theme),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final bamboo = avatarColorValue(defaultAvatarColor);
      for (final svg in tester.widgetList<SvgPicture>(
        find.byType(SvgPicture),
      )) {
        final mapper =
            (svg.bytesLoader as SvgAssetLoader).colorMapper!
                as AvatarColorMapper;
        expect(mapper.color, bamboo);
        expect(mapper.baseColor, const Color(0xff8b5cf6));
      }
      expect(
        (tester.widget<AvatarFace>(find.byType(AvatarFace)).colorMapper
                as AvatarColorMapper)
            .color,
        bamboo,
      );
      expect(
        tester.widget<AvatarPackFace>(find.byType(AvatarPackFace)).color,
        bamboo,
      );
      expect(
        tester
            .widget<GeneratedAvatarDecoration>(
              find.byType(GeneratedAvatarDecoration),
            )
            .color,
        bamboo,
      );
      expect(profile['color'], '#76568d');
      expect(theme.colors.first, '#9c42d4');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'editing legacy profiles shows the natural swatch without saving until selection',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(800, 1400);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final changes = <Map<String, dynamic>>[];
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SingleChildScrollView(
              child: BotForm(
                initial: const {'color': '#76568d'},
                enabled: true,
                family: 'pandas',
                onChanged: changes.add,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder swatch(String label) => find.byWidgetPredicate(
        (widget) => widget is Semantics && widget.properties.label == label,
      );
      expect(swatch('#76568d'), findsNothing);
      expect(
        tester
            .widget<Semantics>(swatch(defaultAvatarColor))
            .properties
            .selected,
        true,
      );
      expect(changes, isEmpty);
      await tester.ensureVisible(swatch('#C39A43'));
      await tester.tap(swatch('#C39A43'));
      await tester.pumpAndSettle();
      expect(changes.single['color'], '#C39A43');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
