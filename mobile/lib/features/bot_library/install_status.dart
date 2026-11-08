import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'library_installer.dart';
import 'library_navigation.dart';

class InstallStatus extends StatelessWidget {
  const InstallStatus({
    super.key,
    required this.installer,
    required this.onOpen,
  });
  final LibraryInstaller installer;
  final ValueChanged<LibraryOpen> onOpen;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (installer.error != null) Notice(installer.error!),
      if (installer.blocked) const Notice('mobileLibraryStorage'),
      if (installer.pending != null)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  context.tr(
                    installer.receipt == null
                        ? 'mobileLibraryUnknown'
                        : 'mobileLibraryCreated',
                  ),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: installer.busy ? null : installer.check,
                      child: Text(context.tr('checkResult')),
                    ),
                    if (installer.receipt == null && installer.canRetry)
                      TextButton(
                        onPressed: installer.retry,
                        child: Text(context.tr('mobileLibraryRetry')),
                      ),
                    if (installer.receipt != null) ...[
                      FilledButton(
                        onPressed: installer.busy
                            ? null
                            : () async {
                                final target = await installer.open();
                                if (target != null && installer.active) {
                                  onOpen(target);
                                }
                              },
                        child: Text(context.tr('mobileLibraryOpen')),
                      ),
                      TextButton(
                        onPressed: installer.busy
                            ? null
                            : () async {
                                if (await confirm(
                                      context,
                                      'mobileLibraryFinishConfirm',
                                    ) &&
                                    installer.active) {
                                  await installer.finish();
                                }
                              },
                        child: Text(context.tr('mobileLibraryFinish')),
                      ),
                    ],
                  ],
                ),
                if (installer.receipt == null && !installer.canRetry)
                  const Notice('mobileLibraryNoBody'),
              ],
            ),
          ),
        ),
    ],
  );
}
