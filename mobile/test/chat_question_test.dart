import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/chat_message.dart';
import 'package:openbot_mobile/features/chat/chat_question_data.dart';
import 'package:openbot_mobile/features/chat/chat_screen.dart';

import 'collaboration_support.dart';
import 'support.dart';
import 'widgets_test.dart' show testApp, waitFor;

const _questionId = 'question-run-a';
const _answerId = 'answer-a';
const _stamp = '2026-11-08T04:00:00Z';
const _prompt = 'Which result should I prepare?';
const _draft = 'Keep this separate unsent message';

Json _question({
  String mode = 'single',
  String requester = 'user-a',
  String chat = 'chat-a',
  String bot = 'bot-a',
  List<String>? answer,
}) => {
  'id': _questionId,
  'kind': 'question',
  'status': 'done',
  'role': 'assistant',
  'agentId': bot,
  'conversationId': chat,
  'createdAt': _stamp,
  'metadata': {
    'question': {
      'version': 1,
      'question': _prompt,
      'mode': mode,
      'runId': 'run-a',
      'requester': {'userId': requester, 'messageId': 'input-a'},
      'options': [
        {
          'id': 'brief',
          'label': 'Short summary',
          'description': 'Two paragraphs.',
        },
        {'id': 'report', 'label': 'Detailed report', 'description': ''},
      ],
      'status': answer == null ? 'pending' : 'answered',
      if (answer != null)
        'answer': {
          'optionIds': answer,
          'messageId': _answerId,
          'submittedAt': _stamp,
        },
    },
  },
};

Json _receipt(Json message, List<String> ids) {
  final data = message['metadata']['question'] as Json;
  final question = _question(
    mode: data['mode'] as String,
    requester: data['requester']['userId'] as String,
    chat: message['conversationId'] as String,
    bot: message['agentId'] as String,
    answer: ids,
  );
  return {
    'question': question,
    'message': {
      'id': _answerId,
      'conversationId': message['conversationId'],
      'role': 'user',
      'kind': 'text',
      'content': 'Question answer',
      'createdAt': _stamp,
      'userId': data['requester']['userId'],
      'replyTo': {'id': _questionId},
      'delivery': {
        'state': 'queued',
        'mode': 'followUp',
        'agentId': message['agentId'],
        'explicitAgentId': message['agentId'],
      },
      'metadata': {
        'questionAnswer': {'questionId': _questionId, 'optionIds': ids},
      },
    },
  };
}

void _phone(WidgetTester tester, double width, double height) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  test(
    'strict question parser rejects malformed options and mismatched receipts',
    () {
      final message = _question(mode: 'multiple');
      final question = ChatQuestion.parse(message)!;
      expect(question.options.last.description, isNull);
      expect(question.normalized(['report', 'brief']), ['brief', 'report']);
      expect(
        ChatQuestion.parse(
          _question(mode: 'multiple', answer: ['report', 'brief']),
        ),
        isNull,
      );
      expect(
        ChatQuestion.parse(_question(answer: ['brief', 'report'])),
        isNull,
      );
      final metadata = message['metadata']['question'] as Json;
      final options = metadata['options'] as List;
      metadata['options'] = [...options, options.first];
      expect(ChatQuestion.parse(message), isNull);
      metadata['options'] = options;
      metadata['question'] = List.filled(251, '🔎').join();
      expect(ChatQuestion.parse(message), isNull);
      metadata['question'] = _prompt;
      final receipt = _receipt(message, ['report']);
      expect(question.confirmed(receipt, ['report']), isNotNull);
      receipt['message']['delivery']['explicitAgentId'] = 'other-bot';
      expect(question.confirmed(receipt, ['report']), isNull);
    },
  );

  testWidgets(
    'requesting team member submits one group answer without changing composer',
    (tester) async {
      _phone(tester, 320, 740);
      final pending = _question(chat: 'group-a', bot: 'bot-b');
      final posts = <Json>[];
      Json snapshot = teamSnapshot(messages: [pending]);
      final f = await fixture((request) async {
        if (request.method == 'POST') {
          expect(
            request.url.path,
            '/api/workspaces/space-a/messages/$_questionId/answer',
          );
          expect(request.headers['X-OpenBot-Expected-User'], 'user-a');
          final body = jsonDecode(request.body) as Json;
          posts.add(body);
          final receipt = _receipt(pending, ['report']);
          snapshot = teamSnapshot(
            messages: [receipt['question'] as Json, receipt['message'] as Json],
          );
          return jsonResponse(receipt, status: 202);
        }
        return jsonResponse(snapshot);
      });
      f.session.selectWorkspace({
        ...f.session.workspace!,
        'kind': 'team',
        'role': 'member',
      });
      f.scope.data = snapshot;
      f.scope.saveChatDraft('group-a', _draft);
      await tester.pumpWidget(
        testApp(
          ChatScreen(scope: f.scope, conversationId: 'group-a'),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel(_prompt), findsOneWidget);
      final submit = find.widgetWithText(FilledButton, '提交答案');
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tester.ensureVisible(find.text('Short summary'));
      await tester.tap(find.text('Short summary'));
      await tester.pump();
      await tester.ensureVisible(find.text('Detailed report'));
      await tester.tap(find.text('Detailed report'));
      await tester.pump();
      expect(posts, isEmpty);
      expect(f.scope.chatDraft('group-a'), _draft);
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await waitFor(tester, () => find.text('已提交答案').evaluate().isNotEmpty);
      expect(posts, [
        {
          'optionIds': ['report'],
        },
      ]);
      expect(find.byType(RadioListTile<String>), findsNothing);
      expect(find.text(_draft), findsOneWidget);
      expect(f.scope.chatDraft('group-a'), _draft);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets(
    'unknown multi-answer stays locked and can replay the same sorted choices',
    (tester) async {
      _phone(tester, 390, 760);
      final pending = _question(mode: 'multiple');
      final posts = <Json>[];
      var reads = 0;
      Json snapshot = teamSnapshot(messages: [pending]);
      final f = await fixture((request) async {
        if (request.method == 'GET') {
          reads++;
          return jsonResponse(snapshot);
        }
        posts.add(jsonDecode(request.body) as Json);
        if (posts.length == 1) {
          return jsonResponse({'code': 'UNCONFIRMED'}, status: 502);
        }
        final receipt = _receipt(pending, ['brief', 'report']);
        snapshot = teamSnapshot(
          messages: [receipt['question'] as Json, receipt['message'] as Json],
        );
        return jsonResponse(receipt, status: 202);
      });
      f.scope.data = snapshot;
      Widget screen(Json message) => testApp(
        Scaffold(
          body: ListView(
            children: [ChatMessage(scope: f.scope, message: message)],
          ),
        ),
      );
      await tester.pumpWidget(screen(pending));
      await tester.tap(find.text('Detailed report'));
      await tester.pump();
      await tester.tap(find.text('Short summary'));
      await tester.pump();
      expect(posts, isEmpty);
      await tester.tap(find.text('Submit answer'));
      await waitFor(
        tester,
        () => find.text('Retry same answer').evaluate().isNotEmpty,
      );
      expect(find.textContaining('could not be confirmed'), findsOneWidget);
      expect(
        tester
            .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
            .every((tile) => tile.onChanged == null),
        isTrue,
      );
      await tester.tap(find.text('Check answer'));
      await tester.pump();
      await waitFor(
        tester,
        () =>
            reads == 1 &&
            find.byType(LinearProgressIndicator).evaluate().isEmpty,
      );
      expect(posts, [
        {
          'optionIds': ['brief', 'report'],
        },
      ]);
      await tester.tap(find.text('Retry same answer'));
      await waitFor(
        tester,
        () => find.text('Answer submitted').evaluate().isNotEmpty,
      );
      expect(posts, [
        {
          'optionIds': ['brief', 'report'],
        },
        {
          'optionIds': ['brief', 'report'],
        },
      ]);
      await waitFor(
        tester,
        () =>
            ChatQuestion.parse(f.scope.find('messages', _questionId))?.answer !=
            null,
      );
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(screen(f.scope.find('messages', _questionId)!));
      await tester.pumpAndSettle();
      expect(find.text('Answer submitted'), findsOneWidget);
      expect(find.byType(CheckboxListTile), findsNothing);
      expect(find.text('Retry same answer'), findsNothing);
      expect(posts, hasLength(2));
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );

  testWidgets('a conflicting response reloads the already submitted choice', (
    tester,
  ) async {
    final pending = _question();
    final answered = _question(answer: ['report']);
    var posts = 0;
    final f = await fixture((request) async {
      if (request.method == 'POST') {
        posts++;
        return jsonResponse({'code': 'QUESTION_ALREADY_ANSWERED'}, status: 409);
      }
      return jsonResponse(teamSnapshot(messages: [answered]));
    });
    f.scope.data = teamSnapshot(messages: [pending]);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ChatMessage(scope: f.scope, message: pending),
        ),
      ),
    );
    await tester.tap(find.text('Short summary'));
    await tester.pump();
    await tester.tap(find.text('Submit answer'));
    await waitFor(
      tester,
      () => find.text('Answer submitted').evaluate().isNotEmpty,
    );
    expect(find.text('Short summary'), findsNothing);
    expect(find.text('Detailed report'), findsOneWidget);
    expect(find.text('Submit answer'), findsNothing);
    expect(posts, 1);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('nonrequester and removed source Bot are read only', (
    tester,
  ) async {
    final f = await fixture(
      (_) async => fail('Read-only card attempted a request.'),
    );
    final peer = _question(requester: 'user-b');
    final removed = _question(bot: 'removed-bot');
    Widget screen(Json question) => testApp(
      Scaffold(
        body: ChatMessage(scope: f.scope, message: question),
      ),
    );
    f.scope.data = teamSnapshot(messages: [peer]);
    await tester.pumpWidget(screen(peer));
    expect(
      find.text('Only the original requester can answer.'),
      findsOneWidget,
    );
    expect(find.text('Submit answer'), findsNothing);
    f.scope.data = teamSnapshot(messages: [removed]);
    await tester.pumpWidget(screen(removed));
    expect(find.text('This question is no longer available.'), findsOneWidget);
    expect(find.text('Submit answer'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });

  testWidgets('late answer never updates a switched workspace', (tester) async {
    final pending = _question();
    final started = Completer<void>();
    final response = Completer<http.Response>();
    final f = await fixture((request) {
      expect(request.method, 'POST');
      started.complete();
      return response.future;
    });
    f.scope.data = teamSnapshot(messages: [pending]);
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: ChatMessage(scope: f.scope, message: pending),
        ),
      ),
    );
    await tester.tap(find.text('Short summary'));
    await tester.pump();
    await tester.tap(find.text('Submit answer'));
    for (var n = 0; n < 100 && !started.isCompleted; n++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
    }
    expect(started.isCompleted, isTrue);
    f.session.selectWorkspace(null);
    response.complete(jsonResponse(_receipt(pending, ['brief']), status: 202));
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
    expect(find.text('Answer submitted'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.scope.dispose();
    f.session.dispose();
  });
}
