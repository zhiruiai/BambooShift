import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'chat_question_data.dart';

class ChatQuestionCard extends StatefulWidget {
  const ChatQuestionCard({
    super.key,
    required this.scope,
    required this.question,
  });

  final WorkspaceController scope;
  final ChatQuestion question;

  @override
  State<ChatQuestionCard> createState() => _ChatQuestionCardState();
}

class _ChatQuestionCardState extends State<ChatQuestionCard> {
  final _selected = <String>{};
  final _cancellation = ByteReadCancellation();
  ChatQuestion? _confirmed;
  List<String>? _attempt;
  String? _error;
  bool _busy = false;
  bool _fenced = false;

  WorkspaceController get _scope => widget.scope;
  bool get _active => mounted && _scope.active && !_cancellation.cancelled;

  ChatQuestion? get _current {
    if (!_active) return null;
    final row = _scope.find('messages', widget.question.id);
    final current = ChatQuestion.parse(row);
    return current != null && current.samePrompt(widget.question)
        ? current
        : null;
  }

  @override
  void didUpdateWidget(ChatQuestionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.question.samePrompt(widget.question)) {
      _selected.clear();
      _attempt = null;
      _confirmed = null;
      _error = null;
      _fenced = false;
    }
  }

  @override
  void dispose() {
    _cancellation.cancel();
    super.dispose();
  }

  Future<void> _submit() async {
    final current = _current;
    if (_busy ||
        _fenced ||
        _confirmed != null ||
        current == null ||
        !current.canAnswer(_scope)) {
      return;
    }
    final selected = _attempt ?? current.normalized(_selected);
    if (selected.isEmpty) return;
    setState(() {
      _attempt = selected;
      _busy = true;
      _error = null;
    });
    try {
      final result = await _scope.requestValue(
        'POST',
        '/messages/${Uri.encodeComponent(current.id)}/answer',
        body: {'optionIds': selected},
        cancellation: _cancellation,
      );
      if (!_active || !current.samePrompt(widget.question)) return;
      final confirmed = current.confirmed(result, selected);
      if (confirmed == null) {
        throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
      }
      setState(() {
        _confirmed = confirmed;
        _attempt = null;
      });
      await _scope.refresh();
    } catch (error) {
      if (!_active || !current.samePrompt(widget.question)) return;
      final code = error is ApiException ? error.code : null;
      if ((error is ApiException && [401, 403].contains(error.status)) ||
          {
            'QUESTION_INVALID',
            'QUESTION_FORBIDDEN',
            'QUESTION_UNAVAILABLE',
            'QUESTION_ALREADY_ANSWERED',
            'THREAD_CONTEXT_UNAVAILABLE',
          }.contains(code)) {
        setState(() {
          _attempt = null;
          _fenced = true;
          _error = code == 'QUESTION_ALREADY_ANSWERED'
              ? 'chatQuestionAlreadyAnswered'
              : 'chatQuestionUnavailable';
        });
        await _scope.refresh();
      } else if (code == 'QUESTION_LIMIT' ||
          (error is ApiException && error.status == 429)) {
        setState(() {
          _attempt = null;
          _error = 'chatQuestionLimit';
        });
      } else {
        setState(() => _error = 'chatQuestionUnknown');
      }
    } finally {
      if (_active) setState(() => _busy = false);
    }
  }

  Future<void> _check() async {
    if (!_active || _busy) return;
    setState(() => _busy = true);
    try {
      await _scope.refresh();
    } finally {
      if (_active) setState(() => _busy = false);
    }
  }

  Widget _choices(ChatQuestion question, bool enabled) {
    if (!question.multiple) {
      return RadioGroup<String>(
        groupValue: _selected.firstOrNull,
        onChanged: (id) {
          if (!enabled || id == null) return;
          setState(
            () => _selected
              ..clear()
              ..add(id),
          );
        },
        child: Column(
          children: [
            for (final option in question.options)
              RadioListTile<String>(
                value: option.id,
                enabled: enabled,
                contentPadding: EdgeInsets.zero,
                title: Text(option.label),
                subtitle: option.description == null
                    ? null
                    : Text(option.description!),
              ),
          ],
        ),
      );
    }
    return Column(
      children: [
        for (final option in question.options)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _selected.contains(option.id),
            onChanged: enabled
                ? (chosen) => setState(() {
                    if (chosen == true) {
                      _selected.add(option.id);
                    } else {
                      _selected.remove(option.id);
                    }
                  })
                : null,
            title: Text(option.label),
            subtitle: option.description == null
                ? null
                : Text(option.description!),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_scope, _scope.session]),
    builder: (context, _) {
      if (!_scope.active) return const SizedBox.shrink();
      final current = _current;
      final question = current ?? widget.question;
      final answer =
          question.answer ?? (current != null ? _confirmed?.answer : null);
      final own = question.requesterId == _scope.userId;
      final allowed = current?.canAnswer(_scope) == true && !_fenced;
      final mayChange = allowed && !_busy && _attempt == null;
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                container: true,
                header: true,
                label: question.question,
                excludeSemantics: true,
                child: Text(
                  question.question,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const SizedBox(height: 8),
              if (answer != null) ...[
                Semantics(
                  liveRegion: true,
                  child: Text(context.tr('chatQuestionAnswered')),
                ),
                for (final option in question.options)
                  if (answer.optionIds.contains(option.id))
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.check),
                      title: Text(option.label),
                    ),
              ] else ...[
                if (allowed)
                  Text(
                    context.tr(
                      question.multiple
                          ? 'chatQuestionMultiple'
                          : 'chatQuestionSingle',
                    ),
                  ),
                _choices(question, mayChange),
                if (!own)
                  Text(context.tr('chatQuestionRequester'))
                else if (!allowed && _error == null)
                  Text(context.tr('chatQuestionUnavailable')),
                if (_error != null)
                  Semantics(liveRegion: true, child: Text(context.tr(_error!))),
                if (_busy) const LinearProgressIndicator(),
                if (allowed)
                  FilledButton(
                    onPressed: !_busy && _selected.isNotEmpty ? _submit : null,
                    child: Text(
                      context.tr(
                        _attempt != null && !_busy
                            ? 'chatQuestionRetry'
                            : 'chatQuestionSubmit',
                      ),
                    ),
                  ),
                if (own && (_fenced || (_attempt != null && _error != null)))
                  TextButton(
                    onPressed: _busy ? null : _check,
                    child: Text(context.tr('chatQuestionCheck')),
                  ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
