import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/core/community_avatar_catalog.g.dart';
import 'package:openbot_mobile/widgets/avatar_appearance.dart';
import 'package:openbot_mobile/widgets/avatar_pack_face.dart';
import 'package:openbot_mobile/widgets/avatar_pack_painter.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Map<String, dynamic> recipe(String motif) => {
  'name': 'Library companions',
  'motif': motif,
  'colors': ['#667788', '#998877', '#556633'],
  'badge': 'star',
  'backdrop': 'halo',
};

void main() {
  test('generated community recipes retain every catalog motif', () {
    for (final motif in communityAvatarThemes) {
      final theme = GeneratedAvatarTheme.parse(recipe(motif));
      expect(theme, isNotNull, reason: motif);
      expect(theme!.toJson(), recipe(motif));
    }
    expect(GeneratedAvatarTheme.parse(recipe('grokbot-unknown')), isNull);
  });

  for (final motif in ['open-avatar-cat', 'grokbot-bean']) {
    testWidgets(
      'generated $motif survives remote sync and uses its native renderer',
      (tester) async {
        var remote = <String, dynamic>{
          'theme': {
            'avatarTheme': motif,
            'customAvatarTheme': recipe(motif),
            'useCustomAvatarTheme': true,
          },
          'revision': 1,
        };
        var writes = 0;
        final f = await fixture((request) async {
          expect(request.url.path, '/api/workspaces/space-a/avatar-theme');
          if (request.method == 'PUT') {
            writes++;
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            expect(body['theme']['customAvatarTheme']['motif'], motif);
            expect(body['theme']['useCustomAvatarTheme'], true);
            remote = {'theme': body['theme'], 'revision': 2};
          }
          return jsonResponse(remote);
        });
        await tester.runAsync(() => f.session.avatarSync.reload());
        expect(f.session.customAvatarTheme?.motif, motif);
        expect(f.session.useCustomAvatarTheme, true);
        await tester.pumpWidget(
          testApp(
            Scaffold(
              body: Center(
                child: AvatarAppearance(
                  session: f.session,
                  child: const BotAvatar(
                    bot: {'avatar': 'leaf'},
                    family: 'companions',
                    size: 48,
                  ),
                ),
              ),
            ),
          ),
        );
        final painted = find.byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is AvatarPackPainter,
        );
        await waitFor(tester, () => painted.evaluate().isNotEmpty);
        expect(find.byType(GeneratedAvatarDecoration), findsOneWidget);
        expect(
          tester.widget<AvatarPackFace>(find.byType(AvatarPackFace)).theme,
          motif,
        );
        expect(
          (tester.widget<CustomPaint>(painted).painter! as AvatarPackPainter)
              .color,
          const Color(0xff556633),
        );

        final updated = GeneratedAvatarTheme.parse({
          ...recipe(motif),
          'name': 'Saved companions',
        })!;
        await f.session.preferences(
          customAvatar: updated,
          useCustomAvatar: true,
        );
        await tester.runAsync(
          () => f.session.avatarSync.save(f.session.avatarSelection),
        );
        await tester.runAsync(() => f.session.avatarSync.reload());
        expect(writes, 1);
        expect(f.session.customAvatarTheme?.motif, motif);
        expect(f.session.customAvatarTheme?.name, 'Saved companions');
        expect(f.session.useCustomAvatarTheme, true);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
}
