import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/collaboration/team_avatar.dart';
import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

void main() {
  test(
    'reviewed avatars use only the target asset or exact shared grant path',
    () async {
      final f = await fixture((_) async => jsonResponse({}));
      expect(
        teamAvatarPath(f.scope, {'avatarImageId': planId}),
        '/api/workspaces/space-a/bot-avatars/$planId',
      );
      final path = '/api/shared-bots/$planId/avatar?revision=${'a' * 64}';
      expect(
        teamAvatarPath(f.scope, {
          'avatarImageId': originalRequest,
          'sharedBot': {'shareId': planId, 'avatarPath': path},
        }),
        path,
      );
      for (final bad in [
        'https://untrusted.example.test$path',
        '$path&token=x',
        '$path#fragment',
        '/api/workspaces/other/bot-avatars/$planId',
      ]) {
        expect(
          teamAvatarPath(f.scope, {
            'avatarImageId': originalRequest,
            'sharedBot': {'shareId': planId, 'avatarPath': bad},
          }),
          isNull,
        );
      }
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets('late avatar bytes cannot render after account change', (
    tester,
  ) async {
    final gate = Completer<http.Response>();
    var calls = 0;
    final f = await fixture((request) {
      calls++;
      expect(request.method, 'GET');
      expect(request.url.path, '/api/workspaces/space-a/bot-avatars/$planId');
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      return gate.future;
    });
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: TeamAvatar(
            scope: f.scope,
            profile: {...profile('bot-a'), 'avatarImageId': planId},
          ),
        ),
      ),
    );
    await waitFor(tester, () => calls == 1);
    f.session.user = {'id': 'user-b'};
    f.session.notifyListeners();
    gate.complete(
      http.Response.bytes(
        [0, 1, 2],
        200,
        headers: {'content-type': 'image/webp'},
      ),
    );
    await tester.runAsync(() => gate.future);
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
