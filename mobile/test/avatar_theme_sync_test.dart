import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/app_session.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/features/settings/device_settings.dart';
import 'package:openbot_mobile/features/workspaces/workspace_screen.dart';
import 'package:openbot_mobile/widgets/avatar_appearance.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'generated_avatar_theme_test.dart' show themeData;
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _personal = '/api/workspaces/space-a/avatar-theme';
const _team = '/api/workspaces/space-b/avatar-theme';
const _spaceB = {
  'id': 'space-b',
  'name': 'Team fixture',
  'kind': 'team',
  'role': 'member',
  'status': 'active',
};
final _recipe = GeneratedAvatarTheme.parse(themeData)!;

Map<String, dynamic> _theme(String family, {bool custom = false}) => {
  'avatarTheme': family,
  'customAvatarTheme': custom ? _recipe.toJson() : null,
  'useCustomAvatarTheme': custom,
};

Map<String, dynamic> _response(Map<String, dynamic>? theme, int revision) => {
  'theme': theme,
  'revision': revision,
};

void _teamMembership(AppSession session) {
  session.workspaces = [...session.workspaces, _spaceB];
}

void main() {
  test(
    'remote overlay is scoped while device preference stays independent',
    () async {
      final methods = <String>[];
      final f = await fixture((request) async {
        methods.add(request.method);
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        return switch (request.url.path) {
          _personal => jsonResponse(
            _response(_theme('pandas', custom: true), 1),
          ),
          _team => jsonResponse(_response(null, 0)),
          '/api/account/logout' => jsonResponse({'ok': true}),
          _ => throw StateError('Unexpected path'),
        };
      });
      _teamMembership(f.session);
      final personal = f.session.workspace!;
      await f.session.preferences(avatars: 'chicks');
      await f.session.avatarSync.reload();
      expect(f.session.avatarTheme, 'pandas');
      expect(f.session.customAvatarTheme?.name, _recipe.name);
      expect(f.session.useCustomAvatarTheme, isTrue);
      await f.session.preferences(avatars: 'elephants');
      expect(f.session.avatarSync.hasDraft, isTrue);
      expect(f.session.avatarTheme, 'elephants');
      expect(f.session.useCustomAvatarTheme, isFalse);
      expect(f.secrets.values['openbot.preferences.v1'], contains('chicks'));
      expect(
        f.secrets.values['openbot.preferences.v1'],
        isNot(contains(_recipe.name)),
      );

      f.session.selectWorkspace(_spaceB);
      expect(f.session.avatarTheme, 'chicks');
      expect(f.session.customAvatarTheme, isNull);
      await f.session.avatarSync.reload();
      expect(f.session.avatarTheme, 'chicks');
      expect(f.session.avatarSync.hasDraft, isFalse);
      f.session.selectWorkspace(personal);
      await f.session.avatarSync.reload();
      expect(f.session.avatarTheme, 'pandas');
      expect(f.session.avatarSync.hasDraft, isFalse);
      await f.session.signOut();
      expect(f.session.avatarTheme, 'chicks');
      expect(f.session.customAvatarTheme, isNull);
      expect(f.session.workspaceId, isNull);
      expect(methods, ['GET', 'GET', 'GET', 'POST']);
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'late GET and PUT from old scopes cannot override new settings',
    () async {
      final oldRead = Completer<http.Response>();
      final oldWrite = Completer<http.Response>();
      final oldReadStarted = Completer<void>();
      final oldWriteStarted = Completer<void>();
      var personalReads = 0;
      final f = await fixture((request) {
        if (request.url.path == _personal && request.method == 'PUT') {
          oldWriteStarted.complete();
          return oldWrite.future;
        }
        if (request.url.path == _personal && personalReads++ == 0) {
          oldReadStarted.complete();
          return oldRead.future;
        }
        return Future.value(
          jsonResponse(
            request.url.path == _team
                ? _response(_theme('dinosaurs'), 2)
                : _response(_theme('elephants'), 1),
          ),
        );
      });
      _teamMembership(f.session);
      final personal = f.session.workspace!, sync = f.session.avatarSync;
      final first = sync.reload();
      await oldReadStarted.future;
      f.session.selectWorkspace(_spaceB);
      await sync.reload();
      oldRead.complete(jsonResponse(_response(_theme('chicks'), 4)));
      await first;
      expect(f.session.avatarTheme, 'dinosaurs');

      f.session.selectWorkspace(personal);
      await sync.reload();
      await f.session.preferences(avatars: 'pandas');
      final save = sync.save(f.session.avatarSelection);
      await oldWriteStarted.future;
      f.session.selectWorkspace(_spaceB);
      await sync.reload();
      f.session.selectWorkspace(personal);
      await sync.reload();
      oldWrite.complete(jsonResponse(_response(_theme('pandas'), 2)));
      await save;
      expect(f.session.avatarTheme, 'elephants');
      expect(sync.problem, isNull);
      expect(sync.hasDraft, isFalse);

      f.session.user = {'id': 'user-b'};
      expect(f.session.avatarTheme, defaultAvatarTheme);
      expect(sync.canSave(f.session.avatarSelection), isFalse);
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test('conflict or lost response blocks writes until read back', () async {
    var remote = _response(_theme('pandas', custom: true), 3);
    var writes = 0;
    final f = await fixture((request) async {
      expect(request.url.path, _personal);
      if (request.method == 'GET') return jsonResponse(remote);
      expect(request.method, 'PUT');
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      writes++;
      expect(body['theme']['customAvatarTheme'], _recipe.toJson());
      expect(body['theme']['useCustomAvatarTheme'], isFalse);
      if (writes == 1) {
        expect(body['revision'], 3);
        remote = _response(_theme('dinosaurs'), 4);
        return jsonResponse({
          'code': 'AVATAR_THEME_CONFLICT',
          'error': 'Version changed',
        }, status: 409);
      }
      expect(body['revision'], 4);
      remote = _response(body['theme'], 5);
      throw http.ClientException('Synthetic lost response');
    });
    final sync = f.session.avatarSync;
    await sync.reload();
    await f.session.preferences(avatars: 'chicks');
    await sync.save(f.session.avatarSelection);
    expect(sync.problem, 'avatarThemeSyncConflict');
    expect(sync.canSave(f.session.avatarSelection), isFalse);
    await sync.save(f.session.avatarSelection);
    expect(writes, 1);
    await sync.reload();
    expect(f.session.avatarTheme, 'chicks');
    expect(sync.hasDraft, isTrue);
    expect(sync.canSave(f.session.avatarSelection), isTrue);
    await sync.save(f.session.avatarSelection);
    expect(sync.problem, 'avatarThemeSyncUnknown');
    expect(sync.canSave(f.session.avatarSelection), isFalse);
    await sync.reload();
    expect(writes, 2);
    expect(sync.problem, isNull);
    expect(sync.hasDraft, isFalse);
    expect(f.session.avatarTheme, 'chicks');
    expect(f.session.useCustomAvatarTheme, isFalse);
    expect(sync.canSave(f.session.avatarSelection), isFalse);
    expect(f.secrets.values['openbot.preferences.v1'], isNull);
    f.scope.dispose();
    f.session.dispose();
  });

  test(
    'readback preserves a newer local preview after an uncertain save',
    () async {
      var remote = _response(_theme('pandas'), 1);
      final f = await fixture((request) async {
        if (request.method == 'GET') return jsonResponse(remote);
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        remote = _response(body['theme'], 2);
        throw http.ClientException('Synthetic lost response');
      });
      final sync = f.session.avatarSync;
      await sync.reload();
      await f.session.preferences(avatars: 'chicks');
      await sync.save(f.session.avatarSelection);
      await f.session.preferences(avatars: 'elephants');
      await sync.reload();
      expect(f.session.avatarTheme, 'elephants');
      expect(sync.hasDraft, isTrue);
      sync.discard();
      expect(f.session.avatarTheme, 'chicks');
      f.scope.dispose();
      f.session.dispose();
    },
  );

  test(
    'read failure keeps device fallback and a later good read applies it',
    () async {
      var reads = 0;
      final f = await fixture((request) async {
        expect(request.method, 'GET');
        return jsonResponse(
          _response(
            reads++ == 0
                ? {..._theme('pandas'), 'useCustomAvatarTheme': true}
                : _theme('pandas'),
            1,
          ),
        );
      });
      final sync = f.session.avatarSync;
      await f.session.preferences(avatars: 'elephants');
      await sync.reload();
      expect(f.session.avatarTheme, 'elephants');
      expect(sync.problem, 'avatarThemeSyncReadFailed');
      expect(sync.canSave(f.session.avatarSelection), isFalse);
      await sync.reload();
      expect(f.session.avatarTheme, 'pandas');
      expect(sync.problem, isNull);
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('opening a workspace reads its theme without an opt-in write', (
    tester,
  ) async {
    var reads = 0;
    final f = await fixture((request) async {
      expect(request.method, 'GET');
      if (request.url.path == _personal) {
        reads++;
        return jsonResponse(_response(_theme('elephants'), 4));
      }
      return jsonResponse(bootstrap());
    });
    await tester.pumpWidget(testApp(WorkspaceScreen(session: f.session)));
    await waitFor(tester, () => f.session.avatarTheme == 'elephants');
    expect(reads, 1);
    expect(f.secrets.values['openbot.preferences.v1'], isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('a mounted Bot updates the built-in artwork when sync changes', (
    tester,
  ) async {
    final f = await fixture((request) async {
      expect(request.url.path, _personal);
      return jsonResponse(_response(_theme('elephants'), 1));
    });
    await tester.pumpWidget(
      testApp(
        AvatarAppearance(
          session: f.session,
          child: const Scaffold(
            body: BotAvatar(bot: {'name': 'Fixture'}, family: 'pandas'),
          ),
        ),
      ),
    );
    String artwork() {
      final provider = tester
          .widget<SvgPicture>(find.byType(SvgPicture))
          .bytesLoader;
      return (provider as SvgAssetLoader).assetName;
    }

    expect(artwork(), 'assets/avatars/companions/orb.svg');
    await tester.runAsync(f.session.avatarSync.reload);
    await tester.pump();
    expect(artwork(), 'assets/avatars/elephants/orb.svg');
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  for (final (locale, width) in [('zh', 320.0), ('en', 390.0)]) {
    testWidgets(
      '$locale narrow settings save and remove explicitly for a team member',
      (tester) async {
        tester.view
          ..devicePixelRatio = 1
          ..physicalSize = Size(width, 680);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        var remote = _response(null, 0);
        final writes = <Map<String, dynamic>>[];
        final f = await fixture((request) async {
          expect(request.url.path, _personal);
          if (request.method == 'GET') return jsonResponse(remote);
          expect(request.method, 'PUT');
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          writes.add(body);
          remote = _response(body['theme'], (body['revision'] as int) + 1);
          return jsonResponse(remote);
        });
        f.session.workspace = {
          ...f.session.workspace!,
          'kind': 'team',
          'role': 'member',
        };
        await tester.runAsync(f.session.avatarSync.reload);
        await tester.pumpWidget(
          testApp(
            DeviceSettings(session: f.session, scope: f.scope),
            locale: Locale(locale),
          ),
        );
        final zh = locale == 'zh';
        Future<void> tap(String label) async {
          final target = find.text(label);
          await tester.scrollUntilVisible(target, 170);
          await tester.ensureVisible(target);
          await tester.pump();
          await tester.tap(target);
          await tester.pump();
        }

        await tap(zh ? '小鸡' : 'Chicks');
        expect(writes, isEmpty);
        expect(f.session.avatarTheme, 'chicks');
        await tap(zh ? '保存主题到此空间' : 'Save theme to this workspace');
        await waitFor(tester, () => f.session.avatarSync.synced);
        expect(writes, [_response(_theme('chicks'), 0)]);
        await tap(zh ? '大象' : 'Elephants');
        expect(writes, hasLength(1));
        expect(f.session.avatarTheme, 'elephants');
        expect(f.session.avatarSync.hasDraft, isTrue);
        await tap(zh ? '恢复已同步主题' : 'Restore synced theme');
        expect(f.session.avatarTheme, 'chicks');
        await tap(zh ? '使用设备主题' : 'Use device theme');
        await tester.pumpAndSettle();
        expect(writes, hasLength(1));
        await tester.tap(find.text(zh ? '完成' : 'Done'));
        await waitFor(tester, () => !f.session.avatarSync.synced);
        expect(writes.last, _response(null, 1));
        expect(f.session.avatarTheme, 'chicks');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.scope.dispose();
        f.session.dispose();
      },
    );
  }
}
