import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'blueprint_preview.dart';
import 'template_manager.dart';

class TemplateOperationStatus extends StatelessWidget {
  const TemplateOperationStatus({super.key, required this.manager});
  final TemplateManager manager;
  @override
  Widget build(BuildContext context) {
    final op = manager.operation;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (op.error != null) Notice(op.error!),
        if (op.pending != null)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    context.tr(
                      op.result == null
                          ? 'mobileLibraryUnknown'
                          : 'mobileLibraryTemplateApplied',
                    ),
                  ),
                  if (op.result != null) ...[
                    if (op.result!['projectionPending'] == true)
                      const Notice('mobileLibraryProjectionPending'),
                    BlueprintPreview(
                      scope: manager.transport.scope,
                      blueprint: op.result!['blueprint'],
                      avatarPath: op.result!['avatarPath'],
                    ),
                    if (op.result!['publication'] != null)
                      SelectableText(
                        '${op.result!['publication']['audience']} · ${op.result!['publication']['path']}',
                      ),
                  ],
                  Wrap(
                    spacing: 8,
                    children: [
                      OutlinedButton(
                        onPressed: op.busy ? null : op.check,
                        child: Text(context.tr('checkResult')),
                      ),
                      if (op.result == null && op.body != null)
                        TextButton(
                          onPressed: op.busy ? null : op.retry,
                          child: Text(context.tr('mobileLibraryRetry')),
                        ),
                      if (op.result?['projectionPending'] == true)
                        OutlinedButton(
                          onPressed: op.busy ? null : op.sync,
                          child: Text(context.tr('mobileLibraryRepairCard')),
                        ),
                      if (op.result != null &&
                          op.result!['projectionPending'] != true)
                        FilledButton(
                          onPressed: op.busy
                              ? null
                              : () async {
                                  if (await confirm(
                                        context,
                                        'mobileLibraryFinishConfirm',
                                      ) &&
                                      manager.active) {
                                    await manager.finish();
                                  }
                                },
                          child: Text(context.tr('mobileLibraryFinish')),
                        ),
                    ],
                  ),
                  if (op.result == null && op.body == null)
                    const Notice('mobileLibraryNoBody'),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
