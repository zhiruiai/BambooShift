import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../chat/chat_screen.dart';
import 'proposal_access.dart';
import 'team_data.dart';
import 'team_plans_screen.dart';

class CollaborationCard extends StatefulWidget {
  const CollaborationCard({
    super.key,
    required this.scope,
    required this.message,
  });
  final WorkspaceController scope;
  final Json message;
  @override
  State<CollaborationCard> createState() => _CollaborationCardState();
}

class _CollaborationCardState extends State<CollaborationCard> {
  late final ProposalAccess access;
  bool busy = false;
  String? error;
  int epoch = 0;
  @override
  void initState() {
    super.initState();
    access = ProposalAccess(widget.scope);
  }

  @override
  void didUpdateWidget(CollaborationCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (canonical(oldWidget.message) != canonical(widget.message)) epoch++;
  }

  @override
  void dispose() {
    epoch++;
    access.dispose();
    super.dispose();
  }

  Future<void> open() async {
    if (busy ||
        !access.active ||
        !teamProposalBot(widget.scope, widget.message)) {
      return;
    }
    final order = epoch, expected = copyJson(widget.message);
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final id = await access.team(expected);
      if (!mounted || order != epoch || !access.active) return;
      await Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) =>
              TeamPlansScreen(scope: widget.scope, initialPlanId: id),
        ),
      );
    } catch (e) {
      if (mounted && order == epoch && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> openCreated() async {
    if (busy || !widget.scope.active) return;
    final order = epoch, card = teamCard(widget.message);
    if (card?['status'] != 'committed' || card?['result'] == null) return;
    final id = card!['result']['conversationId'];
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final snapshot = await widget.scope.requestValue(
        'GET',
        '/bootstrap',
        cancellation: access.cancellation,
      );
      if (!mounted || order != epoch || !widget.scope.active) return;
      if (snapshot is! Json) {
        throw const ApiException('MISSING_CHAT', 'unavailable');
      }
      final current = (snapshot['messages'] as List? ?? [])
          .whereType<Json>()
          .where((m) => m['id'] == widget.message['id'])
          .firstOrNull;
      final actual = current == null ? null : teamCard(current);
      final agents = (snapshot['agents'] as List? ?? [])
          .whereType<Json>()
          .map((a) => a['id'])
          .toSet();
      final group = (snapshot['conversations'] as List? ?? [])
          .whereType<Json>()
          .where((c) => c['id'] == id && c['isGroup'] == true)
          .firstOrNull;
      if (actual?['planId'] != card['planId'] ||
          actual?['result']?['conversationId'] != id ||
          group?['agentIds'] is! List ||
          (group!['agentIds'] as List).isEmpty ||
          !(group['agentIds'] as List).every(agents.contains)) {
        throw const ApiException('MISSING_CHAT', 'unavailable');
      }
      if (!mounted || order != epoch || !widget.scope.active) return;
      await Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => ChatScreen(scope: widget.scope, conversationId: id),
        ),
      );
    } catch (e) {
      if (mounted && order == epoch && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.scope,
    builder: (context, _) {
      final team = teamCard(widget.message);
      if (team == null) return const SizedBox.shrink();
      final bot = widget.scope.find('agents', widget.message['agentId']);
      final canManage = teamProposalBot(widget.scope, widget.message);
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                bot?['name'] as String? ?? '',
                style: Theme.of(context).textTheme.labelLarge,
              ),
              const SizedBox(height: 8),
              Text(
                context.tr('mobileCollaborationProposal'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text(team['title'] as String),
              Text(context.tr('mobileCollaborationState_${team['status']}')),
              SelectableText(team['goal'] as String),
              Text(team['summary'] as String),
              for (final row in team['members'] as List)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    '${row['name']}${row['key'] == team['leadKey'] ? ' · ${context.tr('lead')}' : ''}\n${row['assignment']}',
                  ),
                ),
              if (error != null) Notice(error!),
              if (busy) const LinearProgressIndicator(),
              if (canManage)
                TextButton(
                  onPressed: busy ? null : open,
                  child: Text(context.tr('mobileCollaborationReviewPlan')),
                )
              else
                const Notice('mobileCollaborationOwner'),
              if (team['status'] == 'committed' && team['result'] != null)
                TextButton(
                  onPressed: busy || !widget.scope.active ? null : openCreated,
                  child: Text(context.tr('mobileCollaborationOpen')),
                ),
            ],
          ),
        ),
      );
    },
  );
}
