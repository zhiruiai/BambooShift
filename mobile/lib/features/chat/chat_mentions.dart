import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';

typedef ChatMentionToken = ({int start, int end, String query});

ChatMentionToken? chatMentionToken(TextEditingValue value) {
  if (!value.selection.isValid ||
      !value.selection.isCollapsed ||
      (value.composing.isValid && !value.composing.isCollapsed)) {
    return null;
  }
  final end = value.selection.end;
  if (end <= 0 || end > value.text.length) return null;
  final prefix = value.text.substring(0, end);
  final start = prefix.lastIndexOf('@');
  if (start < 0 ||
      (start > 0 && !RegExp(r'[\s（(［\[，、：:]').hasMatch(prefix[start - 1]))) {
    return null;
  }
  final query = prefix.substring(start + 1);
  if (RegExp(r'\s').hasMatch(query)) return null;
  return (start: start, end: end, query: query.toLowerCase());
}

class ChatMention {
  const ChatMention.bot(this.id, this.name, Json profile)
    : app = null,
      bot = profile,
      everyone = false;

  const ChatMention.app(this.id, this.name, ChatAppPin pin)
    : app = pin,
      bot = null,
      everyone = false;

  const ChatMention.everyone()
    : id = '',
      name = 'everyone',
      app = null,
      bot = null,
      everyone = true;

  final String id, name;
  final Json? bot;
  final ChatAppPin? app;
  final bool everyone;
  String label(BuildContext context) => everyone
      ? '@${context.tr('chatEveryone')}'
      : bot == null
      ? name
      : '@$name';

  bool matches(BuildContext context, String query) =>
      name.toLowerCase().contains(query) ||
      (everyone &&
          (context.tr('chatEveryone').toLowerCase().contains(query) ||
              'all'.contains(query) ||
              '全体'.contains(query)));

  String kind(BuildContext context) => everyone
      ? context.tr('chatMentionGroup')
      : bot == null
      ? context.tr('chatApp')
      : 'Bot';

  Widget icon(WorkspaceController scope) => everyone
      ? const Icon(Icons.groups_outlined, size: 22)
      : bot == null
      ? const Icon(Icons.extension_outlined, size: 20)
      : BotAvatar(
          bot: bot!,
          family: scope.session.avatarTheme,
          size: 24,
          scope: scope,
        );
}

List<ChatMention> chatMentions(WorkspaceController scope, Json? conversation) {
  final ids = conversation?['agentIds'];
  if (!scope.active || ids is! List || ids.isEmpty) return [];
  final members = ids
      .whereType<String>()
      .map((id) => scope.find('agents', id))
      .toList();
  final bots = [
    for (final bot in members.whereType<Json>())
      if (botAvailable(bot) && bot['id'] is String && bot['name'] is String)
        ChatMention.bot(bot['id'] as String, bot['name'] as String, bot),
  ];
  return [
    if (conversation?['isGroup'] == true) ...[
      if (bots.length == ids.length && bots.length <= maxChatMentionRecipients)
        const ChatMention.everyone(),
      ...bots,
    ],
    if (members.every((bot) => bot != null && !isManagedBot(bot)))
      for (final app in scope.items('apps'))
        if (availableChatApp(app) case final ChatAppPin pin)
          if (app['name'] case final String name)
            ChatMention.app(pin.connectionId, name, pin),
  ];
}

List<String> selectedChatBotIds(ChatDraftOptions options) =>
    options.mentions?.agentIds ?? [?options.agentId];

List<ChatMention> availableChatMentions(
  List<ChatMention> choices,
  ChatDraftOptions options,
) {
  if (options.mentions?.everyone == true) return [];
  final selected = selectedChatBotIds(options);
  return choices.where((choice) {
    if (choice.everyone) return options.app == null && selected.isEmpty;
    if (choice.app != null) {
      return options.mentions == null && choice.app != options.app;
    }
    return options.skillId == null &&
        selected.length < maxChatMentionRecipients &&
        !selected.contains(choice.id);
  }).toList();
}

bool validChatDraftOptions(
  ChatDraftOptions options,
  Json? reply,
  List<ChatMention> choices,
  WorkspaceController scope,
  Json? conversation,
) =>
    (options.replyId == null || reply != null) &&
    selectedChatBotIds(options).every(
      (id) =>
          conversation?['agentIds'] is List &&
          (conversation!['agentIds'] as List).contains(id) &&
          botAvailable(scope.find('agents', id)),
    ) &&
    (options.mentions?.everyone != true ||
        choices.any((choice) => choice.everyone)) &&
    (options.app == null || choices.any((choice) => choice.app == options.app));

ChatDraftOptions addChatMention(ChatDraftOptions options, ChatMention choice) {
  if (choice.everyone) {
    return (
      agentId: null,
      skillId: null,
      mentions: const ChatGroupMentions.everyone(),
      app: null,
      replyId: options.replyId,
    );
  }
  if (choice.app case final app?) {
    return (
      agentId: options.agentId,
      skillId: options.skillId,
      mentions: null,
      app: app,
      replyId: options.replyId,
    );
  }
  return _botOptions(options, [
    if (options.app == null) ...selectedChatBotIds(options),
    choice.id,
  ]);
}

ChatDraftOptions removeChatMention(ChatDraftOptions options, String? id) =>
    _botOptions(
      options,
      selectedChatBotIds(options).where((selected) => selected != id).toList(),
    );

ChatDraftOptions _botOptions(ChatDraftOptions options, List<String> selected) =>
    (
      agentId: selected.length == 1 ? selected.single : null,
      skillId: selected.length == 1 && selected.single == options.agentId
          ? options.skillId
          : null,
      mentions: selected.length > 1 ? ChatGroupMentions.bots(selected) : null,
      app: options.app,
      replyId: options.replyId,
    );

TextEditingValue applyChatMentionToken(
  TextEditingValue value,
  ChatMentionToken token,
  String label,
) => TextEditingValue(
  text: value.text.replaceRange(token.start, token.end, label),
  selection: TextSelection.collapsed(offset: token.start + label.length),
);

TextEditingValue unmarkRemovedChatRecipients(
  BuildContext context,
  WorkspaceController scope,
  TextEditingValue value,
  ChatDraftOptions before,
  ChatDraftOptions after,
) {
  final kept = selectedChatBotIds(after);
  final labels = [
    if (before.mentions?.everyone == true && after.mentions?.everyone != true)
      '@${context.tr('chatEveryone')}',
    for (final id in selectedChatBotIds(before))
      if (!kept.contains(id))
        if (scope.find('agents', id)?['name'] case final String name) '@$name',
  ];
  final offsets = <int>{};
  // Inline markers can still trigger legacy server routing after a chip is removed.
  for (final label in labels) {
    final token = RegExp(
      RegExp.escape(label) + r'(?=$|[\s，。！？、；：,.!?;:)\]}）】])',
    );
    offsets.addAll(token.allMatches(value.text).map((match) => match.start));
  }
  if (offsets.isEmpty) return value;
  final removed = offsets.toList()..sort((a, b) => b.compareTo(a));
  var text = value.text;
  for (final offset in removed) {
    text = text.replaceRange(offset, offset + 1, '');
  }
  int shift(int offset) =>
      offset - removed.where((marker) => marker < offset).length;
  return TextEditingValue(
    text: text,
    selection: TextSelection(
      baseOffset: shift(value.selection.baseOffset),
      extentOffset: shift(value.selection.extentOffset),
    ),
  );
}

class ChatMentionButton extends StatelessWidget {
  const ChatMentionButton({
    super.key,
    required this.scope,
    required this.choices,
    required this.onSelect,
  });

  final WorkspaceController scope;
  final List<ChatMention> choices;
  final ValueChanged<ChatMention> onSelect;

  @override
  Widget build(BuildContext context) => PopupMenuButton<ChatMention>(
    tooltip: context.tr('chatChooseMention'),
    icon: const Icon(Icons.alternate_email, size: 20),
    onSelected: onSelect,
    itemBuilder: (context) => [
      for (final choice in choices)
        PopupMenuItem(
          value: choice,
          child: Row(
            children: [
              choice.icon(scope),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  choice.label(context),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
    ],
  );
}

class ChatMentionSuggestions extends StatelessWidget {
  const ChatMentionSuggestions({
    super.key,
    required this.scope,
    required this.choices,
    required this.token,
    required this.onSelect,
  });

  final WorkspaceController scope;
  final List<ChatMention> choices;
  final ChatMentionToken token;
  final ValueChanged<ChatMention> onSelect;

  @override
  Widget build(BuildContext context) {
    final matches = choices
        .where((choice) => choice.matches(context, token.query))
        .take(6)
        .toList();
    if (matches.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Material(
        color: Theme.of(context).colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 142),
          child: ListView.builder(
            shrinkWrap: true,
            primary: false,
            padding: EdgeInsets.zero,
            itemCount: matches.length,
            itemBuilder: (context, index) {
              final choice = matches[index];
              return ListTile(
                dense: true,
                leading: choice.icon(scope),
                title: Text(
                  choice.label(context),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: Text(
                  choice.kind(context),
                  style: const TextStyle(fontSize: 12),
                ),
                onTap: () => onSelect(choice),
              );
            },
          ),
        ),
      ),
    );
  }
}
