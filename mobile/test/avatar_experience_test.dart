import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/avatar_crop.dart';
import 'package:openbot_mobile/features/bots/avatar_crop_dialog.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/settings/avatar_theme_picker.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';
import 'package:openbot_mobile/widgets/avatar_face.dart';
import 'package:openbot_mobile/widgets/avatar_face_art.dart';
import 'package:openbot_mobile/widgets/avatar_pack_face.dart';

import 'action_card_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _source = '10000000-0000-4000-8000-000000000000';
const _asset = '20000000-0000-4000-8000-000000000000';
const _root = '/api/workspaces/space-a/bot-avatars';
const _png =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMod1lV7rKKAUIBACZOBZU+JU+sAAAAAElFTkSuQmCC';
const _webp =
    'UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoCAAIAAUAmJaACdLoABGaAAP7vUS/+Wf+f3xd6nPbsXboIAAA=';

http.Response _photo() => http.Response.bytes(
  base64Decode(_webp),
  200,
  headers: {'content-type': 'image/webp'},
);

void main() {
  setUp(() {
    // Widget tests own separate asynchronous asset channels and decode work.
    svg.cache.clear();
    rootBundle.clear();
  });
  testWidgets('theme previews fit and save the selection on a narrow phone', (
    tester,
  ) async {
    tester.view
      ..devicePixelRatio = 1
      ..physicalSize = const Size(320, 580);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final f = await fixture((_) async => jsonResponse({}));
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: AnimatedBuilder(
            animation: f.session,
            builder: (_, _) => ListView(
              padding: const EdgeInsets.all(20),
              children: [
                AvatarThemePicker(
                  selected: f.session.avatarTheme,
                  onChanged: (value) => f.session.preferences(avatars: value),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await waitFor(
      tester,
      () => find.byType(AvatarPackFace).evaluate().isNotEmpty,
    );
    expect(find.byType(BotAvatar), findsNWidgets(18));
    await tester.ensureVisible(find.text('Elephants'));
    await tester.tap(find.text('Elephants'));
    await tester.pumpAndSettle();
    await waitFor(
      tester,
      () => find.byKey(const ValueKey('avatar-face')).evaluate().isNotEmpty,
    );
    expect(f.session.avatarTheme, 'elephants');
    expect(f.secrets.values['openbot.preferences.v1'], contains('elephants'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets(
    'only the active chat header blinks once and respects reduced motion',
    (tester) async {
      final f = await fixture((_) async => jsonResponse({}));
      await f.session.preferences(avatars: 'companions');
      f.scope.data = bootstrap(
        agents: [
          {'id': 'bot-a', 'name': 'Research', 'avatar': 'orb'},
        ],
        messages: [
          {
            'id': 'previous-reply',
            'conversationId': 'chat-a',
            'role': 'assistant',
            'kind': 'text',
            'status': 'done',
            'agentId': 'bot-a',
            'content': 'Historical reply',
          },
        ],
      );
      Widget scene({bool reduced = false}) => testApp(
        MediaQuery(
          data: MediaQueryData(disableAnimations: reduced),
          child: ChatScreen(scope: f.scope, conversationId: 'chat-a'),
        ),
      );

      final enabled = find.byWidgetPredicate(
        (widget) =>
            widget is AvatarFace &&
            widget.blinkWhenIdle &&
            widget.state == 'idle',
      );
      final blink = find.byWidgetPredicate(
        (widget) =>
            widget is CustomPaint &&
            widget.painter is AvatarFacePainter &&
            (widget.painter! as AvatarFacePainter).blink > 0,
      );
      await tester.pumpWidget(scene());
      expect(
        find.descendant(of: find.byType(AppBar), matching: enabled),
        findsOneWidget,
      );
      expect(enabled, findsOneWidget);
      expect(blink, findsNothing);
      for (
        var attempt = 0;
        attempt < 300 && blink.evaluate().isEmpty;
        attempt++
      ) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(blink, findsOneWidget);
      for (var i = 0; i < 7; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(blink, findsNothing);
      await tester.pump(const Duration(seconds: 2));
      expect(blink, findsNothing);

      await tester.pumpWidget(scene(reduced: true));
      await tester.pumpAndSettle();
      expect(enabled, findsOneWidget);
      expect(tester.state<AvatarFaceState>(enabled).clockRunning, false);
      expect(blink, findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('only current-thread actions for this user hold the idle blink', (
    tester,
  ) async {
    final f = await fixture((_) async => jsonResponse({}));
    await f.session.preferences(avatars: 'companions');
    Json question(String requester) => {
      'id': 'question-a',
      'conversationId': 'chat-a',
      'role': 'assistant',
      'kind': 'question',
      'status': 'done',
      'agentId': 'bot-a',
      'metadata': {
        'question': {
          'version': 1,
          'question': 'Which note should I prepare?',
          'mode': 'single',
          'runId': 'run-a',
          'requester': {'userId': requester, 'messageId': 'input-a'},
          'options': [
            {'id': 'summary', 'label': 'Summary'},
            {'id': 'report', 'label': 'Full report'},
          ],
          'status': 'pending',
        },
      },
    };
    Future<void> show(List<Json> messages) async {
      f.scope.data = bootstrap(
        agents: [
          {'id': 'bot-a', 'name': 'Research'},
        ],
        messages: messages,
      );
      await tester.pumpWidget(
        testApp(ChatScreen(scope: f.scope, conversationId: 'chat-a')),
      );
    }

    final enabled = find.byWidgetPredicate(
      (widget) =>
          widget is AvatarFace &&
          widget.blinkWhenIdle &&
          widget.state == 'idle',
    );
    await show([
      actionMessage(requester: 'user-b'),
      question('user-b'),
      actionMessage()..['threadRootId'] = 'another-thread',
    ]);
    expect(enabled, findsOneWidget);
    await show([question('user-a')]);
    expect(enabled, findsNothing);
    await show([actionMessage(kind: 'computer')]);
    expect(enabled, findsNothing);
    await show([actionMessage(status: 'done')]);
    expect(enabled, findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('workspace avatars show the uploaded image and clear on logout', (
    tester,
  ) async {
    var reads = 0;
    final f = await fixture((request) async {
      reads++;
      expect(request.method, 'GET');
      expect(request.url.path, '$_root/$_asset');
      expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
      expect(request.followRedirects, false);
      return _photo();
    });
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: BotAvatar(
            scope: f.scope,
            bot: const {'name': 'Research', 'avatarImageId': _asset},
            family: 'pandas',
            blinkWhenIdle: true,
          ),
        ),
      ),
    );
    await waitFor(tester, () => find.byType(Image).evaluate().isNotEmpty);
    expect(find.byType(AvatarFace), findsNothing);
    expect(reads, 1);
    f.session.user = null;
    f.session.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsNothing);
    expect(find.byType(SvgPicture), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  test('avatar crop stays within the source pixel bounds', () {
    final source = AvatarSource(_source, 400, 200);
    expect(source.crop(1, .5, .5), (left: 100, top: 0, size: 200));
    expect(source.crop(4, 1, 1), (left: 350, top: 150, size: 50));
    expect(
      AvatarSource.parse({'id': _source, 'width': 40000000, 'height': 2}),
      isNull,
    );
  });

  for (final camera in [false, true]) {
    final source = camera ? 'camera photo' : 'selected image';
    testWidgets('$source is staged, cropped and released in one scope', (
      tester,
    ) async {
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = camera ? const Size(393, 829) : const Size(320, 580);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <(String, String)>[];
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(request.followRedirects, false);
        final operation = (request.method, request.url.path);
        calls.add(operation);
        switch (operation) {
          case ('POST', '$_root/sources'):
            expect(request.headers['Content-Type'], 'image/png');
            if (camera) {
              expect(
                request.bodyBytes.sublist(0, 8),
                base64Decode(_png).sublist(0, 8),
              );
              expect(latin1.decode(base64Decode(_png)), contains('pHYs'));
              expect(latin1.decode(request.bodyBytes), isNot(contains('pHYs')));
            } else {
              expect(request.bodyBytes, base64Decode(_png));
            }
            return jsonResponse({
              'id': _source,
              'width': 400,
              'height': 200,
              'previewWidth': 400,
              'previewHeight': 200,
            }, status: 201);
          case ('GET', '$_root/sources/$_source'):
            return _photo();
          case ('POST', _root):
            expect(jsonDecode(request.body), {
              'sourceId': _source,
              'crop': {'left': 100, 'top': 0, 'size': 200},
            });
            return jsonResponse({
              'id': _asset,
              'width': 512,
              'height': 512,
              'mimeType': 'image/webp',
            }, status: 201);
          case ('DELETE', '$_root/sources/$_source'):
            return http.Response('', 204);
          default:
            fail('Unexpected avatar request ${request.method} ${request.url}');
        }
      });
      final photo = XFile.fromData(
        base64Decode(_png),
        path: 'portrait.png',
        name: 'portrait.png',
      );
      String? chosen;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: Builder(
              builder: (context) => FilledButton(
                onPressed: () async => chosen = await showDialog<String>(
                  context: context,
                  builder: (_) => AvatarCropDialog(
                    scope: f.scope,
                    selectAvatar: () async => photo,
                    checkCamera: () async => camera,
                    captureAvatar: () async => photo,
                  ),
                ),
                child: const Text('Edit'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Edit'));
      await tester.pumpAndSettle();
      expect(calls, isEmpty);
      expect(find.text('Choose image'), findsOneWidget);
      final take = find.text('Take photo');
      expect(take, camera ? findsOneWidget : findsNothing);
      if (camera) {
        await tester.runAsync(() async {
          await tester.tap(take);
          for (var attempt = 0; attempt < 100 && calls.length < 2; attempt++) {
            await Future<void>.delayed(const Duration(milliseconds: 5));
          }
        });
      } else {
        await tester.tap(find.text('Choose image'));
      }
      await waitFor(tester, () => find.byType(Slider).evaluate().isNotEmpty);
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('Crop avatar').hitTestable(), findsOneWidget);
      expect(find.text('Use this crop').hitTestable(), findsOneWidget);
      expect(calls, [
        ('POST', '$_root/sources'),
        ('GET', '$_root/sources/$_source'),
      ]);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Use this crop'));
      await waitFor(tester, () => chosen != null);
      expect(chosen, _asset);
      expect(calls, [
        ('POST', '$_root/sources'),
        ('GET', '$_root/sources/$_source'),
        ('POST', _root),
        ('DELETE', '$_root/sources/$_source'),
      ]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }

  testWidgets('camera cancel, denial and stale target do not upload a photo', (
    tester,
  ) async {
    final f = await fixture((request) async {
      fail('Unexpected avatar request ${request.method} ${request.url}');
    });
    final pending = Completer<XFile?>();
    var attempts = 0;
    var targetCurrent = true;
    await tester.pumpWidget(
      testApp(
        AvatarCropDialog(
          scope: f.scope,
          checkCamera: () async => true,
          targetCurrent: () => targetCurrent,
          captureAvatar: () async {
            attempts++;
            if (attempts == 1) return null;
            if (attempts == 2) {
              throw PlatformException(code: 'camera_access_denied');
            }
            return pending.future;
          },
        ),
        locale: const Locale('zh'),
      ),
    );
    await tester.pumpAndSettle();
    final capture = find.widgetWithText(OutlinedButton, '拍照');
    await tester.tap(capture);
    await tester.pumpAndSettle();
    expect(find.byType(Slider), findsNothing);
    expect(tester.widget<OutlinedButton>(capture).onPressed, isNotNull);
    await tester.tap(capture);
    await tester.pumpAndSettle();
    expect(find.textContaining('无法访问相机'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '选择图片'), findsOneWidget);
    await tester.tap(capture);
    await tester.pump();
    targetCurrent = false;
    f.scope.notifyListeners();
    pending.complete(
      XFile.fromData(base64Decode(_png), path: 'stale.png', name: 'stale.png'),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<OutlinedButton>(capture).onPressed, isNull);
    expect(find.byType(Slider), findsNothing);
    expect(attempts, 3);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
