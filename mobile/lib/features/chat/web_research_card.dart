import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'chat_link_launcher.dart';
import 'web_research_data.dart';

class WebResearchCard extends StatelessWidget {
  const WebResearchCard({
    super.key,
    required this.scope,
    required this.message,
    required this.research,
    this.launcher,
  });

  final WorkspaceController scope;
  final Json message;
  final WebResearch research;
  final Future<bool> Function(Uri)? launcher;

  bool _isCurrent(WebResearchSource source) {
    if (!scope.active ||
        scope.find('conversations', message['conversationId'] as String) ==
            null) {
      return false;
    }
    final current = scope.find('messages', message['id'] as String);
    return current != null &&
        current['conversationId'] == message['conversationId'] &&
        chatThreadRoot(current) == chatThreadRoot(message) &&
        WebResearch.fromMessage(current)?.sources.contains(source) == true;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: scope.session,
    builder: (context, _) {
      if (!scope.active) return const SizedBox.shrink();
      final theme = Theme.of(context);
      final summary = [
        'Exa',
        if (research.searches > 0)
          '${context.tr('chatResearchSearches')} ${research.searches}',
        if (research.cachedSearches > 0)
          '${context.tr('chatResearchCached')} ${research.cachedSearches}',
        if (research.emptySearches > 0)
          '${context.tr('chatResearchNoResults')} ${research.emptySearches}',
        if (research.pagesRead > 0)
          '${context.tr('chatResearchPages')} ${research.pagesRead}',
      ].join(' · ');
      final issue = research.issues.firstOrNull;
      return Card(
        clipBehavior: Clip.antiAlias,
        child: ExpansionTile(
          leading: const Icon(Icons.travel_explore_outlined, size: 22),
          title: Text(
            context.tr('chatResearchTitle'),
            style: theme.textTheme.titleSmall,
          ),
          subtitle: Text(
            issue == null
                ? summary
                : '$summary\n${context.tr('chatResearchIssue_$issue')}',
            style: theme.textTheme.bodySmall,
          ),
          tilePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
          expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final issue in research.issues.skip(1))
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                  context.tr('chatResearchIssue_$issue'),
                  style: theme.textTheme.bodySmall,
                ),
              ),
            if (research.sources.isEmpty)
              Text(
                context.tr('chatResearchNoSources'),
                style: theme.textTheme.bodySmall,
              )
            else ...[
              Text(
                context.tr('chatResearchSources'),
                style: theme.textTheme.titleSmall,
              ),
              for (final source in research.sources)
                Semantics(
                  link: true,
                  child: ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    trailing: const Icon(Icons.open_in_new, size: 18),
                    title: Text(
                      source.title,
                      style: theme.textTheme.bodyMedium,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      '${context.tr(source.page ? 'chatResearchPage' : 'chatResearchResult')} · ${source.uri.host}',
                      style: theme.textTheme.bodySmall,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    onTap: () => openChatLink(
                      context,
                      source.uri.toString(),
                      isCurrent: () => _isCurrent(source),
                      launcher: launcher,
                    ),
                  ),
                ),
            ],
          ],
        ),
      );
    },
  );
}
