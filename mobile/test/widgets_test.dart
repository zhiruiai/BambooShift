import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/features/auth/auth_screen.dart';
import 'package:openbot_mobile/features/bots/bot_form.dart';
import 'package:openbot_mobile/features/bots/bot_settings.dart';
import 'package:openbot_mobile/features/bots/create_screen.dart';
import 'package:openbot_mobile/l10n/strings.dart';
import 'package:openbot_mobile/theme.dart';
import 'package:openbot_mobile/widgets/bot_avatar.dart';

import 'support.dart';

Widget testApp(Widget child, {Locale locale = const Locale('en')}) =>
    MaterialApp(
      locale: locale,
      supportedLocales: Strings.supported,
      localizationsDelegates: const [
        TestStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: openBotTheme(Brightness.light),
      home: child,
    );

class TestStringsDelegate extends LocalizationsDelegate<Strings> {
  const TestStringsDelegate();
  @override
  bool isSupported(Locale locale) => Strings.supported.contains(locale);
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
  bool shouldReload(TestStringsDelegate old) => false;
}

Future<void> waitFor(WidgetTester tester, bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump();
  }
  expect(ready(), isTrue);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('sign in uses the configured server and real account response', (
    tester,
  ) async {
    Json? sent;
    final f = await fixture((request) async {
      sent = jsonDecode(request.body) as Json;
      expect(request.url.path, '/api/account/login');
      return jsonResponse({
        'authenticated': true,
        'user': {
          'id': 'new-user',
          'email': 'person@example.test',
          'name': 'Example',
        },
        'workspaces': [],
      });
    });
    f.session.user = null;
    f.session.workspace = null;
    await tester.pumpWidget(testApp(AuthScreen(session: f.session)));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextFormField).at(0),
      'person@example.test',
    );
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'synthetic-password',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await waitFor(tester, () => !f.session.busy);
    expect(sent, {
      'email': 'person@example.test',
      'password': 'synthetic-password',
    });
    expect(
      f.session.userId,
      'new-user',
      reason: 'error=${f.session.error}; busy=${f.session.busy}',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
  testWidgets(
    'group creation requires two unique Bots and retains a lost request',
    (tester) async {
      Json? sent;
      final f = await fixture((request) async {
        sent = jsonDecode(request.body) as Json;
        throw http.ClientException('Synthetic lost result');
      });
      f.scope.data = bootstrap(
        agents: [
          {'id': 'a', 'name': 'Research', 'role': 'Research', 'avatar': 'orb'},
          {'id': 'b', 'name': 'Review', 'role': 'Review', 'avatar': 'drop'},
        ],
      );
      await tester.pumpWidget(
        testApp(CreateScreen(scope: f.scope, kind: 'group')),
      );
      await tester.pumpAndSettle();
      await waitFor(tester, () => find.byType(ListView).evaluate().isNotEmpty);
      await tester.scrollUntilVisible(
        find.widgetWithText(FilledButton, 'Create'),
        150,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Create'))
            .onPressed,
        isNull,
      );
      await tester.scrollUntilVisible(
        find.byType(TextFormField).first,
        -150,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.enterText(find.byType(TextFormField).first, 'Useful group');
      await tester.tap(find.byType(CheckboxListTile).at(0));
      await tester.pump();
      await tester.scrollUntilVisible(
        find.widgetWithText(FilledButton, 'Create'),
        150,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Create'))
            .onPressed,
        isNull,
      );
      await tester.scrollUntilVisible(
        find.byType(CheckboxListTile).at(1),
        -150,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.byType(CheckboxListTile).at(1));
      await tester.pump();
      await tester.ensureVisible(find.widgetWithText(FilledButton, 'Create'));
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await waitFor(
        tester,
        () => find.text('Check result').evaluate().isNotEmpty,
      );
      expect(sent?['agentIds'], ['a', 'b']);
      expect(sent?['kind'], 'group');
      expect(find.text('Check result'), findsOneWidget);
      expect(find.text('Close unaccepted request'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets(
    'members can view Bot profiles but cannot save shared configuration',
    (tester) async {
      var requests = 0;
      final f = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      f.session.workspace!['role'] = 'member';
      await tester.pumpWidget(
        testApp(
          BotSettings(
            scope: f.scope,
            bot: {
              'id': 'bot-a',
              'name': 'Example',
              'role': 'Helper',
              'description': '',
              'instructions': '',
              'avatar': 'orb',
              'color': '#76568d',
              'configRevision': 'r',
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
      for (final field in tester.widgetList<TextFormField>(
        find.byType(TextFormField),
      )) {
        expect(field.enabled, isFalse);
      }
      expect(requests, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
  testWidgets('Chinese labels and every avatar family use native widgets', (
    tester,
  ) async {
    Json changed = {};
    for (final family in avatarThemes) {
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SingleChildScrollView(
              child: BotForm(
                key: ValueKey(family),
                initial: {'name': 'Example', 'role': 'Helper'},
                enabled: true,
                family: family,
                onChanged: (value) => changed = value,
              ),
            ),
          ),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('名字'), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
    await tester.enterText(find.byType(TextFormField).first, 'Updated');
    expect(changed['name'], 'Updated');
  });
  testWidgets(
    'both themes keep every resolved text style at least twelve pixels',
    (tester) async {
      for (final brightness in Brightness.values) {
        late ThemeData theme;
        await tester.pumpWidget(
          MaterialApp(
            theme: openBotTheme(brightness),
            home: Builder(
              builder: (context) {
                theme = Theme.of(context);
                return const SizedBox();
              },
            ),
          ),
        );
        final t = theme.textTheme;
        for (final style in [
          t.displayLarge,
          t.displayMedium,
          t.displaySmall,
          t.headlineLarge,
          t.headlineMedium,
          t.headlineSmall,
          t.titleLarge,
          t.titleMedium,
          t.titleSmall,
          t.bodyLarge,
          t.bodyMedium,
          t.bodySmall,
          t.labelLarge,
          t.labelMedium,
          t.labelSmall,
        ]) {
          expect(style!.fontSize, greaterThanOrEqualTo(12));
        }
        expect(
          theme.inputDecorationTheme.errorStyle!.fontSize,
          greaterThanOrEqualTo(12),
        );
      }
    },
  );
  test('avatar accent changes preserve eyes and neutral artwork colors', () {
    const mapper = AvatarColorMapper(Color(0xff336699));
    expect(
      mapper.substitute(null, 'path', 'fill', const Color(0xff8b5cf6)),
      const Color(0xff336699),
    );
    expect(
      mapper.substitute(null, 'path', 'fill', const Color(0xff292733)),
      const Color(0xff292733),
    );
    expect(
      mapper.substitute(null, 'path', 'fill', const Color(0xfffffdf7)),
      const Color(0xfffffdf7),
    );
    const leafMapper = AvatarColorMapper(
      Color(0xff336699),
      baseColor: Color(0xff24b78c),
    );
    expect(leafMapper, isNot(mapper));
    expect(
      leafMapper.substitute(null, 'path', 'fill', const Color(0xff24b78c)),
      const Color(0xff336699),
    );
  });
}
