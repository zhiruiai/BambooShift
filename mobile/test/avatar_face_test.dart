import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:openbot_mobile/core/third_party_licenses.dart';
import 'package:openbot_mobile/widgets/avatar_face.dart';
import 'package:openbot_mobile/widgets/avatar_face_art.dart';
import 'package:openbot_mobile/widgets/avatar_face_geometry.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'widgets_test.dart' show testApp;

Future<void> waitFor(WidgetTester tester, bool Function() ready) async {
  for (var i = 0; i < 100 && !ready(); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump();
  }
  expect(ready(), true);
}

const themes = ['companions', 'pandas', 'dinosaurs', 'chicks', 'elephants'];
const shapes = ['orb', 'drop', 'leaf', 'arch', 'spark', 'gem'];
const states = [
  null,
  BotAvatarMotion.thinking,
  BotAvatarMotion.working,
  BotAvatarMotion.attention,
  BotAvatarMotion.done,
  BotAvatarMotion.error,
];

AvatarFacePainter facePainter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(find.byType(CustomPaint))
    .map((widget) => widget.painter)
    .whereType<AvatarFacePainter>()
    .first;

void main() {
  setUp(() {
    // Widget tests own separate asynchronous asset channels and decode work.
    svg.cache.clear();
    rootBundle.clear();
  });
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'all thirty vector forms and shared motion data are available unchanged on mobile',
    () async {
      expect(
        await File('assets/avatars/avatar-face-motion.json').readAsBytes(),
        await File('../shared/avatar-face-motion.json').readAsBytes(),
      );
      final rules = await AvatarFaceRules.load(rootBundle);
      for (final theme in themes) {
        for (final shape in shapes) {
          final source = await rootBundle.loadString(
            'assets/avatars/$theme/$shape.svg',
          );
          final layers = splitAvatarFace(source);
          expect(layers, hasLength(2), reason: '$theme/$shape');
          if (theme == 'pandas') expect(layers!.first, contains('<ellipse'));
          if (shape == 'arch' && rules.theme(theme)['shapeTilt'] == true) {
            expect(layers!.last, contains('M17 25H29M36 25H48'));
          }
        }
        for (final state in [
          'idle',
          'thinking',
          'working',
          'attention',
          'done',
          'error',
        ]) {
          final pose = rules.pose(state);
          for (var index = 0; index < 2; index++) {
            final path = avatarEyePath(
              rules.theme(theme)['eyes'][index],
              pose,
              index,
            );
            expect(path.getBounds().isEmpty, false);
            expect(
              const Rect.fromLTWH(
                0,
                0,
                64,
                64,
              ).contains(path.getBounds().topLeft),
              true,
            );
            expect(
              const Rect.fromLTWH(
                0,
                0,
                64,
                64,
              ).contains(path.getBounds().bottomRight),
              true,
            );
          }
        }
      }
    },
  );

  test(
    'the original MIT text is bundled and registered with Flutter licenses',
    () async {
      final original = await File(
        '../legal/third-party/boopface-0.8.0/LICENSE',
      ).readAsString();
      expect(
        await rootBundle.loadString('assets/licenses/boopface-LICENSE.txt'),
        original,
      );
      registerBundledLicenses();
      final license = await LicenseRegistry.licenses.firstWhere(
        (entry) => entry.packages.contains('BoopFace eye-pose interpolation'),
      );
      expect(
        license.paragraphs.map((p) => p.text).join('\n'),
        contains('Copyright (c) 2026 CX ART Lab'),
      );
    },
  );

  testWidgets(
    'working eyes stop offstage, offscreen, in the background and with motion disabled',
    (tester) async {
      final scroll = ScrollController();
      addTearDown(scroll.dispose);
      Widget scene({
        bool reduced = false,
        bool ticker = true,
        bool offstage = false,
      }) => testApp(
        MediaQuery(
          data: MediaQueryData(
            size: const Size(800, 600),
            disableAnimations: reduced,
          ),
          child: Scaffold(
            body: TickerMode(
              enabled: ticker,
              child: Offstage(
                offstage: offstage,
                child: SingleChildScrollView(
                  controller: scroll,
                  child: Column(
                    children: [
                      BotAvatar(
                        bot: const {'avatar': 'orb'},
                        family: 'pandas',
                        motion: BotAvatarMotion.working,
                        sustainMotion: true,
                      ),
                      const SizedBox(height: 1600),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpWidget(scene());
      await waitFor(
        tester,
        () => find.byKey(const ValueKey('avatar-face')).evaluate().isNotEmpty,
      );
      final state = tester.state<AvatarFaceState>(find.byType(AvatarFace));
      await tester.pump(const Duration(milliseconds: 100));
      expect(state.clockRunning, true);
      final initial = facePainter(tester).gaze;
      await tester.pump(const Duration(milliseconds: 300));
      expect(facePainter(tester).gaze, isNot(initial));

      scroll.jumpTo(900);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 40));
      expect(
        state.clockRunning,
        false,
        reason: 'The retained offscreen child must stop',
      );
      scroll.jumpTo(0);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 40));
      expect(state.clockRunning, true);

      await tester.pumpWidget(scene(ticker: false));
      expect(state.clockRunning, false);
      await tester.pumpWidget(scene(offstage: true));
      await tester.pump();
      expect(state.clockRunning, false);
      await tester.pumpWidget(scene());
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(state.clockRunning, false);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(state.clockRunning, true);

      await tester.pumpWidget(scene(reduced: true));
      expect(state.clockRunning, false);
      final fixed = facePainter(tester).gaze;
      await tester.pump(const Duration(seconds: 5));
      expect(facePainter(tester).gaze, fixed);
      expect(facePainter(tester).blink, 0);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'all themes show distinct static expressions at 24 and 32 pixels without moving their bodies',
    (tester) async {
      final boundary = GlobalKey();
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      canvas.drawRect(
        const Rect.fromLTWH(0, 0, 864, 1280),
        Paint()..color = const Color(0xfff7f8fa),
      );
      final pictures = <ui.Image>[];
      try {
        for (var row = 0; row < themes.length; row++) {
          for (final size in [24.0, 32.0]) {
            List<int>? reference;
            final hashes = <String>{};
            for (var column = 0; column < states.length; column++) {
              await tester.pumpWidget(
                testApp(
                  MediaQuery(
                    data: const MediaQueryData(disableAnimations: true),
                    child: Center(
                      child: RepaintBoundary(
                        key: boundary,
                        child: BotAvatar(
                          key: ValueKey((themes[row], size, states[column])),
                          bot: const {'avatar': 'orb', 'color': '#22aa77'},
                          family: themes[row],
                          size: size,
                          motion: states[column],
                          blinkWhenIdle: true,
                        ),
                      ),
                    ),
                  ),
                ),
              );
              await waitFor(
                tester,
                () => find
                    .byKey(const ValueKey('avatar-face'))
                    .evaluate()
                    .isNotEmpty,
              );
              await tester.pump();
              expect(
                tester
                    .state<AvatarFaceState>(find.byType(AvatarFace))
                    .clockRunning,
                false,
              );
              final image = await tester.runAsync(
                () =>
                    (boundary.currentContext!.findRenderObject()!
                            as RenderRepaintBoundary)
                        .toImage(pixelRatio: 4),
              );
              final data = await tester.runAsync(() => image!.toByteData());
              final bytes = data!.buffer.asUint8List();
              hashes.add(bytes.toString());
              final first = reference;
              if (first == null) {
                reference = bytes.toList();
              } else {
                for (var y = 0; y < image!.height; y++) {
                  for (var x = 0; x < image.width; x++) {
                    if (x >= image.width * .2 &&
                        x <= image.width * .8 &&
                        y >= image.height * .25 &&
                        y <= image.height * .68) {
                      continue;
                    }
                    final index = (y * image.width + x) * 4;
                    expect(
                      bytes.sublist(index, index + 4),
                      first.sublist(index, index + 4),
                      reason:
                          'Only the eyes may change: ${themes[row]} ${states[column]}',
                    );
                  }
                }
              }
              expect(bytes.any((value) => value != 0), true);
              canvas.drawImage(
                image!,
                Offset(column * 144.0, row * 256.0 + (size == 24 ? 0 : 112)),
                Paint(),
              );
              pictures.add(image);
            }
            expect(
              hashes,
              hasLength(6),
              reason: '${themes[row]} at $size pixels',
            );
          }
        }
        final artifact = Platform.environment['BAMBOOSHIFT_AVATAR_EVIDENCE'];
        final picture = recorder.endRecording();
        if (artifact != null) {
          await tester.runAsync(() async {
            final image = await picture.toImage(864, 1280);
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            await File(artifact).writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
        }
        picture.dispose();
        await tester.pumpWidget(const SizedBox());
      } finally {
        for (final image in pictures) {
          image.dispose();
        }
      }
      expect(tester.takeException(), isNull);
    },
  );
}
