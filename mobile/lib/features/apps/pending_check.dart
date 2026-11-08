import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'apps_controller.dart';

class AppPendingCheck extends StatelessWidget {
  const AppPendingCheck({
    super.key,
    required this.controller,
    this.connectionId,
  });
  final AppsController controller;
  final String? connectionId;

  @override
  Widget build(BuildContext context) {
    final pending = controller.pendingFor(connectionId);
    if (pending == null) return const SizedBox();
    if (pending['kind'] == 'toolAccess') {
      return Notice(
        'mobileAppsToolUnconfirmed',
        action: 'mobileAppsRefresh',
        onAction: controller.busy
            ? null
            : () => controller.refresh(connectionId),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Notice(
          'mobileAppsUnknown',
          action: 'mobileAppsRefresh',
          onAction: controller.busy
              ? null
              : () => controller.refresh(connectionId),
        ),
        TextButton(
          onPressed: controller.canWrite
              ? () async {
                  if (await confirm(context, 'mobileAppsAbandonConfirm')) {
                    await controller.abandonLocalDraft(connectionId);
                  }
                }
              : null,
          child: Text(context.tr('mobileAppsAbandon')),
        ),
      ],
    );
  }
}
