import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/auth/auth_screen.dart';
import 'package:openbot_mobile/features/bots/bot_settings.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';
import 'package:openbot_mobile/features/routines/routine_editor.dart';
import 'package:openbot_mobile/features/routines/routines_screen.dart';
import 'package:openbot_mobile/features/settings/account_settings.dart';
import 'package:openbot_mobile/features/settings/model_settings.dart';
import 'package:openbot_mobile/features/settings/team_settings.dart';
import 'package:openbot_mobile/features/settings/workspace_settings.dart';
import 'package:openbot_mobile/l10n/strings.dart';
import 'package:openbot_mobile/theme.dart';

import 'support.dart';
import 'model_profile_support.dart';
import 'widgets_test.dart' show waitFor;

class LayoutStrings extends LocalizationsDelegate<Strings> {
  const LayoutStrings();
  @override
  bool isSupported(Locale locale) => true;
  @override
  Future<Strings> load(Locale locale) => SynchronousFuture(
    Strings(locale, {
      for (final catalog in Strings.catalogs)
        ...jsonDecode(
              File(
                'assets/l10n/${catalog}_${locale.languageCode}.arb',
              ).readAsStringSync(),
            )
            as Json,
    }),
  );
  @override
  bool shouldReload(LayoutStrings old) => false;
}

Future<void> loadCaptureFonts() async {
  final latin = File(
    '../.tools/flutter/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf',
  );
  if (!latin.existsSync()) return;
  final loader = FontLoader('CaptureSans')
    ..addFont(SynchronousFuture(ByteData.sublistView(latin.readAsBytesSync())));
  await loader.load();
  final chinese = File('/System/Library/Fonts/STHeiti Medium.ttc');
  if (chinese.existsSync()) {
    await (FontLoader('CaptureChinese')..addFont(
          SynchronousFuture(ByteData.sublistView(chinese.readAsBytesSync())),
        ))
        .load();
  }
}

void expectReadableText(InlineSpan span, [double? inherited]) {
  final size = span.style?.fontSize ?? inherited;
  if (span is TextSpan) {
    if ((span.text ?? '').trim().isNotEmpty) {
      expect(size, isNotNull);
      expect(size, greaterThanOrEqualTo(12));
    }
    for (final child in span.children ?? <InlineSpan>[]) {
      expectReadableText(child, size);
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadCaptureFonts);
  for (final lang in ['zh', 'en']) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'phone layout $lang ${brightness.name} uses native real pages',
        (tester) async {
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final models = ModelsServer();
          final f = await fixture((request) async {
            if (request.url.path.endsWith('/model-profiles')) {
              return models.handle(request);
            }
            return jsonResponse(
              request.url.path.endsWith('/sessions')
                  ? {'userId': 'user-a', 'sessions': []}
                  : {'members': [], 'invitations': []},
            );
          });
          final bot = {
            'id': 'bot-a',
            'name': lang == 'zh' ? '研究助手' : 'Research partner',
            'role': lang == 'zh'
                ? '整理信息，协助你做决定'
                : 'Research and clear decisions',
            'description': '',
            'instructions': '',
            'avatar': 'orb',
            'color': '#76568d',
            'configRevision': 'revision',
          };
          f.scope.data = bootstrap(
            agents: [bot],
            messages: [
              {
                'id': 'input-a',
                'conversationId': 'chat-a',
                'role': 'user',
                'userId': 'user-a',
                'content': lang == 'zh'
                    ? '帮我整理今天的工作重点。'
                    : 'Help me plan my priorities for today.',
                'createdAt': '2026-01-01T09:00:00Z',
                'status': 'done',
              },
              {
                'id': 'reply-a',
                'conversationId': 'chat-a',
                'agentId': 'bot-a',
                'role': 'assistant',
                'content': lang == 'zh'
                    ? '我们可以先列出最重要的三件事，再为每件事安排一小段专注时间。你今天最想完成什么？'
                    : 'We can identify three priorities and reserve focused time for each. What would you most like to finish today?',
                'createdAt': '2026-01-01T09:00:01Z',
                'status': 'done',
              },
            ],
          );
          f.scope.data!['settings'] = {'configured': true};
          f.scope.data!['routines'] = [
            {
              'id': 'routine-a',
              'agentId': 'bot-a',
              'conversationId': 'chat-a',
              'title': 'Synthetic review',
              'prompt': 'Synthetic progress only.',
              'schedule': 'daily:09:00',
              'timeZone': 'Asia/Shanghai',
              'enabled': true,
              'nextRunAt': '2026-11-07T01:00:00Z',
            },
          ];
          for (final entry in <String, Widget>{
            'sign-in': AuthScreen(session: f.session),
            'chat': ChatScreen(scope: f.scope, conversationId: 'chat-a'),
            'bot-settings': BotSettings(scope: f.scope, bot: bot),
            'account-settings': AccountSettings(session: f.session),
            'team-settings': TeamSettings(scope: f.scope),
            'model-settings': ModelSettings(scope: f.scope),
            'routines': RoutinesScreen(scope: f.scope, agentId: 'bot-a'),
            'routine-editor': RoutineEditor(scope: f.scope, agentId: 'bot-a'),
            'workspace-settings': Scaffold(
              appBar: AppBar(
                title: Text(lang == 'zh' ? '工作空间设置' : 'Workspace settings'),
              ),
              body: WorkspaceSettings(scope: f.scope),
            ),
          }.entries) {
            final boundary = GlobalKey();
            await tester.pumpWidget(
              MaterialApp(
                key: ValueKey(entry.key),
                locale: Locale(lang),
                supportedLocales: Strings.supported,
                localizationsDelegates: const [
                  LayoutStrings(),
                  GlobalMaterialLocalizations.delegate,
                  GlobalWidgetsLocalizations.delegate,
                  GlobalCupertinoLocalizations.delegate,
                ],
                theme: openBotTheme(brightness).copyWith(
                  textTheme: openBotTheme(brightness).textTheme.apply(
                    fontFamily: 'CaptureSans',
                    fontFamilyFallback: ['CaptureChinese'],
                  ),
                ),
                home: RepaintBoundary(key: boundary, child: entry.value),
              ),
            );
            if (entry.key == 'model-settings') {
              final controller =
                  (tester.state(find.byType(ModelSettings)) as dynamic)
                      .controller;
              await waitFor(
                tester,
                () =>
                    controller.ready && !controller.loading && !controller.busy,
              );
            } else {
              await tester.pumpAndSettle();
            }
            expect(
              tester.takeException(),
              isNull,
              reason: '${entry.key} $lang ${brightness.name}',
            );
            for (final paragraph in tester.renderObjectList<RenderParagraph>(
              find.byType(RichText),
            )) {
              expectReadableText(paragraph.text);
            }
            final directory = Platform.environment['OPENBOT_MOBILE_CAPTURE'];
            if (directory != null) {
              final render =
                  boundary.currentContext!.findRenderObject()
                      as RenderRepaintBoundary;
              final image = await render.toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await tester.runAsync(() async {
                await Directory(directory).create(recursive: true);
                await File(
                  '$directory/${entry.key}-$lang-${brightness.name}.png',
                ).writeAsBytes(bytes!.buffer.asUint8List());
              });
              image.dispose();
            }
          }
          await tester.pumpWidget(const SizedBox());
          f.scope.dispose();
          f.session.dispose();
        },
      );
    }
  }
}
