import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/app_session.dart';
import 'package:openbot_mobile/features/apps/add_connection.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';

import 'apps_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const endpoint = 'https://remote.example.test/mcp';
const previewPath = '/api/workspaces/space-a/apps/import/preview';
const importLabel = 'Import MCP configuration';
Finder field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);
String fieldText(WidgetTester tester, String label) =>
    tester.widget<TextField>(field(label)).controller!.text;
Json preview({String name = 'Imported service', String url = endpoint}) => {
  'candidates': [
    {'name': name, 'url': url},
  ],
  'skipped': 0,
  'error': null,
};
String source({String url = endpoint}) => jsonEncode({
  'mcpServers': {
    'Imported service': {
      'url': url,
      'headers': {'Authorization': 'Bearer synthetic-pasted-secret'},
      'env': {'TOKEN': 'synthetic-env-secret'},
      'token': 'synthetic-extra-secret',
    },
  },
});

Future<void> tap(WidgetTester tester, Finder target) async {
  await tester.pump(const Duration(milliseconds: 250));
  if (target.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target,
      120,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await Scrollable.ensureVisible(tester.element(target), alignment: .5);
  await tester.pump(const Duration(milliseconds: 250));
  await Scrollable.ensureVisible(tester.element(target), alignment: .5);
  await tester.tap(target);
  await tester.pump(const Duration(milliseconds: 250));
}

Future<void> until(WidgetTester tester, bool Function() ready) async {
  for (var i = 0; i < 60 && !ready(); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump();
  }
  expect(ready(), isTrue);
}

Future<({AppsController controller, AppSession session})> mount(
  WidgetTester tester, {
  required Future<http.Response> Function(http.Request) handler,
  String role = 'owner',
  bool custom = false,
  String? provider,
  ValueChanged<String>? onConnected,
  Locale locale = const Locale('en'),
  double scale = 1,
}) async {
  final f = await fixture(handler);
  f.session.selectWorkspace({...f.session.workspace!, 'role': role});
  final controller = AppsController(f.scope);
  addTearDown(() {
    controller.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
  await tester.runAsync(controller.initialize);
  await tester.pumpWidget(
    testApp(
      Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: AddConnection(
            controller: controller,
            initialProviderId: provider,
            initialCustomMcp: custom ? (name: 'Remote', url: endpoint) : null,
            onConnected:
                onConnected ?? (custom || provider != null ? (_) {} : null),
          ),
        ),
      ),
      locale: locale,
    ),
  );
  if (!custom) {
    await waitFor(
      tester,
      () => field(
        locale.languageCode == 'zh' ? '应用名称' : 'App name',
      ).evaluate().isNotEmpty,
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
  return (controller: controller, session: f.session);
}

Future<void> inspect(WidgetTester tester, {String? json}) async {
  await tester.drag(find.byType(ListView), const Offset(0, 1000));
  await tester.pump(const Duration(milliseconds: 250));
  await tap(tester, find.text(importLabel));
  await tester.enterText(field('MCP configuration JSON'), json ?? source());
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await tap(tester, find.text('Find remote services'));
}

Future<void> select(
  WidgetTester tester, {
  String url = endpoint,
  String name = 'Imported service',
}) async {
  await tester.drag(find.byType(ListView), const Offset(0, 1000));
  await tester.pump(const Duration(milliseconds: 250));
  await waitFor(
    tester,
    () => find.text('Choose a service').evaluate().isNotEmpty,
  );
  await tap(tester, find.byType(DropdownButtonFormField<String>).first);
  await tap(tester, find.text('$name — $url').last);
}

void main() {
  setUp(() => rootBundle.evict('assets/apps/providers.json'));

  testWidgets(
    'preview is credential-free; cancelling preserves draft and confirmed replacement clears it',
    (tester) async {
      final writes = <http.Request>[];
      await mount(
        tester,
        handler: (request) async {
          if (request.method == 'POST') {
            writes.add(request);
            return jsonResponse(preview());
          }
          return jsonResponse([]);
        },
      );
      await waitFor(
        tester,
        () => find.widgetWithText(ActionChip, 'GitHub').evaluate().isNotEmpty,
      );
      await tap(tester, find.widgetWithText(ActionChip, 'GitHub'));
      await tester.enterText(field('App name'), 'Old draft');
      await tester.enterText(
        field('MCP endpoint (HTTPS)'),
        'https://old.example.test/mcp',
      );
      await tester.enterText(field('Access token'), 'synthetic-old-token');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tap(tester, find.byType(CheckboxListTile));
      for (final cancel in [true, false]) {
        await inspect(tester);
        await until(tester, () => writes.isNotEmpty);
        await select(tester);
        expect(find.byType(SelectableText), findsOneWidget);
        await tap(tester, find.text('Use name and address'));
        expect(find.text('Replace current form'), findsOneWidget);
        expect(fieldText(tester, 'App name'), 'Old draft');
        if (cancel) {
          await tap(tester, find.text('Cancel import'));
          expect(fieldText(tester, 'Access token'), 'synthetic-old-token');
          expect(
            tester
                .widget<CheckboxListTile>(find.byType(CheckboxListTile))
                .value,
            isTrue,
          );
        } else {
          await tap(tester, find.text('Replace current form'));
        }
      }
      expect(fieldText(tester, 'App name'), 'Imported service');
      expect(fieldText(tester, 'MCP endpoint (HTTPS)'), endpoint);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      expect(find.text('No authentication'), findsOneWidget);
      await tap(tester, find.byType(DropdownButtonFormField<String>));
      await tap(tester, find.text('Access token').last);
      expect(fieldText(tester, 'Access token'), isEmpty);
      expect(writes, hasLength(2));
      for (final request in writes) {
        expect(request.url.path, previewPath);
        expect(request.url.host, 'api.example.test');
        expect(jsonDecode(request.body), {
          'candidates': [
            {'name': 'Imported service', 'url': endpoint},
          ],
          'skipped': 0,
        });
      }
      await tester.scrollUntilVisible(
        find.widgetWithText(FilledButton, 'Save connection'),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Save connection'),
            )
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final trailingSlash in [false, true]) {
    testWidgets(
      'official endpoint authentication uses exact address; trailing slash=$trailingSlash',
      (tester) async {
        final url = 'https://mcp.notion.com/mcp${trailingSlash ? '/' : ''}';
        final writes = <String>[];
        await mount(
          tester,
          handler: (request) async {
            if (request.method == 'POST') {
              writes.add(request.url.path);
              return jsonResponse(preview(url: url));
            }
            return jsonResponse([]);
          },
        );
        await inspect(tester, json: source(url: url));
        await select(tester, url: url);
        await tap(tester, find.text('Use name and address'));
        expect(fieldText(tester, 'MCP endpoint (HTTPS)'), url);
        expect(
          find.text(trailingSlash ? 'No authentication' : 'Sign in with OAuth'),
          findsOneWidget,
        );
        expect(writes, [previewPath]);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('a name-only draft still requires replacement confirmation', (
    tester,
  ) async {
    await mount(
      tester,
      handler: (request) async =>
          jsonResponse(request.method == 'POST' ? preview() : []),
    );
    await tester.enterText(field('App name'), 'Unsaved name');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await inspect(tester);
    await select(tester);
    await tap(tester, find.text('Use name and address'));
    expect(find.text('Replace current form'), findsOneWidget);
    expect(fieldText(tester, 'App name'), 'Unsaved name');
    await tap(tester, field('App name'));
    await tester.enterText(field('App name'), 'Changed after warning');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.drag(find.byType(ListView), const Offset(0, 1000));
    await tap(tester, find.text('Replace current form'));
    expect(fieldText(tester, 'App name'), 'Changed after warning');
    expect(find.text('Replace current form'), findsOneWidget);
    await tap(tester, find.text('Replace current form'));
    expect(fieldText(tester, 'App name'), 'Imported service');
    expect(fieldText(tester, 'MCP endpoint (HTTPS)'), endpoint);
    await tester.pumpWidget(const SizedBox());
  });

  for (final mode in ['member', 'custom proposal', 'catalog proposal']) {
    testWidgets('$mode does not expose import', (tester) async {
      var writes = 0;
      await mount(
        tester,
        role: mode == 'member' ? 'member' : 'owner',
        custom: mode == 'custom proposal',
        provider: mode == 'catalog proposal' ? 'notion' : null,
        handler: (request) async {
          if (request.method != 'GET') writes++;
          return jsonResponse([]);
        },
      );
      expect(find.text(importLabel), findsNothing);
      expect(writes, 0);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('older service preview failure leaves manual entry available', (
    tester,
  ) async {
    final writes = <String>[];
    await mount(
      tester,
      handler: (request) async {
        if (request.method == 'POST') {
          writes.add(request.url.path);
          return jsonResponse({
            'error': {'code': 'NOT_FOUND', 'message': 'Not found'},
          }, status: 404);
        }
        return jsonResponse([]);
      },
    );
    await inspect(tester);
    await waitFor(
      tester,
      () => find
          .textContaining('Update your BambooShift service')
          .evaluate()
          .isNotEmpty,
    );
    await tap(tester, find.text('Cancel import'));
    await tester.enterText(field('App name'), 'Manual service');
    await tester.enterText(field('MCP endpoint (HTTPS)'), endpoint);
    expect(fieldText(tester, 'App name'), 'Manual service');
    expect(fieldText(tester, 'MCP endpoint (HTTPS)'), endpoint);
    expect(writes, [previewPath]);
    await tester.pumpWidget(const SizedBox());
  });

  for (final action in ['cancel', 'permission', 'workspace', 'close']) {
    testWidgets('late preview cannot fill a draft after $action', (
      tester,
    ) async {
      final response = Completer<http.Response>();
      var previews = 0;
      final f = await mount(
        tester,
        handler: (request) async {
          if (request.method == 'POST') {
            expect(request.url.path, previewPath);
            previews++;
            return response.future;
          }
          return jsonResponse([]);
        },
      );
      addTearDown(() {
        if (!response.isCompleted) response.complete(jsonResponse(preview()));
      });
      await inspect(tester);
      await until(tester, () => previews == 1);
      if (action == 'cancel') {
        await tap(tester, find.text('Cancel import'));
      } else if (action == 'permission') {
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
        await tester.pump();
        f.session.selectWorkspace({...f.session.workspace!, 'role': 'owner'});
        await tester.pump();
      } else if (action == 'workspace') {
        final next = {...f.session.workspace!, 'id': 'space-b'};
        f.session.workspaces.add(next);
        f.session.selectWorkspace(next);
        await tester.pump();
      } else {
        await tester.pumpWidget(const SizedBox());
      }
      response.complete(jsonResponse(preview()));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Use name and address'), findsNothing);
      expect(find.text('Choose a service'), findsNothing);
      if (action == 'cancel' || action == 'permission') {
        expect(fieldText(tester, 'App name'), isEmpty);
        expect(fieldText(tester, 'MCP endpoint (HTTPS)'), isEmpty);
        await tap(tester, find.text(importLabel));
        expect(fieldText(tester, 'MCP configuration JSON'), isEmpty);
      }
      expect(previews, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets(
    'review refresh cannot reuse a connection after consent was revoked',
    (tester) async {
      final response = Completer<http.Response>();
      var refreshing = false, entered = false, selected = 0, writes = 0;
      final f = await mount(
        tester,
        custom: true,
        onConnected: (_) => selected++,
        handler: (request) async {
          if (request.method != 'GET') writes++;
          if (refreshing) {
            entered = true;
            return response.future;
          }
          return jsonResponse([]);
        },
      );
      await tap(tester, find.byType(CheckboxListTile));
      refreshing = true;
      await tap(tester, find.widgetWithText(FilledButton, 'Save connection'));
      await until(tester, () => entered);
      f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
      f.session.selectWorkspace({...f.session.workspace!, 'role': 'owner'});
      response.complete(jsonResponse([connectedApp()..['url'] = endpoint]));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pumpAndSettle();
      expect(selected, 0);
      expect(writes, 0);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final language in ['en', 'zh']) {
    testWidgets(
      'import preview remains usable at 320px with large $language text',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(320, 700);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final chinese = language == 'zh';
        await mount(
          tester,
          locale: Locale(language),
          scale: 1.4,
          handler: (request) async =>
              jsonResponse(request.method == 'POST' ? preview() : []),
        );
        await tap(tester, find.text(chinese ? '导入 MCP 配置' : importLabel));
        await tester.enterText(
          field(chinese ? 'MCP 配置 JSON' : 'MCP configuration JSON'),
          source(),
        );
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tap(
          tester,
          find.text(chinese ? '识别远程服务' : 'Find remote services'),
        );
        final choose = chinese ? '选择一个服务' : 'Choose a service';
        await waitFor(tester, () => find.text(choose).evaluate().isNotEmpty);
        await tap(tester, find.byType(DropdownButtonFormField<String>).first);
        await tap(tester, find.text('Imported service — $endpoint').last);
        await tap(
          tester,
          find.text(chinese ? '填入名称和地址' : 'Use name and address'),
        );
        expect(
          fieldText(tester, chinese ? '应用名称' : 'App name'),
          'Imported service',
        );
        expect(
          fieldText(tester, chinese ? 'MCP 地址（HTTPS）' : 'MCP endpoint (HTTPS)'),
          endpoint,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
