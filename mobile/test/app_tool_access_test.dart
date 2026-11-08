import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/apps/apps_controller.dart';
import 'package:openbot_mobile/features/apps/apps_data.dart';
import 'package:openbot_mobile/features/apps/connection_details.dart';

import 'apps_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

Json _connection({
  String id = 'app-a',
  String revision = 'rev-a',
  bool policy = true,
}) => {
  ...connectedApp(id: id, revision: revision),
  if (policy) 'toolAccessSupported': true,
};

Json _tool({
  String name = 'lookup',
  String revision = 'tool-a',
  bool enabled = true,
}) => {
  'name': name,
  'description': 'Read public release data',
  'inputSchema': {'type': 'object'},
  'access': {'revision': revision, 'enabled': enabled},
};

void main() {
  for (final width in [320.0, 390.0]) {
    final zh = width == 320;
    testWidgets('owner changes exactly one tool on ${width.toInt()}px', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(Size(width, 650));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final writes = <Json>[];
      final f = await fixture((request) async {
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.url.path.endsWith('/tools/access')) {
          expect(request.method, 'PUT');
          writes.add(jsonDecode(request.body) as Json);
          return jsonResponse(_tool(revision: 'tool-b', enabled: false));
        }
        if (request.url.path.endsWith('/tools')) {
          return jsonResponse([_tool(), _tool(name: 'sibling')]);
        }
        return jsonResponse([_connection()]);
      });
      final controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await tester.runAsync(controller.initialize);
      await tester.pumpWidget(
        testApp(
          ConnectionDetails(controller: controller, connectionId: 'app-a'),
          locale: Locale(zh ? 'zh' : 'en'),
        ),
      );
      await waitFor(tester, () => !controller.busy);
      await tester.tap(find.text(zh ? '查看当前工具' : 'View current tools'));
      await waitFor(
        tester,
        () => controller.tools['app-a']?.isNotEmpty == true,
      );
      final toggle = find.descendant(
        of: find.byKey(const ValueKey<dynamic>('lookup')),
        matching: find.byType(SwitchListTile),
      );
      await tester.scrollUntilVisible(
        toggle,
        120,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
      await tester.tap(toggle);
      await waitFor(tester, () => !controller.busy && writes.isNotEmpty);
      expect(writes.single, {
        'toolName': 'lookup',
        'enabled': false,
        'expectedConnectionRevision': 'rev-a',
        'expectedToolRevision': 'tool-a',
      });
      expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
      expect(toolAccess(controller.tools['app-a']!.last)?.enabled, isTrue);
      expect(find.text(zh ? '工具已停用' : 'Tool disabled'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  for (final member in [true, false]) {
    testWidgets(
      member
          ? 'member sees tool policy read-only'
          : 'legacy app shows schemas without a toggle',
      (tester) async {
        var writes = 0;
        final f = await fixture((request) async {
          if (request.method != 'GET') writes++;
          return request.url.path.endsWith('/tools')
              ? jsonResponse([_tool()])
              : jsonResponse([_connection(policy: member)]);
        });
        if (member) f.session.workspace!['role'] = 'member';
        final controller = AppsController(f.scope);
        addTearDown(() {
          controller.dispose();
          f.scope.dispose();
          f.session.dispose();
        });
        await tester.runAsync(controller.initialize);
        await tester.pumpWidget(
          testApp(
            ConnectionDetails(controller: controller, connectionId: 'app-a'),
          ),
        );
        await waitFor(tester, () => !controller.busy);
        await tester.tap(find.text('View current tools'));
        await waitFor(tester, () => find.text('lookup').evaluate().isNotEmpty);
        await tester.tap(find.text('lookup'));
        await tester.pumpAndSettle();
        expect(find.byType(SelectableText), findsNWidgets(2));
        expect(find.byType(SwitchListTile), findsNothing);
        expect(
          find.text('Tool enabled'),
          member ? findsOneWidget : findsNothing,
        );
        await tester.runAsync(
          () => controller.setToolAccess('app-a', 'rev-a', _tool(), false),
        );
        expect(writes, 0);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test('stale conflict refreshes reviewed state without retrying', () async {
    final calls = <String>[];
    var stale = false;
    final f = await fixture((request) async {
      final path = request.url.path;
      calls.add('${request.method} ${path.split('/').last}');
      if (request.method == 'PUT') {
        stale = true;
        return jsonResponse({'code': 'APP_TOOL_ACCESS_CHANGED'}, status: 409);
      }
      if (path.endsWith('/tools')) {
        return jsonResponse([_tool(revision: stale ? 'tool-b' : 'tool-a')]);
      }
      return jsonResponse([_connection(revision: stale ? 'rev-b' : 'rev-a')]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await controller.initialize();
    await controller.loadTools('app-a');
    final reviewed = controller.tools['app-a']!.single;
    await controller.setToolAccess('app-a', 'rev-a', reviewed, false);
    await controller.setToolAccess('app-a', 'rev-a', reviewed, false);
    expect(calls.sublist(calls.indexOf('PUT access')), [
      'PUT access',
      'GET apps',
      'GET tools',
    ]);
    expect(controller.pendingFor('app-a'), isNull);
    expect(controller.find('app-a')?['revision'], 'rev-b');
    expect(toolAccess(controller.tools['app-a']!.single)?.revision, 'tool-b');
    expect(controller.toolFeedback['app-a'], 'mobileAppsToolChanged');
  });

  test(
    'ambiguous receipt remains pending across reopening until exact readback',
    () async {
      var writes = 0;
      var readable = false;
      final f = await fixture((request) async {
        final path = request.url.path;
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        if (request.method == 'PUT') {
          writes++;
          return jsonResponse(
            _tool(name: 'different', revision: 'tool-b', enabled: false),
          );
        }
        if (path.endsWith('/app-a/tools')) {
          if (writes > 0 && !readable) return jsonResponse({}, status: 503);
          return jsonResponse([
            _tool(
              enabled: writes == 0,
              revision: writes == 0 ? 'tool-a' : 'tool-b',
            ),
          ]);
        }
        if (path.endsWith('/app-b/tools')) {
          return jsonResponse([_tool(enabled: false)]);
        }
        return jsonResponse([_connection(), _connection(id: 'app-b')]);
      });
      var controller = AppsController(f.scope);
      addTearDown(() {
        controller.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await controller.initialize();
      await controller.loadTools('app-a');
      await controller.setToolAccess('app-a', 'rev-a', _tool(), false);
      expect(controller.pendingFor('app-a')?['toolName'], 'lookup');
      expect(controller.tools['app-a'], isNull);
      expect(controller.canManageTools('app-a'), isFalse);
      await controller.abandonLocalDraft('app-a');
      expect(controller.pendingFor('app-a'), isNotNull);
      controller.dispose();
      controller = AppsController(f.scope);
      await controller.initialize();
      await controller.loadTools('app-b');
      expect(controller.pendingFor('app-a'), isNotNull);
      expect(controller.toolFeedback['app-b'], isNull);
      readable = true;
      await controller.refresh('app-a');
      expect(writes, 1);
      expect(controller.pendingFor('app-a'), isNull);
      expect(controller.toolFeedback['app-a'], 'mobileAppsToolCurrentDisabled');
    },
  );

  test('late mutation cannot read tools under a different workspace', () async {
    final put = Completer<http.Response>();
    final started = Completer<void>();
    final calls = <String>[];
    final f = await fixture((request) async {
      calls.add('${request.method} ${request.url.path}');
      if (request.method == 'PUT') {
        started.complete();
        return put.future;
      }
      if (request.url.path.endsWith('/tools')) return jsonResponse([_tool()]);
      return jsonResponse([_connection()]);
    });
    final controller = AppsController(f.scope);
    addTearDown(() {
      controller.dispose();
      f.scope.dispose();
      f.session.dispose();
    });
    await controller.initialize();
    await controller.loadTools('app-a');
    final pending = controller.setToolAccess('app-a', 'rev-a', _tool(), false);
    await started.future;
    final count = calls.length;
    final other = {...f.session.workspace!, 'id': 'space-b'};
    f.session.workspaces.add(other);
    f.session.selectWorkspace(other);
    put.complete(jsonResponse(_tool(revision: 'tool-b', enabled: false)));
    await pending;
    expect(calls, hasLength(count));
    expect(controller.tools, isEmpty);
    expect(controller.toolFeedback, isEmpty);
  });
}
