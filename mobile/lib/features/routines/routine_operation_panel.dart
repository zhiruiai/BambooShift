import 'package:flutter/material.dart';

import '../../core/routine_operation_controller.dart';
import '../../core/routine_public_search.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class RoutineOperationPanel extends StatelessWidget {
  const RoutineOperationPanel({
    super.key,
    required this.controller,
    this.onFinished,
    this.onHistory,
  });
  final RoutineOperationController controller;
  final VoidCallback? onFinished;
  final Future<void> Function(String)? onHistory;

  @override
  Widget build(BuildContext context) {
    final receipt = controller.receipt;
    final pending = controller.pending;
    final body = pending?['body'];
    final config = body == null
        ? null
        : body['kind'] == 'create'
        ? body
        : body['expectedRoutine'];
    final phrases = config is Map
        ? normalizeRoutinePublicQueries(config[routinePublicSearchField])
        : null;
    final enabled =
        !controller.busy && controller.active && controller.scope.owner;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.error != null) Notice(controller.error!),
        if (pending != null) ...[
          if (config is Map)
            ExpansionTile(
              title: Text(context.tr('routineSubmittedContent')),
              subtitle: Text(config['title'] as String? ?? ''),
              children: [
                SelectableText(config['prompt'] as String? ?? ''),
                Text(
                  '${config['schedule'] ?? ''} · ${config['timeZone'] ?? 'Asia/Shanghai'}',
                ),
                if (phrases?.isNotEmpty == true) ...[
                  Text(context.tr('routinePublicSearchApproved')),
                  SelectableText(phrases!.join('\n')),
                ],
              ],
            ),
          Notice(
            receipt == null
                ? 'pendingRoutineOperation'
                : receipt['status'] == 'missing'
                ? 'routineResultMissing'
                : receipt['kind'] == 'create'
                ? 'routineCreated'
                : 'routineReceipt_${receipt['status']}',
          ),
          if (receipt == null) Text(context.tr('routineCloseHelp')),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: enabled ? controller.check : null,
                child: Text(context.tr('checkResult')),
              ),
              if (receipt == null)
                TextButton(
                  onPressed: enabled
                      ? () async {
                          if (await confirm(context, 'routineCloseHelp')) {
                            await controller.cancel();
                          }
                        }
                      : null,
                  child: Text(context.tr('endRoutineCheck')),
                ),
              if (receipt != null &&
                  receipt['kind'] == 'run' &&
                  onHistory != null)
                TextButton(
                  onPressed: enabled
                      ? () => onHistory!(receipt['routineId'] as String)
                      : null,
                  child: Text(context.tr('runHistory')),
                ),
              if (receipt != null)
                TextButton(
                  onPressed: enabled
                      ? () async {
                          if (await controller.finish()) {
                            await controller.scope.refresh();
                            if (context.mounted && controller.active) {
                              onFinished?.call();
                            }
                          }
                        }
                      : null,
                  child: Text(context.tr('done')),
                ),
            ],
          ),
        ],
      ],
    );
  }
}
