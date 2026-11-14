import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'knowledge_screen.dart';

class BotSkillsCard extends StatelessWidget {
  const BotSkillsCard({super.key, required this.scope, required this.agentId});

  final WorkspaceController scope;
  final String agentId;

  @override
  Widget build(BuildContext context) {
    final skills = scope.items('skills').where((s) => s['agentId'] == agentId);
    final active = skills.where((s) => s['status'] == 'active').toList();
    final pending = skills.where((s) => s['status'] == 'proposed').length;
    return Card(
      child: ListTile(
        leading: const Icon(Icons.auto_awesome_outlined),
        title: Text(context.tr('skills')),
        subtitle: Text(
          [
            '${context.tr('mobileBotSkillsEnabled')}: ${active.length}',
            if (pending > 0) '${context.tr('mobileBotSkillsReview')}: $pending',
            if (active.isNotEmpty)
              active.take(3).map((s) => s['name'] as String? ?? '').join(' · '),
          ].join('\n'),
          maxLines: 4,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: !scope.active
            ? null
            : () => Navigator.push<void>(
                context,
                MaterialPageRoute(
                  builder: (_) => KnowledgeScreen(
                    scope: scope,
                    agentId: agentId,
                    kind: 'skills',
                  ),
                ),
              ),
      ),
    );
  }
}
