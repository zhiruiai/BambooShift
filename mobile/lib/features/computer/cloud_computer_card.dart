import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'cloud_computer_controller.dart';

class CloudComputerCard extends StatelessWidget {
  const CloudComputerCard({super.key, required this.controller});
  final CloudComputerController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final c = controller, state = c.status;
      if (!c.active || state?.configured == false) {
        return const SizedBox.shrink();
      }
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                context.tr('mobileCloudTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (c.loading || c.starting) const LinearProgressIndicator(),
              if (state != null) ...[
                Text(context.tr('mobileCloudState${state.state}')),
                Text(
                  context.tr(
                    state.connected
                        ? 'mobileCloudConnected'
                        : 'mobileCloudDisconnected',
                  ),
                ),
                if (state.expiresAt != null)
                  Text(
                    '${context.tr('mobileCloudExpires')} ${state.expiresAt!.toLocal()}',
                  ),
              ],
              Text(context.tr('mobileCloudDuration')),
              if (c.error != null) Notice(c.error!),
              if (c.actionError != null) Notice(c.actionError!),
              if (c.unknown) const Notice('mobileCloudUnknown'),
              if (!c.computer.scope.owner) const Notice('mobileCloudOwner'),
              if (state?.configured == true &&
                  c.computer.scope.owner &&
                  !c.canStart &&
                  !c.loading &&
                  !c.starting &&
                  !c.unknown)
                const Notice('mobileCloudBusy'),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    onPressed: c.loading || c.starting
                        ? null
                        : () => c.refresh(),
                    icon: const Icon(Icons.refresh),
                    label: Text(context.tr('mobileCloudRefresh')),
                  ),
                  if (state?.configured == true && c.computer.scope.owner)
                    FilledButton(
                      onPressed: !c.canStart
                          ? null
                          : () async {
                              if (await confirm(
                                    context,
                                    'mobileCloudConfirm',
                                  ) &&
                                  context.mounted) {
                                await c.start();
                              }
                            },
                      child: Text(
                        context.tr(
                          c.starting
                              ? 'mobileCloudStarting'
                              : 'mobileCloudStart',
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
