import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/bots/knowledge_screen.dart';
import 'package:openbot_mobile/features/bots/skill_package_data.dart';
import 'package:openbot_mobile/features/bots/skill_package_preview.dart';

import 'file_export_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

final _skill = <String, dynamic>{
  'id': 'skill-a',
  'agentId': 'bot-a',
  'name': 'issue-triage',
  'description': 'Check reproducible issues.',
  'content': 'Read the checklist.',
  'status': 'active',
  'version': 1,
  'skillPackage': {
    'format': 'agent-skills',
    'root': 'issue-triage',
    'frontmatter': {
      'name': 'issue-triage',
      'description': 'Check reproducible issues.',
      'metadata': {'title': 'Issue triage'},
      'license': 'MIT',
    },
    'files': [
      {'path': 'SKILL.md', 'size': 130, 'sha256': 'a' * 64},
      {'path': 'references/checklist.md', 'size': 30, 'sha256': 'b' * 64},
    ],
  },
};

final _snapshot = bootstrap(
  agents: [
    {'id': 'bot-a', 'name': 'Bot A'},
  ],
)..['skills'] = [_skill];

final _zip = base64Decode(
  'UEsDBBQAAAAAAKdycF2hAMIzVwAAAFcAAAAVAAAAaXNzdWUtdHJpYWdlL1NLSUxMLm1kLS0tCm5h'
  'bWU6IGlzc3VlLXRyaWFnZQpkZXNjcmlwdGlvbjogQ2hlY2sgcmVwcm9kdWNpYmxlIGlzc3Vlcy4K'
  'LS0tClJlYWQgdGhlIGNoZWNrbGlzdC4KUEsDBBQAAAAAAKdycF23fzNzGQAAABkAAAAkAAAAaXNzdW'
  'UtdHJpYWdlL3JlZmVyZW5jZXMvY2hlY2tsaXN0Lm1kLSBbIF0gQ2hlY2sgdGhlIHZlcnNpb24uCl'
  'BLAQIUAxQAAAAAAKdycF2hAMIzVwAAAFcAAAAVAAAAAAAAAAAAAACAAQAAAABpc3N1ZS10cmlhZ2Uv'
  'U0tJTEwubWRQSwECFAMUAAAAAACncnBdt38zcxkAAAAZAAAAJAAAAAAAAAAAAAAAgAGKAAAAaXNzdW'
  'UtdHJpYWdlL3JlZmVyZW5jZXMvY2hlY2tsaXN0Lm1kUEsFBgAAAAACAAIAlQAAAOUAAAAAAA==',
);
const _download = 'Export skill package ZIP';

void main() {
  test('installed manifests require canonical paths and SKILL.md', () {
    final package = SkillPackageDetails.installed(_skill)!;
    expect(package.root, 'issue-triage');
    expect(package.files.map((file) => file.path), [
      'SKILL.md',
      'references/checklist.md',
    ]);
    expect(
      SkillPackageDetails.installed({..._skill, 'name': 'Legacy title'}),
      isNull,
    );
    expect(
      SkillPackageDetails.installed({
        ..._skill,
        'name': 'Legacy title',
        'skillPackageSource': 'workspace-text',
      }),
      isNotNull,
    );
    final manifest = _skill['skillPackage'] as Json;
    final files = manifest['files'] as List;
    expect(
      SkillPackageDetails.installed({
        ..._skill,
        'skillPackage': {
          ...manifest,
          'files': [
            ...files,
            {'path': '../escape.md', 'size': 2, 'sha256': 'c' * 64},
          ],
        },
      }),
      isNull,
    );
  });

  testWidgets('Bot skill row shows the package and resources', (tester) async {
    final f = await fixture((_) async => jsonResponse(_snapshot));
    f.scope.data = _snapshot;
    await tester.pumpWidget(
      testApp(
        KnowledgeScreen(scope: f.scope, agentId: 'bot-a', kind: 'skills'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Issue triage'));
    await tester.pumpAndSettle();
    expect(find.text('Agent Skills package'), findsOneWidget);
    expect(find.text('License · MIT'), findsOneWidget);
    await tester.ensureVisible(find.text('Package files (2)'));
    await tester.tap(find.text('Package files (2)'));
    await tester.pumpAndSettle();
    expect(find.text('references/checklist.md'), findsOneWidget);
    expect(find.text('Propose an edited version'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  for (final stale in [false, true]) {
    testWidgets('ZIP export checks scoped version at handoff (stale: $stale)', (
      tester,
    ) async {
      final destination = ExportDestination();
      final handoff = Completer<void>();
      var reachedHandoff = false;
      destination.beforeHandoff = () async {
        reachedHandoff = true;
        if (stale) await handoff.future;
      };
      final requests = <String>[];
      final f = await fixture((request) async {
        expect(request.method, 'GET');
        expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
        final path = request.url.path;
        expect(path, startsWith('/api/workspaces/space-a/'));
        requests.add(path);
        if (path.endsWith('/bootstrap')) return jsonResponse(_snapshot);
        expect(path, endsWith('/skills/skill-a/package'));
        expect(request.headers['Accept'], 'application/zip');
        return http.Response.bytes(
          _zip,
          200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="issue-triage.zip"',
          },
        );
      });
      f.scope.data = _snapshot;
      await tester.pumpWidget(
        testApp(
          Scaffold(
            body: SkillPackageExport(
              scope: f.scope,
              agentId: 'bot-a',
              skillId: 'skill-a',
              package: SkillPackageDetails.installed(_skill)!,
              destination: destination,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(requests, isEmpty);
      await tester.tap(find.text(_download));
      for (var attempt = 0; attempt < 20 && !reachedHandoff; attempt++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();
      }
      expect(reachedHandoff, isTrue);
      if (stale) {
        f.session.user = {'id': 'user-b'};
        f.session.notifyListeners();
        handoff.complete();
      }
      await waitFor(
        tester,
        () =>
            tester
                .widget<OutlinedButton>(find.byType(OutlinedButton))
                .onPressed !=
            null,
      );
      expect(requests.length, stale ? 2 : 3);
      expect(destination.calls, stale ? 0 : 1);
      if (!stale) {
        expect(destination.received?.mimeType, 'application/zip');
        expect(destination.received?.bytes, _zip);
      }
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    });
  }
}
