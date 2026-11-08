import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'app_approval_data.dart';

class AppApprovalScopeDetails extends StatelessWidget {
  const AppApprovalScopeDetails({super.key, required this.read});
  final ExactAppRead read;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final (label, value) in [
        ('mobileAppsRuleBot', read.agentName),
        ('mobileAppsRuleConversation', read.conversationTitle),
        ('mobileAppsRuleTool', '${read.connectionName} · ${read.toolName}'),
        (
          'mobileAppsRuleInput',
          '${read.method} · ${read.repository} #${read.issueNumber}',
        ),
      ]) ...[
        Text(context.tr(label), style: Theme.of(context).textTheme.labelMedium),
        Text(value, style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 8),
      ],
    ],
  );
}

Future<bool> confirmAppApprovalRule(
  BuildContext context,
  WorkspaceController scope,
  ExactAppRead read, {
  bool revoke = false,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => ListenableBuilder(
        listenable: Listenable.merge([scope, scope.session]),
        builder: (context, _) {
          final allowed = scope.personalOwner;
          return AlertDialog(
            scrollable: true,
            title: Text(
              context.tr(
                revoke ? 'mobileAppsRuleRevoke' : 'mobileAppsRuleConfirm',
              ),
            ),
            content: allowed
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      AppApprovalScopeDetails(read: read),
                      Text(
                        context.tr(
                          revoke
                              ? 'mobileAppsRuleRevokeHelp'
                              : 'mobileAppsRuleScopeHelp',
                        ),
                      ),
                    ],
                  )
                : Text(context.tr('scopeChanged')),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: Text(context.tr('cancel')),
              ),
              FilledButton(
                onPressed: allowed ? () => Navigator.pop(context, true) : null,
                child: Text(
                  context.tr(
                    revoke ? 'mobileAppsRuleRevoke' : 'mobileAppsRuleSave',
                  ),
                ),
              ),
            ],
          );
        },
      ),
    ) ??
    false;
