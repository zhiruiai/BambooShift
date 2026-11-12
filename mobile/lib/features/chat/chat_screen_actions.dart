part of 'chat_screen.dart';

extension _ChatScreenActions on _ChatScreenState {
  Widget chatModelNotice(ChatController controller) => controller.scope.owner
      ? Notice(
          'chatModelRequired',
          action: 'mobileModelsLibrary',
          onAction: () => openChatModels(controller),
        )
      : const Notice('chatModelRequiresOwner');

  Future<void> openChatModels(ChatController controller) async {
    final scope = controller.scope;
    if (!current(controller) ||
        !scope.owner ||
        scope.find('conversations', controller.conversationId) == null) {
      return;
    }
    await Navigator.push<void>(
      context,
      MaterialPageRoute(builder: (_) => ModelSettings(scope: scope)),
    );
    if (current(controller) && scope.data?['settings']?['configured'] != true) {
      await _refresh();
    }
  }

  Future<void> _recover({required bool retry}) async {
    final currentChat = chat;
    if (retry) {
      await currentChat.retry();
    } else {
      await currentChat.check();
    }
    reflectAcknowledgedDraft(currentChat);
  }

  Json? scopedMessage(String conversation, String? id) {
    if (id == null) return null;
    final message = widget.scope.find('messages', id);
    final thread = widget.threadRootId;
    return message?['conversationId'] == conversation &&
            (id == thread
                ? chatThreadRoot(message) == null
                : chatThreadRoot(message) == thread)
        ? message
        : null;
  }

  Future<void> selectSkill(
    ChatController controller,
    List<ChatSkill> skills,
  ) async {
    if (!canEditOptions(controller) || memoRequested) return;
    final selected = await chooseChatSkill(context, skills);
    if (!mounted ||
        selected == null ||
        !canEditOptions(controller) ||
        memoRequested) {
      return;
    }
    final scope = controller.scope;
    final options = scope.chatOptions(controller.draftKey);
    final conversation = scope.find('conversations', controller.conversationId);
    if (!chatSkills(scope, conversation, options).contains(selected)) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(context.tr('chatSkillChanged'))));
      return;
    }
    updateOptions(
      controller,
      options.withSkill(selected.id, bot: selected.agentId),
    );
    inputFocus.requestFocus();
  }

  List<Widget> chatToolbar(ChatController controller, Json? lead, bool group) {
    final scope = controller.scope;
    final id = controller.conversationId;
    final mainChat = controller.threadRootId == null;
    final computerId =
        mainChat && !voice.active && lead != null && !isManagedBot(lead)
        ? lead['id']
        : null;
    final library = mainChat && !voice.active
        ? chatProjectLibraryAction(context, scope, id)
        : null;
    final actions = <({IconData icon, String label, VoidCallback run})>[
      if (library != null)
        (
          icon: Icons.folder_outlined,
          label: 'mobileChatLibraryTitle',
          run: library,
        ),
      if (computerId is String)
        (
          icon: Icons.computer_outlined,
          label: 'mobileComputerTitle',
          run: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => ComputerScreen(scope: scope, agentId: computerId),
            ),
          ),
        ),
      if (mainChat && group)
        (
          icon: Icons.tune,
          label: 'groupSettings',
          run: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => GroupSettings(scope: scope, conversationId: id),
            ),
          ),
        ),
      (icon: Icons.refresh, label: 'refresh', run: _refresh),
    ];
    void perform(VoidCallback run) {
      if (current(controller)) run();
    }

    final normalText = MediaQuery.textScalerOf(context).scale(20) <= 25;
    final direct =
        actions.length == 1 ||
        (MediaQuery.sizeOf(context).width >= 460 && normalText);
    final visible = direct
        ? actions
        : actions
              .where(
                (action) =>
                    !group &&
                    normalText &&
                    action.label == 'mobileComputerTitle',
              )
              .toList();
    final menu = actions.where((action) => !visible.contains(action));
    return [
      for (final action in visible)
        IconButton(
          tooltip: context.tr(action.label),
          onPressed: () => perform(action.run),
          icon: Icon(action.icon),
        ),
      if (menu.isNotEmpty)
        PopupMenuButton<VoidCallback>(
          tooltip: context.tr('chatConversationActions'),
          icon: const Icon(Icons.more_horiz),
          onSelected: perform,
          itemBuilder: (context) => [
            for (final action in menu)
              PopupMenuItem(
                value: action.run,
                child: Row(
                  children: [
                    Icon(action.icon, size: 20),
                    const SizedBox(width: 12),
                    Flexible(child: Text(context.tr(action.label))),
                  ],
                ),
              ),
          ],
        ),
    ];
  }

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
