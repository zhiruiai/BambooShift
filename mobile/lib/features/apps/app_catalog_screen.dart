import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'add_connection.dart';
import 'app_catalog.dart';
import 'apps_controller.dart';
import 'connection_details.dart';

class AppCatalogScreen extends StatefulWidget {
  const AppCatalogScreen({super.key, required this.controller});
  final AppsController controller;

  @override
  State<AppCatalogScreen> createState() => _AppCatalogScreenState();
}

class _AppCatalogScreenState extends State<AppCatalogScreen> {
  late final providers = loadAppProviders();
  String query = '';
  String category = 'all';

  void open(Json provider) {
    final controller = widget.controller;
    if (!controller.active) return;
    final existing = findProviderConnection(provider, controller.apps);
    if (existing == null && !controller.canAdd) return;
    Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => existing == null
            ? AddConnection(
                controller: controller,
                initialProviderId: provider['id'] as String,
              )
            : ConnectionDetails(
                controller: controller,
                connectionId: existing['id'] as String,
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('mobileAppsDirectory'))),
    body: FutureBuilder(
      future: providers,
      builder: (context, snapshot) {
        if (snapshot.hasError) return const Notice('requestFailed');
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        return ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final controller = widget.controller;
            if (!controller.active) return const Notice('scopeChanged');
            String description(Json row) =>
                context.tr('mobileAppsProvider_${row['id']}');
            final words = query
                .split(RegExp(r'\s+'))
                .where((word) => word.isNotEmpty);
            final matches = snapshot.data!.where((row) {
              final matchesCategory =
                  category == 'all' ||
                  row['category'] == category ||
                  (category == 'noAuth' && row['authType'] == 'none');
              final searchable =
                  '${row['name']} ${row['url']} ${row['keywords'] ?? ''} ${description(row)}'
                      .toLowerCase();
              return matchesCategory && words.every(searchable.contains);
            });
            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                  child: TextField(
                    onChanged: (value) =>
                        setState(() => query = value.trim().toLowerCase()),
                    maxLength: 120,
                    decoration: InputDecoration(
                      labelText: context.tr('mobileAppsDirectorySearch'),
                      prefixIcon: const Icon(Icons.search),
                      counterText: '',
                    ),
                  ),
                ),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Wrap(
                      spacing: 8,
                      children: [
                        for (final value in [
                          'all',
                          'productivity',
                          'code',
                          'noAuth',
                        ])
                          ChoiceChip(
                            label: Text(
                              context.tr('mobileAppsCategory_$value'),
                            ),
                            selected: category == value,
                            showCheckmark: false,
                            onSelected: (_) => setState(() => category = value),
                          ),
                      ],
                    ),
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    children: [
                      if (matches.isEmpty)
                        const Notice('mobileAppsDirectoryEmpty'),
                      for (final row in matches)
                        Builder(
                          builder: (context) {
                            final app = findProviderConnection(
                              row,
                              controller.apps,
                            );
                            return Card(
                              child: ListTile(
                                leading: CircleAvatar(
                                  child: Text(row['mark'] as String),
                                ),
                                title: Text(row['name'] as String),
                                subtitle: Text(
                                  '${description(row)}\n${context.tr(app == null ? 'mobileAppsAuth_${row['authType']}' : 'mobileAppsStatus_${app['status']}')}',
                                ),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: app != null || controller.canAdd
                                    ? () => open(row)
                                    : null,
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        );
      },
    ),
  );
}
