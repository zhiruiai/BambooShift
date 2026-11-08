import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import '../chat/chat_screen.dart';
import '../collaboration/proposal_access.dart';
import '../collaboration/team_data.dart';
import 'bot_creation_preview.dart';
import 'create_screen.dart';

Json? botCreationProposal(Json message) {
  if (!isCreationProposal(message)) return null;
  final metadata = message['metadata'];
  return metadata is Json
      ? botCreationPreview(metadata['creationPreview'])
      : null;
}

class BotCreationCard extends StatefulWidget {
  const BotCreationCard({
    super.key,
    required this.scope,
    required this.message,
    required this.profile,
  });

  final WorkspaceController scope;
  final Json message;
  final Json profile;

  @override
  State<BotCreationCard> createState() => _BotCreationCardState();
}

class _BotCreationCardState extends State<BotCreationCard> {
  ProposalAccess? pending;
  bool failed = false;

  bool get canReview => canReviewCreation(widget.scope, widget.message);

  Future<void> _review() async {
    if (pending != null || !canReview) return;
    final scope = widget.scope;
    final expected = copyJson(widget.message);
    final access = ProposalAccess(scope);
    setState(() {
      pending = access;
      failed = false;
    });
    try {
      final actual = await access.creation(expected);
      final profile = botCreationProposal(actual);
      if (profile == null) {
        throw const ApiException('STALE_PROPOSAL', 'unavailable');
      }
      if (!mounted ||
          !access.active ||
          !identical(scope, widget.scope) ||
          canonical(widget.message) != canonical(expected)) {
        return;
      }
      final id = await Navigator.push<String>(
        context,
        MaterialPageRoute(
          builder: (_) =>
              CreateScreen(scope: scope, kind: 'bot', initialProfile: profile),
        ),
      );
      if (id == null || !mounted || !access.active) return;
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (_) => ChatScreen(scope: scope, conversationId: id),
        ),
      );
    } catch (_) {
      if (mounted && access.active && identical(scope, widget.scope)) {
        setState(() => failed = true);
      }
    } finally {
      access.dispose();
      if (mounted && identical(pending, access)) {
        setState(() => pending = null);
      }
    }
  }

  @override
  void dispose() {
    pending?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.scope, widget.scope.session]),
    builder: (context, _) {
      final profile = widget.profile;
      final description = profile['description'] as String;
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  context.tr('mobileBotDraftCardTitle'),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const SizedBox(height: 8),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: BotAvatar(
                  bot: profile,
                  family: widget.scope.session.avatarTheme,
                  size: 42,
                ),
                title: Text(profile['name'] as String),
                subtitle: Text(profile['role'] as String),
              ),
              if (description.isNotEmpty)
                Text(description, maxLines: 4, overflow: TextOverflow.ellipsis),
              if (failed) const Notice('unavailable'),
              if (pending != null) const LinearProgressIndicator(),
              if (canReview)
                TextButton(
                  onPressed: pending == null ? _review : null,
                  child: Text(context.tr('mobileBotDraftCardReview')),
                )
              else
                Text(context.tr('mobileBotDraftCardOwner')),
            ],
          ),
        ),
      );
    },
  );
}
