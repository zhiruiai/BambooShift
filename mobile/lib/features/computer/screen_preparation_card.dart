import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'screen_preparation_controller.dart';

class ScreenPreparationCard extends StatelessWidget {
  const ScreenPreparationCard({super.key, required this.controller});
  final ScreenPreparationController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final p = controller, c = p.computer;
      if (!p.active ||
          (c.status?.status != 'unassigned' && !p.unknown && p.error == null)) {
        return const SizedBox.shrink();
      }
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                context.tr('mobilePrepareTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text(
                context.tr(
                  c.scope.owner ? 'mobilePrepareOwner' : 'mobilePrepareMember',
                ),
              ),
              if (c.capacity?['assigned'] is int &&
                  c.capacity?['configured'] is int)
                Text(
                  '${context.tr('mobilePrepareCapacity')} ${c.capacity!['assigned']} / ${c.capacity!['configured']}',
                ),
              if (c.inventoryReason?.isNotEmpty == true)
                Notice(c.inventoryReason!),
              if (p.preparing) const LinearProgressIndicator(),
              if (p.error != null) Notice(p.error!),
              if (p.unknown) const Notice('mobilePrepareUnknown'),
              if (!p.hasCapacity && !p.preparing && !p.unknown)
                const Notice('mobilePrepareNoCapacity'),
              if (c.scope.owner)
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      onPressed: c.busy ? null : p.refresh,
                      icon: const Icon(Icons.refresh),
                      label: Text(context.tr('mobileComputerRefresh')),
                    ),
                    FilledButton(
                      onPressed: !p.canPrepare
                          ? null
                          : () async {
                              if (await confirm(
                                    context,
                                    'mobilePrepareConfirm',
                                  ) &&
                                  context.mounted) {
                                await p.prepare();
                              }
                            },
                      child: Text(
                        context.tr(
                          p.preparing
                              ? 'mobilePrepareWorking'
                              : 'mobilePrepareAction',
                        ),
                      ),
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
