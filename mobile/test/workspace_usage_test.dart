import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/usage/usage_controller.dart';
import 'package:openbot_mobile/features/usage/usage_data.dart';
import 'package:openbot_mobile/features/usage/usage_screen.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;
import 'model_profiles_layout_test.dart' show expectReadableText;

Json totals() => {
  'modelTurns': 3,
  'reportedTurns': 2,
  'unreportedTurns': 1,
  'inputTokens': 100,
  'outputTokens': 20,
  'cacheReadTokens': 5,
  'cacheWriteTokens': 2,
  'totalTokens': 127,
};
Json usage({int days = 30, String visibility = 'workspace'}) => {
  'scope': {
    'workspaceId': 'space-a',
    'userId': 'user-a',
    'visibility': visibility,
  },
  'period': {
    'days': days,
    'since': '2026-10-01T00:00:00Z',
    'until': '2026-10-30T14:00:00Z',
    'timeZone': 'UTC',
  },
  'totals': totals(),
  'byDay': [
    {'day': '2026-10-30', 'totals': totals()},
  ],
  'byBot': [
    {'agentId': null, 'name': null, 'totals': totals()},
    {'agentId': 'deleted', 'name': null, 'totals': totals()},
  ],
  'byModel': [
    {'provider': 'synthetic', 'model': 'synthetic-model', 'totals': totals()},
  ],
  'cost': null,
};
void main() {
  test(
    'usage captures actor and range, rejects wrong identity and invalid accounting',
    () async {
      final f = await fixture((r) async {
        expect(r.method, 'GET');
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        expect(r.url.path, '/api/workspaces/space-a/usage');
        expect(r.url.query, 'days=7');
        return jsonResponse(usage(days: 7));
      });
      final c = UsageController(f.scope);
      await c.refresh(7);
      expect(c.data?['totals']['unreportedTurns'], 1);
      expect(c.data?['cost'], null);
      for (final mutate in <void Function(Json)>[
        (v) => v['scope']['userId'] = 'peer',
        (v) => v['scope']['workspaceId'] = 'other',
        (v) => v['scope']['visibility'] = 'self',
        (v) => v['period']['timeZone'] = 'Asia/Shanghai',
        (v) => v['period']['days'] = 90,
        (v) => v['totals']['reportedTurns'] = 4,
        (v) => v['totals']['inputTokens'] = -1,
        (v) => v['cost'] = 0,
      ]) {
        final value = usage();
        mutate(value);
        expect(
          () => checkedUsage(value, 'user-a', 'space-a', 30, true),
          throwsA(isA<ApiException>()),
        );
      }
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test('member usage is self-only, downgrade clears broader totals', () async {
    var self = false;
    final f = await fixture(
      (_) async => jsonResponse(usage(visibility: self ? 'self' : 'workspace')),
    );
    final c = UsageController(f.scope);
    await c.refresh();
    expect(c.data?['scope']['visibility'], 'workspace');
    f.session.selectWorkspace({...f.session.workspace!, 'role': 'member'});
    expect(c.data, isNull);
    await c.refresh();
    expect(c.data, isNull);
    expect(c.error, 'mobileWorkspaceUsageInvalid');
    self = true;
    await c.refresh();
    expect(c.data?['scope']['visibility'], 'self');
    c.dispose();
    f.scope.dispose();
    f.session.dispose();
  });
  test(
    'late range and account responses never replace current usage',
    () async {
      final late = Completer<http.Response>();
      final f = await fixture(
        (r) async => r.url.query == 'days=7'
            ? late.future
            : jsonResponse(usage(days: 90)),
      );
      final c = UsageController(f.scope);
      final old = c.refresh(7);
      await c.refresh(90);
      late.complete(jsonResponse(usage(days: 7)));
      await old;
      expect(c.days, 90);
      expect(c.data?['period']['days'], 90);
      f.session.selectWorkspace(null);
      expect(c.data, isNull);
      expect(c.active, false);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  for (final lang in ['en', 'zh']) {
    testWidgets('usage phone $lang separates missing reports and unknown cost', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final f = await fixture(
        (r) async => jsonResponse(
          usage(days: int.parse(r.url.queryParameters['days']!)),
        ),
      );
      await tester.pumpWidget(
        testApp(UsageScreen(scope: f.scope), locale: Locale(lang)),
      );
      await waitFor(tester, () => find.text('127').evaluate().isNotEmpty);
      expect(
        find.text(lang == 'en' ? 'Unreported turns' : '未报告轮次'),
        findsOneWidget,
      );
      expect(find.textContaining('UTC'), findsWidgets);
      final cost = find.text(
        lang == 'en'
            ? 'Cost is unknown. No estimated rates are used; this is not a bill.'
            : '费用未知：这里不使用估算费率，也不是账单。',
      );
      await tester.ensureVisible(cost);
      await tester.pumpAndSettle();
      expect(cost, findsOneWidget);
      for (final p in tester.renderObjectList<RenderParagraph>(
        find.byType(RichText),
      )) {
        expectReadableText(p.text);
      }
      final bots = find.text(lang == 'en' ? 'By Bot' : '按 Bot');
      await tester.ensureVisible(bots);
      await tester.tap(bots);
      await tester.pumpAndSettle();
      expect(
        find.text(lang == 'en' ? 'System assistance' : '系统辅助任务'),
        findsOneWidget,
      );
      expect(
        find.text(lang == 'en' ? 'Deleted Bot' : '已删除的 Bot'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }
}
