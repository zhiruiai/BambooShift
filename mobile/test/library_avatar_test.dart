import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/library_avatar.dart';
import 'library_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  test('avatar paths bind exact local scope, endpoint, revision and query', () {
    final valid =
        '/api/bot-template-links/$libraryToken/avatar?revision=$libraryRevision';
    expect(safeLibraryAvatar(valid, 'space-a'), true);
    for (final path in [
      'https://outside.test$valid',
      '$valid&redirect=1',
      '$valid&revision=$libraryRevision',
      '/api/workspaces/space-b/bot-templates/$libraryRevision/avatar?revision=$libraryRevision',
      '$valid#fragment',
      '/api/files/avatar?revision=$libraryRevision',
    ]) {
      expect(safeLibraryAvatar(path, 'space-a'), false, reason: path);
    }
  });
  testWidgets(
    'bounded avatar rejects MIME mismatch and malformed RIFF while retaining profile fallback',
    (tester) async {
      for (final mime in ['text/html', 'image/webp']) {
        var requests = 0;
        final f = await fixture((r) async {
          requests++;
          expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
          expect(r.followRedirects, false);
          return http.Response.bytes(
            [1, 2, 3],
            200,
            headers: {'content-type': mime},
          );
        });
        await tester.pumpWidget(
          testApp(
            LibraryAvatar(
              scope: f.scope,
              profile: libraryBlueprint()['profile'],
              path:
                  '/api/bot-template-links/$libraryToken/avatar?revision=$libraryRevision',
              expectedImage: true,
            ),
          ),
        );
        await waitFor(
          tester,
          () => find.text('Avatar image unavailable').evaluate().isNotEmpty,
        );
        expect(requests, 1);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  testWidgets(
    'same avatar path on a replacement scope cancels the old actor bytes and reloads',
    (tester) async {
      final gate = Completer<http.Response>();
      var firstReads = 0, secondReads = 0;
      final a = await fixture((r) async {
        firstReads++;
        return gate.future;
      });
      final b = await fixture((r) async {
        secondReads++;
        return http.Response(
          'invalid',
          200,
          headers: {'content-type': 'text/html'},
        );
      });
      final path =
          '/api/bot-template-links/$libraryToken/avatar?revision=$libraryRevision';
      Widget avatar(scope) => testApp(
        LibraryAvatar(
          key: const ValueKey('same-avatar'),
          scope: scope,
          profile: libraryBlueprint()['profile'],
          path: path,
          expectedImage: true,
        ),
      );
      await tester.pumpWidget(avatar(a.scope));
      await waitFor(tester, () => firstReads == 1);
      await tester.pumpWidget(avatar(b.scope));
      await waitFor(tester, () => secondReads == 1);
      gate.complete(
        http.Response.bytes(
          [82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80],
          200,
          headers: {'content-type': 'image/webp'},
        ),
      );
      await tester.runAsync(() => gate.future);
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      expect(find.text('Avatar image unavailable'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      a.scope.dispose();
      a.session.dispose();
      b.scope.dispose();
      b.session.dispose();
    },
  );
}
