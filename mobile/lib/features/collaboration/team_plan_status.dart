import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'team_controller.dart';

class TeamPlanStatus extends StatelessWidget {
  const TeamPlanStatus({super.key, required this.controller});
  final TeamController controller;
  @override
  Widget build(BuildContext context) {
    final saved = controller.observed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.pending != null) ...[
          const Notice('mobileCollaborationUnknown'),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: controller.busy ? null : controller.check,
                child: Text(context.tr('checkResult')),
              ),
              if (controller.canRetry)
                TextButton(
                  onPressed: controller.retry,
                  child: Text(context.tr('mobileCollaborationRetry')),
                ),
            ],
          ),
        ],
        if (saved != null)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    context.tr('mobileCollaborationCurrentSaved'),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(
                    saved['draft']?['title'] as String? ??
                        saved['goal'] as String,
                  ),
                  Text(
                    context.tr('mobileCollaborationState_${saved['status']}'),
                  ),
                  if (saved['draft'] != null) ...[
                    Text(saved['draft']['summary'] as String),
                    for (final member in saved['draft']['members'] as List)
                      Text(
                        '${member['name'] ?? controller.scope.find('agents', member['agentId'] as String? ?? '')?['name'] ?? context.tr('mobileCollaborationBotMissing')} · ${member['assignment']}',
                      ),
                  ],
                  if (!{
                    'start',
                    'startChat',
                    'cancel',
                  }.contains(controller.pending?['kind'])) ...[
                    const Notice('mobileCollaborationFenceHint'),
                    OutlinedButton(
                      onPressed: controller.busy
                          ? null
                          : () async {
                              if (await confirm(
                                    context,
                                    controller.draft == null
                                        ? 'mobileCollaborationUseSavedConfirm'
                                        : 'mobileCollaborationFenceConfirm',
                                  ) &&
                                  controller.active) {
                                await controller.continueEditing();
                              }
                            },
                      child: Text(
                        context.tr(
                          controller.pending == null
                              ? 'mobileCollaborationLoadSaved'
                              : 'mobileCollaborationContinue',
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}
