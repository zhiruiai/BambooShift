import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/core/community_avatar_catalog.g.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_picker.dart';
import 'package:openbot_mobile/widgets/avatar_pack_face.dart';
import 'package:openbot_mobile/widgets/avatar_pack_geometry.dart';
import 'package:openbot_mobile/widgets/avatar_pack_painter.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'widgets_test.dart' show testApp;

Future<void> waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 150 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump();
  }
  expect(ready(), true);
}

Finder get _painted => find.byWidgetPredicate(
  (widget) => widget is CustomPaint && widget.painter is AvatarPackPainter,
);
AvatarPackPainter _painter(WidgetTester tester) =>
    tester.widget<CustomPaint>(_painted.first).painter! as AvatarPackPainter;

Widget _scene({
  String theme = 'grokbot-bean',
  String state = 'working',
  bool reduced = false,
  bool offstage = false,
  AssetBundle? bundle,
}) {
  Widget child = MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(500, 500),
        disableAnimations: reduced,
      ),
      child: Center(
        child: Offstage(
          offstage: offstage,
          child: SizedBox.square(
            dimension: 64,
            child: AvatarPackFace(
              theme: theme,
              color: const Color(0xff5686df),
              state: state,
              sustain: true,
            ),
          ),
        ),
      ),
    ),
  );
  if (bundle != null) child = DefaultAssetBundle(bundle: bundle, child: child);
  return child;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final evidenceFont = Platform.environment['BAMBOOSHIFT_EVIDENCE_FONT'];
  setUpAll(() async {
    if (evidenceFont == null) return;
    final loader = FontLoader('CommunityEvidence')
      ..addFont(File(evidenceFont).readAsBytes().then(ByteData.sublistView));
    await loader.load();
  });
  test(
    'all 40 themes, 25 GrokBot expressions and native corrections decode',
    () async {
      expect(communityAvatarThemes.length, 40);
      for (final family in ['open-avatar', 'grokbot']) {
        final pack = await AvatarPackGeometry.load(rootBundle, family);
        for (final theme in communityAvatarThemes.where(
          (value) => communityAvatarGroups[value] == family,
        )) {
          expect(validAvatarTheme(theme), theme);
          final shape = pack.shape(theme.substring(family.length + 1));
          expect(shape.body.getBounds().isEmpty, false);
          for (final state in [
            'idle',
            'thinking',
            'working',
            'attention',
            'done',
            'error',
          ]) {
            for (final expression in shape.expressionIds(state)) {
              final rings = shape.pose(expression);
              expect(rings.length, 2);
              expect(rings.every((ring) => ring.length == 48), true);
              expect(
                rings
                    .expand((ring) => ring)
                    .every((p) => p.dx.isFinite && p.dy.isFinite),
                true,
              );
            }
          }
        }
      }
      expect(validAvatarTheme('grokbot-untrusted'), defaultAvatarTheme);
    },
  );

  testWidgets(
    'live native rings transition from the displayed pose and stop on completion',
    (tester) async {
      await tester.pumpWidget(_scene());
      await waitFor(tester, () => _painted.evaluate().isNotEmpty);
      await tester.pump(const Duration(milliseconds: 200));
      final before = _painter(tester);
      final displayed = displayEyeRings(
        before.rings,
        before.gaze,
        before.blink,
      );
      await tester.pumpWidget(_scene(state: 'done'));
      expect(_painter(tester).rings, displayed);
      await tester.pump(const Duration(milliseconds: 120));
      expect(_painter(tester).rings, isNot(displayed));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      final complete = _painter(tester).rings;
      await tester.pumpWidget(_scene(state: 'error'));
      expect(_painter(tester).rings, complete);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(_painter(tester).rings, isNot(complete));
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'offstage, paused lifecycle and reduced motion stop active community avatars',
    (tester) async {
      await tester.pumpWidget(_scene());
      await waitFor(tester, () => _painted.evaluate().isNotEmpty);
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        true,
      );
      await tester.pumpWidget(_scene(offstage: true));
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(
              find.byType(AvatarPackFace, skipOffstage: false),
            )
            .clockRunning,
        false,
      );
      await tester.pumpWidget(_scene());
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpWidget(_scene(reduced: true));
      await tester.pump();
      expect(
        tester
            .state<AvatarPackFaceState>(find.byType(AvatarPackFace))
            .clockRunning,
        false,
      );
      expect(_painter(tester).blink, 0);
      expect(_painter(tester).gaze, Offset.zero);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'late prior-pack loads cannot replace the current selected theme',
    (tester) async {
      final bundle = _DelayedBundle();
      await tester.pumpWidget(_scene(theme: 'open-avatar-cat', bundle: bundle));
      await tester.pumpWidget(_scene(theme: 'grokbot-leaf', bundle: bundle));
      await waitFor(tester, () => _painted.evaluate().isNotEmpty);
      expect(_painter(tester).shape.pack.family, 'grokbot');
      bundle.gate.complete();
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(_painter(tester).shape.pack.family, 'grokbot');
      expect(_painter(tester).shape.descriptor['sourceName'], 'leaf');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'the last shape in either group remains reachable on a narrow phone',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(320, 580);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      String selected = 'companions';
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: ListView(
              children: [
                AvatarThemePicker(
                  selected: selected,
                  onChanged: (value) => selected = value,
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final group = find.text('Community GrokBot');
      await tester.ensureVisible(group);
      await tester.tap(group);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Leaf'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Leaf'));
      expect(selected, 'grokbot-leaf');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'all community artwork renders at small sizes without external assets',
    (tester) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(900, 1060);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(
            fontFamily: evidenceFont == null ? null : 'CommunityEvidence',
          ),
          home: RepaintBoundary(
            key: key,
            child: Material(
              color: Colors.white,
              child: GridView.count(
                crossAxisCount: 5,
                childAspectRatio: 1.4,
                padding: const EdgeInsets.all(12),
                children: [
                  for (final theme in communityAvatarThemes)
                    Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          communityAvatarLabels[theme]!['en']!,
                          style: const TextStyle(fontSize: 13),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            for (final motion in [
                              null,
                              BotAvatarMotion.done,
                              BotAvatarMotion.error,
                            ])
                              BotAvatar(
                                bot: const {
                                  'avatar': 'orb',
                                  'color': '#7384DB',
                                },
                                family: theme,
                                size: motion == null ? 24 : 32,
                                motion: motion,
                                useDeviceTheme: false,
                              ),
                          ],
                        ),
                        const SizedBox(height: 5),
                        const Text(
                          'idle · done · error',
                          style: TextStyle(fontSize: 10, color: Colors.grey),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      );
      await waitFor(tester, () => _painted.evaluate().length == 120);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final destination =
          Platform.environment['BAMBOOSHIFT_COMMUNITY_AVATAR_EVIDENCE'];
      if (destination != null) {
        await tester.runAsync(() async {
          final image =
              await (key.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(destination).writeAsBytes(data!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
}

class _DelayedBundle extends CachingAssetBundle {
  final gate = Completer<void>();
  @override
  Future<ByteData> load(String key) async {
    if (key.contains('/open-avatar/')) await gate.future;
    return rootBundle.load(key);
  }
}
