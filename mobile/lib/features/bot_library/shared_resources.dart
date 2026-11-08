import 'dart:convert';
import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import 'library_controller.dart';
import 'shared_file_export.dart';

class SharedResources extends StatelessWidget {
  const SharedResources({super.key, required this.controller});
  final LibraryController controller;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (controller.sharedFiles.isNotEmpty)
        Text(
          context.tr('mobileLibrarySharedFiles'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
      for (final f in controller.sharedFiles)
        Card(
          child: ListTile(
            title: Text(f['name']),
            trailing: SharedFileExport(
              scope: controller.transport.scope,
              shareId: controller.selected!['id'],
              file: f,
            ),
            subtitle: Text(
              '${f['size']} B · ${context.tr('mobileLibraryGrant_${f['status']}')}',
            ),
          ),
        ),
      if (controller.sharedApps.isNotEmpty)
        Text(
          context.tr('mobileLibrarySharedApps'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
      for (final a in controller.sharedApps)
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ListTile(
                title: Text(a['name']),
                subtitle: Text(context.tr('mobileLibraryGrant_${a['status']}')),
              ),
              for (final t in a['tools'])
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(t['name']),
                ),
              OutlinedButton(
                onPressed:
                    controller.loading ||
                        controller.locked ||
                        a['status'] != 'available'
                    ? null
                    : () => controller.inspectSharedApp(a['connectionId']),
                child: Text(context.tr('mobileLibraryInspectTools')),
              ),
            ],
          ),
        ),
      if (controller.sharedAppTools != null)
        for (final t in controller.sharedAppTools!['tools'])
          Card(
            child: ExpansionTile(
              title: Text(t['name']),
              subtitle: Text(t['description']),
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(
                    const JsonEncoder.withIndent(
                      '  ',
                    ).convert(t['inputSchema']),
                  ),
                ),
              ],
            ),
          ),
    ],
  );
}
