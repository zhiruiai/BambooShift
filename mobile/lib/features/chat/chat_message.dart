import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../bots/bot_creation_card.dart';
import '../collaboration/app_connection_proposal_card.dart';
import '../collaboration/proposal_card.dart';
import '../collaboration/proposal_access.dart';
import '../collaboration/team_data.dart';
import '../settings/avatar_theme_card.dart';
import '../files/website_project_card.dart';
import '../voice/voice_memo_card.dart';
import '../voice/voice_memo_controller.dart';
import '../voice/voice_memo_data.dart';
import '../voice/voice_transcript_card.dart';
import 'action_card.dart';
import 'action_data.dart';
import 'chat_markdown.dart';
import 'chat_message_controls.dart';
import 'chat_question_card.dart';
import 'chat_question_data.dart';
import 'file_card.dart';
import 'web_research_card.dart';
import 'web_research_data.dart';

class ChatMessage extends StatelessWidget {
  const ChatMessage({
    super.key,
    required this.scope,
    required this.message,
    this.onReply,
    this.onReact,
    this.onJump,
    this.onThread,
    this.memoController,
  });
  final WorkspaceController scope;
  final Json message;
  final VoidCallback? onReply;
  final ValueChanged<String>? onReact;
  final ValueChanged<String>? onJump;
  final VoidCallback? onThread;
  final VoiceMemoController? memoController;
  @override
  Widget build(BuildContext context) {
    if (message['kind'] == 'web_research') {
      final research = WebResearch.fromMessage(message);
      if (research == null) return const SizedBox.shrink();
      return WebResearchCard(
        scope: scope,
        message: message,
        research: research,
      );
    }
    if (message['kind'] == 'question') {
      final question = ChatQuestion.parse(message);
      if (question == null) return const SizedBox.shrink();
      return ChatQuestionCard(
        key: ValueKey((scope, question.id, question.conversationId)),
        scope: scope,
        question: question,
      );
    }
    if (message['kind'] == 'voice_call' && message['role'] == 'system') {
      return VoiceTranscriptCard(scope: scope, message: message);
    }
    if (websiteProjectFor(message) != null) {
      return WebsiteProjectCard(
        scope: scope,
        message: message,
        onDiscuss: onReply,
      );
    }
    final botProposal = botCreationProposal(message);
    if (botProposal != null) {
      return BotCreationCard(
        key: ValueKey('${scope.userId}:${scope.workspaceId}:${message['id']}'),
        scope: scope,
        message: message,
        profile: botProposal,
      );
    }
    final themeProposal = avatarThemeProposal(message);
    if (themeProposal != null) {
      return AvatarThemeCard(
        scope: scope,
        message: message,
        theme: themeProposal,
      );
    }
    if (appProposal(message) != null) {
      return AppConnectionProposalCard(
        key: ValueKey('${scope.userId}:${scope.workspaceId}:${message['id']}'),
        scope: scope,
        message: message,
      );
    }
    if (teamCard(message) != null) {
      return CollaborationCard(
        key: ValueKey('${scope.userId}:${scope.workspaceId}:${message['id']}'),
        scope: scope,
        message: message,
      );
    }
    final action = ChatAction.fromMessage(message);
    if (action != null) {
      return ActionCard(
        key: ValueKey('${scope.workspaceId}:${message['id']}:${action.id}'),
        scope: scope,
        message: message,
        action: action,
      );
    }
    if (message['kind'] == 'file') {
      final memo = VoiceMemo.fromMessage(scope, message);
      if (memo != null) return VoiceMemoCard(memo, controller: memoController);
      return ChatFileCard(scope: scope, message: message);
    }
    final own = message['role'] == 'user' && message['userId'] == scope.userId;
    final author = message['metadata']?['author'];
    final currentAgent = scope.find(
      'agents',
      message['agentId'] as String? ?? '',
    );
    final agent = currentAgent ?? (author is Json ? author : null);
    final time = DateTime.tryParse(message['createdAt'] as String? ?? '');
    final ownName = (scope.session.user?['name'] as String?) ?? '';
    final name =
        (agent?['name'] as String?) ??
        (own
            ? ownName
            : (author is Json ? author['name'] as String? : null) ?? '');
    final reply = message['replyTo'];
    final target = reply is Json ? reply['id'] : null;
    final app = message['appContext'];
    final appName = app is Json ? app['name'] : null;
    final delivery = message['delivery'];
    final explicit = delivery is Json ? delivery['explicitAgentId'] : null;
    final explicitAgent = explicit is String
        ? scope.find('agents', explicit)
        : null;
    final explicitBot = explicitAgent?['name'];
    final mentions = chatGroupMentionReceipt(message['mentions']);
    final recipients =
        mentions?.agentIds.map((id) {
          final name = scope.find('agents', id)?['name'];
          return '@${name is String ? name : context.tr('chatBotUnavailable')}';
        }).toList() ??
        const [];
    final audience = [
      if (mentions?.everyone == true)
        '@${context.tr('chatEveryone')}'
      else
        ...recipients,
      if (explicitBot is String && mentions == null) '@$explicitBot',
      if (appName is String) '${context.tr('chatApp')} · $appName',
    ].join('  ·  ');
    final interactable =
        message['id'] is String &&
        (message['role'] == 'user' || message['role'] == 'assistant') &&
        message['status'] != 'running';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        mainAxisAlignment: own
            ? MainAxisAlignment.end
            : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!own && agent != null) ...[
            BotAvatar(
              bot: agent,
              family: scope.session.avatarTheme,
              size: 32,
              scope: currentAgent == null ? null : scope,
            ),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: own
                    ? Theme.of(context).colorScheme.secondaryContainer
                    : Theme.of(context).colorScheme.surface,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (name.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(
                        name,
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  if (reply is Json)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: ChatQuote(
                        title:
                            reply['author'] as String? ??
                            context.tr('chatReply'),
                        content: chatExcerpt(context, reply['content']),
                        onTap: target is String && onJump != null
                            ? () => onJump!(target)
                            : null,
                      ),
                    ),
                  if (audience.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Tooltip(
                        message: mentions?.everyone == true
                            ? recipients.join(' · ')
                            : audience,
                        child: Text(
                          audience,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                  ChatMarkdown(
                    text: message['content'] as String? ?? '',
                    canOpenLink: () => scope.active,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    [
                      if (time != null) DateFormat.Hm().format(time.toLocal()),
                      if (message['status'] == 'running') context.tr('working'),
                      if (message['status'] == 'error')
                        context.tr('requestFailed'),
                    ].join(' · '),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (interactable)
                    ChatMessageControls(
                      message: message,
                      userId: scope.userId,
                      onReply: onReply,
                      onReact: onReact,
                      onThread: onThread,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
