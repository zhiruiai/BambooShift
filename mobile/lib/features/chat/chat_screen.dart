import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'chat_controller.dart';
import 'chat_composer_input.dart';
import 'chat_header_title.dart';
import 'chat_mentions.dart';
import 'chat_skills.dart';
import 'chat_pending_controls.dart';
import 'chat_project_library.dart';
import 'chat_read_observer.dart';
import 'chat_timeline.dart';
import 'attachment_controller.dart';
import 'attachment_panel.dart';
import 'attachment_selection.dart';
import '../bots/group_settings.dart';
import '../computer/computer_screen.dart';
import '../voice/voice_controller.dart';
import '../voice/voice_controls.dart';
import '../voice/voice_transport.dart';
import '../voice/voice_memo_controller.dart';
import '../voice/voice_memo_data.dart';
import '../voice/voice_memo_transport.dart';

part 'chat_screen_actions.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.scope,
    required this.conversationId,
    this.threadRootId,
    this.initialMessageId,
    this.attachmentPicker,
    this.voiceTransport,
    this.memoTransport,
  });
  final WorkspaceController scope;
  final String conversationId;
  final String? threadRootId;
  final String? initialMessageId;
  final AttachmentPicker? attachmentPicker;
  final VoiceTransport? voiceTransport;
  final VoiceMemoTransport? memoTransport;
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late ChatController chat;
  late VoiceController voice;
  late VoiceMemoController memos;
  bool memoRequested = false;
  late AttachmentController attachments;
  final input = TextEditingController();
  final inputFocus = FocusNode();
  final scroll = ScrollController(keepScrollOffset: false);
  late String? focusedMessageId;
  int inboundRevision = 0;
  int readRefresh = 0;
  @override
  void initState() {
    super.initState();
    focusedMessageId = widget.initialMessageId;
    createControllers();
    widget.scope.addListener(syncInboundDraft);
  }

  void createControllers() {
    final scope = widget.scope, conversationId = widget.conversationId;
    final thread = widget.threadRootId;
    final key = chatScopeKey(conversationId, thread);
    input.text = scope.chatDraft(key);
    inboundRevision = scope.inboundDraftRevision(key);
    late final ChatController currentChat;
    final currentAttachments = AttachmentController(
      scope,
      conversationId,
      picker: widget.attachmentPicker,
      threadRootId: thread,
      isEditable: () =>
          currentChat.ready &&
          currentChat.pending == null &&
          !currentChat.busy &&
          !voice.active,
    );
    currentChat = ChatController(
      scope,
      conversationId,
      threadRootId: thread,
      onAccepted: (content) async {
        final draft = scope.chatDraft(key);
        final options = scope.chatOptions(key);
        final pending = currentChat.pending;
        if (pending?['requestVoiceMemo'] == true && current(currentChat)) {
          setState(() => memoRequested = false);
        }
        var matchesDraft = content == draft.trim();
        try {
          matchesDraft = content == currentAttachments.compose(draft);
        } on ApiException {
          // The accepted text can outlive an unavailable local attachment.
        }
        await currentAttachments.acknowledgeSent(content);
        if (matchesDraft &&
            options.agentId == pending?['agentId'] &&
            options.skillId == pending?['skillId'] &&
            options.mentions == chatGroupMentionRequest(pending?['mentions']) &&
            (options.replyId ?? thread) == pending?['replyToMessageId'] &&
            options.app == chatAppPin(pending?['appContext']) &&
            scope.chatDraft(key) == draft &&
            scope.chatOptions(key) == options) {
          scope.saveChatDraft(key, '');
          scope.saveChatOptions(key, emptyChatOptions);
        }
      },
    );
    chat = currentChat;
    attachments = currentAttachments;
    memoRequested = false;
    memos = VoiceMemoController(scope, transport: widget.memoTransport);
    voice = VoiceController(
      chat,
      transport: widget.voiceTransport ?? const VoiceTransport(),
    );
    unawaited(initialize());
  }

  void syncInboundDraft() => inboundRevision = syncInboundChatText(
    input,
    widget.scope,
    chat.draftKey,
    inboundRevision,
  );

  Future<void> initialize() async {
    final currentChat = chat, currentAttachments = attachments;
    await currentAttachments.initialize();
    if (!mounted || !identical(chat, currentChat)) return;
    await currentChat.initialize();
    reflectAcknowledgedDraft(currentChat);
  }

  void reflectAcknowledgedDraft(ChatController controller) {
    if (mounted &&
        identical(chat, controller) &&
        controller.active &&
        controller.pending == null &&
        controller.scope.chatDraft(controller.draftKey).isEmpty &&
        input.text.isNotEmpty) {
      input.clear();
    }
  }

  @override
  void didUpdateWidget(ChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scope != widget.scope) {
      oldWidget.scope.removeListener(syncInboundDraft);
      widget.scope.addListener(syncInboundDraft);
    }
    if (oldWidget.scope != widget.scope ||
        oldWidget.conversationId != widget.conversationId ||
        oldWidget.threadRootId != widget.threadRootId) {
      memos.dispose();
      voice.dispose();
      attachments.dispose();
      chat.dispose();
      if (scroll.hasClients) scroll.jumpTo(0);
      createControllers();
    }
    if (oldWidget.conversationId != widget.conversationId ||
        oldWidget.scope != widget.scope ||
        oldWidget.threadRootId != widget.threadRootId ||
        oldWidget.initialMessageId != widget.initialMessageId) {
      focusedMessageId = widget.initialMessageId;
    }
  }

  @override
  void dispose() {
    widget.scope.removeListener(syncInboundDraft);
    memos.dispose();
    voice.dispose();
    attachments.dispose();
    chat.dispose();
    input.dispose();
    inputFocus.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (voice.active) return;
    final currentChat = chat, currentAttachments = attachments;
    final scope = widget.scope, id = widget.conversationId;
    final options = scope.chatOptions(currentChat.draftKey);
    final conversation = scope.find('conversations', id);
    final reply = scopedMessage(id, options.replyId);
    final choices = chatMentions(scope, conversation);
    if ((memoRequested && !memoAllowed) ||
        !validChatDraftOptions(options, reply, choices, scope, conversation) ||
        (options.skillId != null &&
            !chatSkills(
              scope,
              conversation,
              options,
            ).any((skill) => skill.id == options.skillId)) ||
        (currentChat.threadRootId != null &&
            scopedMessage(id, currentChat.threadRootId) == null)) {
      return;
    }
    try {
      if (await currentChat.send(
        currentAttachments.compose(input.text),
        agentId: options.agentId,
        skillId: options.skillId,
        mentions: options.mentions,
        replyToMessageId: options.replyId,
        app: options.app,
        requestVoiceMemo: memoRequested,
      )) {
        reflectAcknowledgedDraft(currentChat);
      }
    } catch (e) {
      if (mounted && identical(chat, currentChat) && widget.scope.active) {
        attachments.error = e is ApiException ? e.message : 'requestFailed';
        attachments.notify();
      }
    }
  }

  bool current(ChatController controller) =>
      mounted && identical(chat, controller) && controller.active;

  bool canEditOptions(ChatController controller) =>
      current(controller) &&
      !voice.active &&
      controller.pending == null &&
      !controller.busy;

  void updateOptions(ChatController controller, ChatDraftOptions options) {
    if (!canEditOptions(controller)) return;
    setState(
      () => controller.scope.saveChatOptions(controller.draftKey, options),
    );
  }

  void updateMemo(bool value) => setState(() => memoRequested = value);

  void setFocusedMessage(String id) => setState(() => focusedMessageId = id);

  Future<void> _refresh() async {
    final scope = widget.scope, currentChat = chat;
    final conversationId = widget.conversationId;
    await scope.refresh();
    if (mounted &&
        identical(scope, widget.scope) &&
        identical(chat, currentChat) &&
        conversationId == widget.conversationId &&
        scope.active) {
      setState(() => readRefresh++);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      chat,
      attachments,
      widget.scope,
      inputFocus,
      input,
      voice,
    ]),
    builder: (context, _) {
      final visibleHeight =
          MediaQuery.sizeOf(context).height -
          MediaQuery.viewInsetsOf(context).bottom;
      final compact = visibleHeight <= 360;
      final scope = widget.scope;
      final controller = chat, id = widget.conversationId;
      final thread = controller.threadRootId;
      final root = scopedMessage(id, thread);
      final conversation = scope.find('conversations', id);
      final messages = chat.messages;
      final focus = focusedMessageId == null
          ? -1
          : messages.indexWhere((row) => row['id'] == focusedMessageId);
      final modelReady = scope.data?['settings']?['configured'] == true;
      final options = scope.chatOptions(controller.draftKey);
      final choices = chatMentions(scope, conversation);
      final skills = chatSkills(scope, conversation, options);
      final selectedSkill = skills
          .where((item) => item.id == options.skillId)
          .firstOrNull;
      final reply = scopedMessage(id, options.replyId);
      final members = conversation?['agentIds'] as List? ?? [];
      final replyAgent =
          (reply ?? root)?['agentId'] ?? root?['delivery']?['agentId'];
      final destination =
          selectedChatBotIds(options).firstOrNull ??
          (members.contains(replyAgent) ? replyAgent : members.firstOrNull);
      final lead = destination is String
          ? scope.find('agents', destination)
          : null;
      final sourceUnavailable = !botAvailable(lead);
      final canCompose =
          scope.active &&
          conversation != null &&
          modelReady &&
          (thread == null || root != null);
      final editable =
          canCompose &&
          chat.ready &&
          chat.pending == null &&
          !chat.busy &&
          !voice.active;
      final canSend =
          editable &&
          !sourceUnavailable &&
          (options.skillId == null || selectedSkill != null) &&
          validChatDraftOptions(options, reply, choices, scope, conversation);
      final active = (scope.data?['runningRequests'] as List? ?? [])
          .whereType<Json>()
          .where((r) => r['conversationId'] == widget.conversationId)
          .firstOrNull;
      final canStop =
          active?['requester'] is Map &&
          active!['requester']['userId'] == scope.userId &&
          chatThreadRoot(active) == thread;
      final canCall =
          canSend &&
          voice.supported &&
          !memoRequested &&
          thread == null &&
          conversation['isGroup'] != true &&
          members.length == 1 &&
          options == emptyChatOptions &&
          input.text.trim().isEmpty &&
          attachments.selections.isEmpty &&
          attachments.files.isEmpty &&
          !attachments.blocksSend &&
          active == null;
      return Scaffold(
        appBar: AppBar(
          title: ChatHeaderTitle(
            key: ValueKey((scope, id, thread)),
            title: thread == null
                ? ((conversation?['title'] as String?) ?? context.tr('chats'))
                : context.tr('chatThread'),
            scope: scope,
            bot: lead,
            working: active != null && chatThreadRoot(active) == thread,
            messages: messages,
            threadRootId: thread,
          ),
          actions: [
            if (thread == null && !voice.active) ChatProjectLibrary(scope, id),
            if (thread == null &&
                !voice.active &&
                lead != null &&
                !isManagedBot(lead))
              computerAction(scope, lead['id'] as String),
            if (thread == null && conversation?['isGroup'] == true)
              groupSettingsAction(scope),
            IconButton(
              tooltip: context.tr('refresh'),
              onPressed: _refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: Column(
            children: [
              if (thread == null)
                ChatReadObserver(
                  scope: scope,
                  conversationId: widget.conversationId,
                  rendered: conversation,
                  scroll: scroll,
                  refreshToken: readRefresh,
                ),
              if (scope.disconnected)
                Notice('progressNotice', action: 'refresh', onAction: _refresh),
              if (chat.error != null && !voice.active) Notice(chat.error!),
              if (voice.error != null) Notice(voice.error!),
              if (conversation == null) const Notice('unavailable'),
              if (thread != null && root == null)
                const Notice('chatThreadUnavailable'),
              if (active != null && chatThreadRoot(active) != thread)
                const Notice('chatThreadWaiting'),
              if (!modelReady) const Notice('modelMissing'),
              if (sourceUnavailable) const Notice('unavailable'),
              Expanded(
                child: messages.isEmpty
                    ? Center(child: Text(context.tr('noMessages')))
                    : ChatTimeline(
                        scope: scope,
                        messages: messages,
                        memoController: voice.active ? null : memos,
                        scroll: scroll,
                        focus: focus,
                        onReply: editable
                            ? (message) => replyTo(controller, message)
                            : null,
                        onReact: scope.active ? controller.react : null,
                        onJump: (messageId) => jumpTo(controller, messageId),
                        onThread:
                            thread == null && scope.active && !voice.active
                            ? (message) => openThread(controller, message)
                            : null,
                        reactionPending: controller.reactionPending,
                      ),
              ),
              if (focus >= 0)
                TextButton.icon(
                  onPressed: () {
                    if (scroll.hasClients) scroll.jumpTo(0);
                    setState(() => focusedMessageId = null);
                  },
                  icon: const Icon(Icons.arrow_downward),
                  label: Text(context.tr('mobileSearchLatest')),
                ),
              if (chat.pending != null)
                ChatPendingControls(
                  onCheck: chat.busy ? null : () => _recover(retry: false),
                  onRetry: chat.busy ? null : () => _recover(retry: true),
                ),
              if (canStop && !voice.active)
                TextButton.icon(
                  onPressed: chat.busy ? null : () => chat.stop(),
                  icon: const Icon(Icons.stop_circle_outlined),
                  label: Text(context.tr('stop')),
                ),
              if (voice.active)
                VoiceControls(voice)
              else ...[
                AttachmentPanel(
                  controller: attachments,
                  compact: compact,
                  skillAction: editable && !memoRequested && skills.isNotEmpty
                      ? TextButton.icon(
                          onPressed: () => selectSkill(controller, skills),
                          icon: const Icon(
                            Icons.auto_awesome_outlined,
                            size: 18,
                          ),
                          label: Text(context.tr('chatUseSkill')),
                        )
                      : null,
                ),
                ChatComposerInput(
                  compactHeight: compact ? visibleHeight : null,
                  scope: scope,
                  input: input,
                  focus: inputFocus,
                  options: options,
                  reply: reply,
                  choices: choices,
                  skill: selectedSkill,
                  editable: editable,
                  busy: chat.busy,
                  onOptions: (next) => applyDraftControls(controller, next),
                  onJump: (messageId) => jumpTo(controller, messageId),
                  onMention: (choice, token) =>
                      selectMention(controller, choice, token),
                  onChanged: (text) =>
                      scope.saveChatDraft(controller.draftKey, text),
                  onSend:
                      attachments.blocksSend ||
                          !canSend ||
                          (memoRequested && !memoAllowed)
                      ? null
                      : _send,
                  memoSelected: memoRequested,
                  onMemo: editable && (memoRequested || memoAllowed)
                      ? setMemo
                      : null,
                  onDictate: editable && voice.supported ? dictate : null,
                  onVoiceCall: canCall ? startVoiceCall : null,
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
