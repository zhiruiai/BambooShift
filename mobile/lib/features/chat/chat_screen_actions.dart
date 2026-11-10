part of 'chat_screen.dart';

extension _ChatScreenActions on _ChatScreenState {
  Widget computerAction(WorkspaceController scope, String agentId) =>
      IconButton(
        tooltip: context.tr('mobileComputerTitle'),
        onPressed: () => Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (_) => ComputerScreen(scope: scope, agentId: agentId),
          ),
        ),
        icon: const Icon(Icons.computer_outlined),
      );

  Widget groupSettingsAction(WorkspaceController scope) => IconButton(
    tooltip: context.tr('groupSettings'),
    onPressed: () => Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) =>
            GroupSettings(scope: scope, conversationId: widget.conversationId),
      ),
    ),
    icon: const Icon(Icons.tune),
  );

  void applyDraftControls(ChatController controller, ChatDraftOptions next) {
    if (!canEditOptions(controller)) return;
    final scope = controller.scope, key = controller.draftKey;
    final value = unmarkRemovedChatRecipients(
      context,
      scope,
      input.value,
      scope.chatOptions(key),
      next,
    );
    if (value != input.value) {
      input.value = value;
      scope.saveChatDraft(key, value.text);
    }
    updateOptions(controller, next);
  }

  void selectMention(
    ChatController controller,
    ChatMention choice,
    ChatMentionToken? token,
  ) {
    if (!canEditOptions(controller)) return;
    final scope = controller.scope, id = controller.conversationId;
    final options = scope.chatOptions(controller.draftKey);
    final choices = chatMentions(scope, scope.find('conversations', id));
    if (!availableChatMentions(choices, options).any(
      (live) =>
          live.id == choice.id &&
          live.name == choice.name &&
          live.everyone == choice.everyone &&
          live.app == choice.app,
    )) {
      return;
    }
    if (token != null) {
      if (chatMentionToken(input.value) != token) return;
      final label = choice.app == null ? '${choice.label(context)} ' : '';
      input.value = applyChatMentionToken(input.value, token, label);
      scope.saveChatDraft(controller.draftKey, input.text);
    }
    applyDraftControls(controller, addChatMention(options, choice));
    inputFocus.requestFocus();
  }

  void replyTo(ChatController controller, Json message) {
    final id = message['id'];
    if (!canEditOptions(controller) ||
        id is! String ||
        scopedMessage(controller.conversationId, id) == null) {
      return;
    }
    final options = controller.scope.chatOptions(controller.draftKey);
    updateOptions(controller, options.withReply(id));
    inputFocus.requestFocus();
  }

  void jumpTo(ChatController controller, String messageId) {
    if (!current(controller) ||
        scopedMessage(controller.conversationId, messageId) == null) {
      return;
    }
    if (scroll.hasClients) scroll.jumpTo(0);
    setFocusedMessage(messageId);
  }

  void openThread(ChatController controller, Json message) {
    final id = message['id'];
    if (!current(controller) ||
        controller.threadRootId != null ||
        id is! String ||
        !isChatReference(id) ||
        scopedMessage(controller.conversationId, id) == null) {
      return;
    }
    inputFocus.unfocus();
    unawaited(memos.stop());
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(
          scope: controller.scope,
          conversationId: controller.conversationId,
          threadRootId: id,
          attachmentPicker: widget.attachmentPicker,
        ),
      ),
    );
  }

  bool get memoAllowed => canRequestVoiceMemo(
    widget.scope,
    widget.conversationId,
    widget.threadRootId,
    widget.scope.chatOptions(chat.draftKey),
  );

  void setMemo(bool selected) {
    if ((!selected || memoAllowed) && canEditOptions(chat)) {
      updateMemo(selected);
    }
  }

  void startVoiceCall() {
    inputFocus.unfocus();
    unawaited(memos.stop());
    unawaited(
      voice.startCall(
        Localizations.localeOf(context).languageCode,
        confirmSwitch: () async {
          if (!mounted) return false;
          return await showDialog<bool>(
                context: context,
                builder: (dialog) => AlertDialog(
                  title: Text(dialog.tr('voiceSwitchTitle')),
                  content: Text(dialog.tr('voiceSwitchDescription')),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(dialog, false),
                      child: Text(dialog.tr('cancel')),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(dialog, true),
                      child: Text(dialog.tr('voiceSwitchConfirm')),
                    ),
                  ],
                ),
              ) ??
              false;
        },
      ),
    );
  }

  void dictate() {
    final controller = chat;
    unawaited(memos.stop());
    inputFocus.unfocus();
    unawaited(
      voice.dictation((transcript) {
        if (!current(controller)) return;
        final text = input.text;
        final selection = input.selection;
        final start = selection.isValid ? selection.start : text.length;
        final end = selection.isValid ? selection.end : text.length;
        final prefix = start > 0 && text[start - 1].trim().isNotEmpty
            ? ' '
            : '';
        final suffix = end < text.length && text[end].trim().isNotEmpty
            ? ' '
            : '';
        final value = text.replaceRange(
          start,
          end,
          '$prefix$transcript$suffix',
        );
        if (value.length > 32000) return;
        input.value = TextEditingValue(
          text: value,
          selection: TextSelection.collapsed(
            offset: start + prefix.length + transcript.length,
          ),
        );
        controller.scope.saveChatDraft(controller.draftKey, value);
      }),
    );
  }
}
