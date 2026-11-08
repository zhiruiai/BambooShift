import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';

typedef QuestionOption = ({String id, String label, String? description});
typedef QuestionAnswer = ({List<String> optionIds, String messageId});

final _optionId = RegExp(r'^[A-Za-z0-9_-]{1,32}$');

final _controls = RegExp(r'[\x00-\x1f\x7f-\x9f]');

bool _text(Object? value, int maximum, {bool empty = false}) =>
    value is String &&
    (empty || value.trim().isNotEmpty) &&
    value.length <= maximum &&
    !_controls.hasMatch(value);

class ChatQuestion {
  const ChatQuestion._({
    required this.id,
    required this.conversationId,
    required this.agentId,
    required this.threadRootId,
    required this.requesterId,
    required this.inputId,
    required this.runId,
    required this.question,
    required this.multiple,
    required this.options,
    required this.answer,
  });

  final String id, conversationId, agentId, requesterId, inputId, runId;
  final String? threadRootId;
  final String question;
  final bool multiple;
  final List<QuestionOption> options;
  final QuestionAnswer? answer;

  List<String> normalized(Iterable<String> selected) {
    final ids = selected.toSet();
    return [
      for (final option in options)
        if (ids.contains(option.id)) option.id,
    ];
  }

  bool samePrompt(ChatQuestion other) =>
      id == other.id &&
      conversationId == other.conversationId &&
      agentId == other.agentId &&
      threadRootId == other.threadRootId &&
      requesterId == other.requesterId &&
      inputId == other.inputId &&
      runId == other.runId &&
      question == other.question &&
      multiple == other.multiple &&
      listEquals(options, other.options);

  bool canAnswer(WorkspaceController scope) {
    final bot = scope.find('agents', agentId);
    final chat = scope.find('conversations', conversationId);
    final members = chat?['agentIds'];
    final root = threadRootId == null
        ? null
        : scope.find('messages', threadRootId!);
    return answer == null &&
        scope.active &&
        scope.userId == requesterId &&
        botAvailable(bot) &&
        !isManagedBot(bot!) &&
        chat?['demo'] != true &&
        members is List &&
        members.contains(agentId) &&
        (threadRootId == null ||
            (root?['conversationId'] == conversationId &&
                chatThreadRoot(root) == null));
  }

  static ChatQuestion? parse(Object? value) {
    if (value is! Json ||
        value['kind'] != 'question' ||
        value['role'] != 'assistant' ||
        value['status'] != 'done' ||
        !isChatReference(value['id']) ||
        !isChatReference(value['conversationId']) ||
        !isChatReference(value['agentId']) ||
        (value['threadRootId'] != null &&
            !isChatReference(value['threadRootId']))) {
      return null;
    }
    final metadata = value['metadata'];
    final data = metadata is Json ? metadata['question'] : null;
    if (data is! Json ||
        data['version'] != 1 ||
        !_text(data['question'], 500) ||
        !['single', 'multiple'].contains(data['mode']) ||
        !['pending', 'answered'].contains(data['status']) ||
        !_text(data['runId'], 128)) {
      return null;
    }
    final requester = data['requester'];
    final rows = data['options'];
    if (requester is! Json ||
        !_text(requester['userId'], 128) ||
        !_text(requester['messageId'], 128) ||
        rows is! List ||
        rows.length < 2 ||
        rows.length > 6) {
      return null;
    }
    final options = <QuestionOption>[];
    final ids = <String>{};
    for (final row in rows) {
      if (row is! Json) return null;
      final id = row['id'],
          label = row['label'],
          description = row['description'];
      if (id is! String ||
          !_optionId.hasMatch(id) ||
          !ids.add(id) ||
          !_text(label, 160) ||
          (description != null && !_text(description, 300, empty: true))) {
        return null;
      }
      options.add((
        id: id,
        label: label as String,
        description: description == '' ? null : description as String?,
      ));
    }
    final multiple = data['mode'] == 'multiple';
    QuestionAnswer? answer;
    final submitted = data['answer'];
    if (data['status'] == 'answered') {
      if (submitted is! Json ||
          !isChatReference(submitted['messageId']) ||
          submitted['submittedAt'] is! String ||
          DateTime.tryParse(submitted['submittedAt'] as String) == null) {
        return null;
      }
      final selection = submitted['optionIds'];
      if (selection is! List ||
          selection.isEmpty ||
          (!multiple && selection.length != 1) ||
          selection.length > options.length ||
          !listEquals(
            options
                .where((option) => selection.contains(option.id))
                .map((option) => option.id)
                .toList(),
            selection,
          )) {
        return null;
      }
      answer = (
        optionIds: List.unmodifiable(selection.cast<String>()),
        messageId: submitted['messageId'] as String,
      );
    } else if (submitted != null) {
      return null;
    }
    return ChatQuestion._(
      id: value['id'] as String,
      conversationId: value['conversationId'] as String,
      agentId: value['agentId'] as String,
      threadRootId: chatThreadRoot(value),
      requesterId: requester['userId'] as String,
      inputId: requester['messageId'] as String,
      runId: data['runId'] as String,
      question: data['question'] as String,
      multiple: multiple,
      options: List.unmodifiable(options),
      answer: answer,
    );
  }

  ChatQuestion? confirmed(Object? receipt, List<String> selection) {
    if (receipt is! Json) return null;
    final next = parse(receipt['question']);
    final userMessage = receipt['message'];
    final metadata = userMessage is Json ? userMessage['metadata'] : null;
    final proof = metadata is Json ? metadata['questionAnswer'] : null;
    final delivery = userMessage is Json ? userMessage['delivery'] : null;
    final reply = userMessage is Json ? userMessage['replyTo'] : null;
    if (next == null ||
        !samePrompt(next) ||
        next.answer == null ||
        !listEquals(next.answer!.optionIds, selection) ||
        userMessage is! Json ||
        userMessage['id'] != next.answer!.messageId ||
        userMessage['role'] != 'user' ||
        userMessage['kind'] != 'text' ||
        userMessage['userId'] != requesterId ||
        userMessage['conversationId'] != conversationId ||
        userMessage['threadRootId'] != threadRootId ||
        reply is! Json ||
        reply['id'] != id ||
        delivery is! Json ||
        delivery['mode'] != 'followUp' ||
        delivery['agentId'] != agentId ||
        delivery['explicitAgentId'] != agentId ||
        proof is! Json ||
        proof['questionId'] != id ||
        proof['optionIds'] is! List ||
        !listEquals(proof['optionIds'] as List, selection)) {
      return null;
    }
    return next;
  }
}
