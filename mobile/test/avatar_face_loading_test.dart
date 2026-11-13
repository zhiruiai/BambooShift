import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:openbot_mobile/widgets/avatar_face.dart';
import 'package:openbot_mobile/widgets/avatar_face_art.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'widgets_test.dart' show testApp;

class _DelayedBundle extends CachingAssetBundle {
  final pending = <String, Completer<String>>{};
  @override
  Future<ByteData> load(String key) => rootBundle.load(key);
  @override
  Future<String> loadString(String key, {bool cache = true}) =>
      pending[key]?.future ?? rootBundle.loadString(key, cache: cache);
}

Future<void> _prepared(WidgetTester tester) async {
  for (
    var i = 0;
    i < 100 && find.byKey(const ValueKey('avatar-face')).evaluate().isEmpty;
    i++
  ) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump();
  }
  expect(find.byKey(const ValueKey('avatar-face')), findsOneWidget);
}

void main() {
  setUp(() {
    // Widget tests own separate asynchronous asset channels and decode work.
    svg.cache.clear();
    rootBundle.clear();
  });
  testWidgets(
    'late old-theme data cannot repaint a replacement theme or retain its color',
    (tester) async {
      final bundle = _DelayedBundle();
      const panda = 'assets/avatars/pandas/orb.svg';
      final pending = Completer<String>();
      bundle.pending[panda] = pending;
      Widget scene(String theme, Color color) => testApp(
        DefaultAssetBundle(
          bundle: bundle,
          child: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: Center(
              child: SizedBox.square(
                dimension: 44,
                child: AvatarFace(
                  asset: 'assets/avatars/$theme/orb.svg',
                  theme: theme,
                  shape: 'orb',
                  state: 'done',
                  colorMapper: AvatarColorMapper(color),
                  fallback: const SizedBox(key: ValueKey('fallback')),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpWidget(scene('pandas', Colors.green));
      expect(find.byKey(const ValueKey('fallback')), findsOneWidget);
      await tester.pumpWidget(scene('elephants', Colors.pink));
      await _prepared(tester);
      AvatarFacePainter painter() => tester
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .map((w) => w.painter)
          .whereType<AvatarFacePainter>()
          .single;
      final rendered = painter();
      expect(rendered.theme['eyes'][0][0], 25);
      pending.complete(
        await tester.runAsync(() => rootBundle.loadString(panda)),
      );
      await tester.runAsync(() => pending.future);
      await tester.pump();
      expect(painter().layers, same(rendered.layers));
      expect(painter().theme, same(rendered.theme));

      final failure = Completer<String>();
      bundle.pending[panda] = failure;
      await tester.pumpWidget(scene('pandas', Colors.blue));
      expect(find.byKey(const ValueKey('fallback')), findsOneWidget);
      expect(find.byKey(const ValueKey('avatar-face')), findsNothing);
      failure.completeError(StateError('Synthetic unavailable asset'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('fallback')), findsOneWidget);
      expect(find.byKey(const ValueKey('avatar-face')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'historical completion is static and live transitions begin at the displayed pose',
    (tester) async {
      Widget scene(BotAvatarMotion motion) => testApp(
        Center(
          child: BotAvatar(
            bot: const {'avatar': 'orb'},
            family: 'pandas',
            motion: motion,
          ),
        ),
      );
      AvatarFacePainter painter() => tester
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .map((w) => w.painter)
          .whereType<AvatarFacePainter>()
          .single;
      await tester.pumpWidget(scene(BotAvatarMotion.done));
      await _prepared(tester);
      final state = tester.state<AvatarFaceState>(find.byType(AvatarFace));
      expect(state.clockRunning, false);
      expect(painter().pose['pupilOpacity'], 0);
      await tester.pumpWidget(scene(BotAvatarMotion.working));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      final previous = painter().pose;
      expect(previous['pupilOpacity'], greaterThan(0));
      expect(previous['pupilOpacity'], lessThan(1));
      await tester.pumpWidget(scene(BotAvatarMotion.attention));
      expect(painter().pose.values, previous.values);
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(painter().pose['width'], 1.13);
      expect(state.clockRunning, false);
      await tester.pumpWidget(scene(BotAvatarMotion.working));
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      final working = painter().pose;
      await tester.pumpWidget(scene(BotAvatarMotion.done));
      expect(painter().pose.values, working.values);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      expect(painter().pose['pupilOpacity'], greaterThan(0));
      expect(painter().pose['pupilOpacity'], lessThan(1));
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(painter().pose['pupilOpacity'], 0);
      expect(state.clockRunning, false);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
