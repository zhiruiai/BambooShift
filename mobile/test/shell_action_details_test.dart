import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/chat/shell_action_data.dart';
import 'package:openbot_mobile/features/chat/shell_action_details.dart';

import 'action_card_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp;

void main() {
  testWidgets(
    'local shell shows the full command and host access without isolation claims',
    (tester) async {
      await tester.pumpWidget(
        testApp(
          const Scaffold(
            body: SingleChildScrollView(
              child: ShellActionDetails(
                payload: {
                  'command': 'echo "<script>plain text</script>"',
                  'path': 'reports',
                },
                local: true,
                result: {
                  'exitCode': 2,
                  'stdout': '<tag>plain output</tag>',
                  'stderr': 'Synthetic failure',
                  'durationMs': 1200,
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('echo "<script>plain text</script>"'), findsOneWidget);
      expect(find.textContaining('not an access boundary'), findsOneWidget);
      expect(find.textContaining('no network access'), findsNothing);
      await tester.tap(find.text('Execution failed'));
      await tester.pumpAndSettle();
      expect(find.text('Exit code: 2'), findsOneWidget);
      expect(find.text('<tag>plain output</tag>'), findsOneWidget);
      expect(find.text('Synthetic failure'), findsOneWidget);
    },
  );

  test('result mapping preserves cancellation, timeout and nonzero exits', () {
    expect(shellResultLabel({'exitCode': 0}), 'shellCompleted');
    expect(shellResultLabel({'exitCode': 2}), 'shellFailed');
    expect(
      shellResultLabel({'exitCode': 0, 'timedOut': true}),
      'shellTimedOut',
    );
    expect(
      shellResultLabel({'exitCode': 0, 'timedOut': true, 'cancelled': true}),
      'shellCancelled',
    );
    expect(
      shellResultLabel({'exitCode': null, 'signal': 'SIGTERM'}),
      'shellInterrupted',
    );
    expect(shellRequestReadable({'command': ''}), false);
    expect(shellRequestReadable({'command': 'x' * 16001}), false);
    expect(shellRequestReadable({'command': 'pwd', 'path': 3}), false);
  });

  test(
    'an unreadable shell command cannot be approved but can still be rejected',
    () async {
      final message = actionMessage(kind: 'computer');
      message['metadata']['action']['type'] = 'local_shell';
      message['metadata']['action']['payload'] = <String, dynamic>{};
      final data = bootstrap(messages: [message]);
      final writes = <String>[];
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          writes.add(request.url.path);
          return jsonResponse({'id': actionId, 'status': 'rejected'});
        }
        return jsonResponse(data);
      });
      f.scope.data = data;
      final c = controller(f.scope, message);
      await c.initialize();
      expect(c.canDecide, true);
      expect(c.canApprove, false);
      await c.decide(true);
      expect(writes, isEmpty);
      await c.decide(false);
      expect(writes, [
        '/api/workspaces/space-a/computer/actions/$actionId/reject',
      ]);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
