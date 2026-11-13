import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/app_session.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/core/classic_avatar.g.dart';
import 'package:openbot_mobile/core/community_avatar_catalog.g.dart';
import 'package:openbot_mobile/core/secure_store.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_picker.dart';
import 'package:openbot_mobile/widgets/avatar_pack_face.dart';
import 'package:openbot_mobile/widgets/avatar_pack_geometry.dart';
import 'package:openbot_mobile/widgets/avatar_pack_painter.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'community_avatar_test.dart' show waitFor;
import 'support.dart';
import 'widgets_test.dart' show testApp;

Finder get _painted => find.byWidgetPredicate(
  (widget) => widget is CustomPaint && widget.painter is AvatarPackPainter,
);
AvatarPackPainter _painter(WidgetTester tester) =>
    tester.widget<CustomPaint>(_painted.first).painter! as AvatarPackPainter;

Widget _scene({
  bool active = false,
  bool reduced = false,
  bool offstage = false,
  bool uploaded = false,
  bool dark = false,
  BotAvatarMotion? motion,
}) => MaterialApp(
  themeAnimationDuration: Duration.zero,
  theme: ThemeData(brightness: dark ? Brightness.dark : Brightness.light),
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduced),
    child: Center(
      child: Offstage(
        offstage: offstage,
        child: BotAvatar(
          bot: {'avatar': 'orb', if (uploaded) 'avatarImageId': 'synthetic'},
          family: defaultAvatarTheme,
          blinkWhenIdle: active,
          sustainMotion: active,
          motion: motion,
        ),
      ),
    ),
  ),
);

Future<void> _advance(WidgetTester tester, int milliseconds) async {
  for (var elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => AvatarPackGeometry.load(rootBundle, 'grokbot'));
  test('classic is a product preset backed by unchanged community vectors', () {
    final shared = jsonDecode(
      File('../shared/avatar-classic.json').readAsStringSync(),
    );
    expect(classicAvatarTheme, shared['id']);
    expect(
      classicAvatarColor,
      int.parse('ff${shared['color'].substring(1)}', radix: 16),
    );
    expect(classicAvatarShapes, shared['shapes']);
    expect(defaultAvatarTheme, classicAvatarTheme);
    expect(originalAvatarThemes, hasLength(5));
    expect(originalAvatarThemes, isNot(contains(classicAvatarTheme)));
    expect(avatarThemes, hasLength(46));
    expect(avatarThemes.toSet(), hasLength(46));
    expect(
      classicAvatarShapes.values.every(communityAvatarThemes.contains),
      true,
    );
    expect(validAvatarTheme(null), classicAvatarTheme);
    expect(validAvatarTheme('missing-theme'), classicAvatarTheme);
    for (final value in [...originalAvatarThemes, ...communityAvatarThemes]) {
      expect(validAvatarTheme(value), value);
    }
  });

  test(
    'fresh sessions use classic while explicit saved themes survive restart',
    () async {
      for (final saved in [
        null,
        'invalid',
        'companions',
        'pandas',
        'grokbot-leaf',
      ]) {
        final secrets = MemorySecrets();
        if (saved != null) {
          secrets.values['openbot.preferences.v1'] = jsonEncode({
            'avatars': saved,
            'language': 'en',
            'theme': 'dark',
          });
        }
        final session = AppSession(ApiClient(SessionVault(secrets)));
        await session.initialize();
        expect(session.avatarTheme, validAvatarTheme(saved));
        if (saved != null) {
          expect(session.locale.languageCode, 'en');
          expect(session.theme, ThemeMode.dark);
        }
        session.dispose();
      }
    },
  );

  testWidgets(
    'six roles retain their shapes, use black bodies and white vector eyes',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: Row(
              children: [
                for (final shape in classicAvatarShapes.keys)
                  BotAvatar(
                    bot: {'avatar': shape, 'color': '#FF309B'},
                    family: 'classic',
                  ),
              ],
            ),
          ),
        ),
      );
      await waitFor(tester, () => _painted.evaluate().length == 6);
      final faces = tester.widgetList<AvatarPackFace>(
        find.byType(AvatarPackFace),
      );
      expect(faces.map((face) => face.theme), classicAvatarShapes.values);
      for (final paint in tester.widgetList<CustomPaint>(_painted)) {
        final painter = paint.painter! as AvatarPackPainter;
        expect(painter.color, const Color(classicAvatarColor));
        expect(painter.outlineColor, const Color(0xff777777));
        expect(painter.shape.pack.eyeColor, const Color(0xfffffdf7));
        expect(painter.rings.every((eye) => eye.length == 48), true);
        expect(painter.shape.body.getBounds().isEmpty, false);
      }
      await tester.pumpWidget(_scene(reduced: true));
      await waitFor(tester, () => _painted.evaluate().length == 1);
      expect(_painter(tester).outlineColor, isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'classic idle blinks once; the active header repeats and stops offscreen',
    (tester) async {
      await tester.pumpWidget(_scene());
      await waitFor(tester, () => _painted.evaluate().isNotEmpty);
      await tester.pump();
      await _advance(tester, 800);
      expect(_painter(tester).blink, greaterThan(0));
      await _advance(tester, 400);
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      await tester.pumpWidget(_scene(active: true));
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      final slot = _painter(tester).shape.blinkSlot('idle').ceil();
      var laterBlinks = 0;
      for (var elapsed = 0; elapsed < slot + 1000; elapsed += 50) {
        await tester.pump(const Duration(milliseconds: 50));
        if (_painter(tester).blink > 0) laterBlinks++;
      }
      expect(laterBlinks, greaterThan(0));
      await tester.pumpWidget(_scene(active: true, offstage: true));
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(
              find.byType(AvatarPackFace, skipOffstage: false),
            )
            .clockRunning,
        false,
      );
      await tester.pumpWidget(_scene(active: true, reduced: true));
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      expect(_painter(tester).blink, 0);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'task poses stay live; historical results and uploaded fallbacks never loop',
    (tester) async {
      await tester.pumpWidget(
        _scene(active: true, motion: BotAvatarMotion.working),
      );
      await waitFor(tester, () => _painted.evaluate().isNotEmpty);
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        true,
      );
      final working = _painter(tester).rings;
      await tester.pumpWidget(
        _scene(active: true, motion: BotAvatarMotion.done),
      );
      await _advance(tester, 600);
      expect(_painter(tester).rings, isNot(working));
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      await tester.pumpWidget(_scene(active: true, uploaded: true));
      await _advance(tester, 600);
      final face = tester.widget<AvatarPackFace>(find.byType(AvatarPackFace));
      expect(face.blinkWhenIdle, false);
      expect(face.repeatIdleBlink, false);
      expect(face.sustain, false);
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final (language, label) in [('en', 'Classic black'), ('zh', '经典黑')]) {
    testWidgets(
      '$language classic is the first selectable theme on a narrow phone',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = const Size(320, 580);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        String? chosen;
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: SingleChildScrollView(
                child: AvatarThemePicker(
                  selected: 'pandas',
                  onChanged: (value) => chosen = value,
                ),
              ),
            ),
            locale: Locale(language),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          tester.widget<BotAvatar>(find.byType(BotAvatar).first).family,
          'classic',
        );
        expect(find.text(label), findsOneWidget);
        await tester.tap(find.text(label));
        expect(chosen, 'classic');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
