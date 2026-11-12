import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../apps/app_approval_review.dart';
import 'action_controller.dart';
import 'action_data.dart';
import 'shell_action_data.dart';
import 'shell_action_details.dart';

class ActionCard extends StatefulWidget {
  const ActionCard({
    super.key,
    required this.scope,
    required this.message,
    required this.action,
  });
  final WorkspaceController scope;
  final Json message;
  final ChatAction action;
  @override
  State<ActionCard> createState() => _ActionCardState();
}

class _ActionCardState extends State<ActionCard> {
  late final ActionController controller;
  @override
  void initState() {
    super.initState();
    controller = ActionController(
      widget.scope,
      widget.message['id'] as String,
      widget.message['conversationId'] as String,
      widget.action,
    );
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _reviewAlwaysAllow(ChatAction action) async {
    final read = controller.alwaysAllowReview(action);
    if (!controller.canDecide || read == null) return;
    final reviewed = action.fingerprint;
    if (await confirmAppApprovalRule(context, widget.scope, read) && mounted) {
      await controller.decide(true, alwaysAllowFingerprint: reviewed);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      controller,
      widget.scope,
      widget.scope.session,
    ]),
    builder: (context, _) {
      if (!controller.active) return const SizedBox.shrink();
      final action = controller.current;
      if (action == null) return const Notice('mobileChatActionMissing');
      final source = action.value['source'];
      final requester = action.value['requester'];
      final receipt = action.appApprovalReceipt;
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                context.tr(
                  action.kind == 'app'
                      ? 'mobileChatAppAction'
                      : 'mobileChatComputerAction',
                ),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 6),
              SelectableText(
                action.kind == 'computer' &&
                        const [
                          'browser_tabs',
                          'browser_select_tab',
                          'browser_close_tab',
                          'remote_shell',
                          'local_shell',
                        ].contains(action.title)
                    ? context.tr(action.title)
                    : action.title,
                style: const TextStyle(fontSize: 14),
              ),
              Text(
                context.tr(
                  isShellAction(action) && action.terminal
                      ? shellResultLabel(action.value['result']) ??
                            'mobileChatStatus_${action.status}'
                      : 'mobileChatStatus_${action.status}',
                ),
                style: const TextStyle(fontSize: 13),
              ),
              if (receipt != null)
                Text(
                  context.tr('mobileAppsRuleReceipt_$receipt'),
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              if (source is Map && source['kind'] == 'shared_bot')
                Text(
                  '${context.tr('mobileChatSharedSource')}: ${actionText(source['botName'])} · ${actionText(source['ownerName'])}',
                  style: const TextStyle(fontSize: 13),
                ),
              if (requester is Map)
                Text(
                  '${context.tr('mobileChatRequester')}: ${actionText(requester['name'] ?? requester['userId'])}',
                  style: const TextStyle(fontSize: 13),
                ),
              if (isShellAction(action))
                ShellActionDetails(
                  payload: action.value['payload'] as Json,
                  local: action.value['type'] == 'local_shell',
                  result: action.terminal ? action.value['result'] : null,
                )
              else ...[
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text(
                    context.tr('mobileChatParameters'),
                    style: const TextStyle(fontSize: 14),
                  ),
                  children: [
                    SelectableText(
                      actionText(
                        action.value[action.kind == 'app'
                            ? 'arguments'
                            : 'payload'],
                      ),
                      style: const TextStyle(fontSize: 13),
                    ),
                  ],
                ),
                if (action.value['result'] != null)
                  SelectableText(
                    actionText(action.value['result']),
                    style: const TextStyle(fontSize: 13),
                  ),
              ],
              if (action.value['error'] is String)
                Notice(actionText(action.value['error'])),
              if (controller.error != null) Notice(controller.error!),
              if (controller.uncertain && !action.terminal)
                const Notice('mobileChatDecisionUnknown'),
              if (action.status == 'pending' &&
                  !action.canDecide(widget.scope.userId, widget.scope.owner))
                const Notice('mobileChatRequesterOnly'),
              Wrap(
                spacing: 8,
                children: [
                  if (action.status == 'pending' &&
                      !controller.uncertain &&
                      action.canDecide(
                        widget.scope.userId,
                        widget.scope.owner,
                      )) ...[
                    FilledButton(
                      onPressed: controller.canApprove
                          ? () => controller.decide(true)
                          : null,
                      child: Text(context.tr('mobileChatApprove')),
                    ),
                    if (controller.alwaysAllowReview(action) != null)
                      OutlinedButton(
                        onPressed: controller.canDecide
                            ? () => _reviewAlwaysAllow(action)
                            : null,
                        child: Text(context.tr('mobileAppsRuleAlwaysAllow')),
                      ),
                    OutlinedButton(
                      onPressed: controller.canDecide
                          ? () => controller.decide(false)
                          : null,
                      child: Text(context.tr('mobileChatReject')),
                    ),
                  ],
                  TextButton(
                    onPressed: controller.busy ? null : controller.refresh,
                    child: Text(context.tr('mobileChatCheckAction')),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
}
