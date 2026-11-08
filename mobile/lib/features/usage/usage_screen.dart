import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'usage_controller.dart';
import 'usage_data.dart';

class UsageScreen extends StatefulWidget {
  const UsageScreen({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<UsageScreen> createState() => _UsageScreenState();
}

class _UsageScreenState extends State<UsageScreen> {
  late final UsageController controller;
  @override
  void initState() {
    super.initState();
    controller = UsageController(widget.scope);
    unawaited(controller.refresh());
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Widget totals(Json totals) => Column(
    children: [
      for (final key in usageFields)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  context.tr('mobileWorkspaceUsage_$key'),
                  style: const TextStyle(fontSize: 14),
                ),
              ),
              const SizedBox(width: 12),
              Text(
                NumberFormat.decimalPattern(
                  Localizations.localeOf(context).languageCode,
                ).format(totals[key]),
                style: const TextStyle(fontSize: 14),
              ),
            ],
          ),
        ),
    ],
  );

  Widget breakdown(String title, List rows, String Function(Json) label) =>
      Card(
        child: ExpansionTile(
          title: Text(context.tr(title)),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            if (rows.isEmpty) const Notice('mobileWorkspaceUsageEmpty'),
            for (final row in rows.cast<Json>())
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label(row),
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    totals(row['totals'] as Json),
                  ],
                ),
              ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final c = controller, value = controller.data;
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr('mobileWorkspaceUsageTitle')),
          actions: [
            IconButton(
              tooltip: context.tr('refresh'),
              onPressed: c.loading || !c.active ? null : () => c.refresh(),
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: !c.active
            ? const Notice('scopeChanged')
            : RefreshIndicator(
                onRefresh: c.refresh,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  children: [
                    DropdownButtonFormField<int>(
                      initialValue: c.days,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileWorkspaceUsagePeriod'),
                      ),
                      items: [
                        for (final days in [7, 30, 90])
                          DropdownMenuItem(
                            value: days,
                            child: Text(
                              context.tr('mobileWorkspaceUsageDays$days'),
                            ),
                          ),
                      ],
                      onChanged: (days) {
                        if (days != null) unawaited(c.refresh(days));
                      },
                    ),
                    if (c.loading) const LinearProgressIndicator(),
                    if (c.error != null) Notice(c.error!),
                    if (value != null) ...[
                      Notice(
                        value['scope']['visibility'] == 'workspace'
                            ? 'mobileWorkspaceUsageAll'
                            : 'mobileWorkspaceUsageSelf',
                      ),
                      Text(
                        '${value['period']['since']} — ${value['period']['until']} (UTC)',
                        style: const TextStyle(fontSize: 13),
                      ),
                      const Notice('mobileWorkspaceUsageReported'),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: totals(value['totals'] as Json),
                        ),
                      ),
                      const Notice('mobileWorkspaceUsageCostUnknown'),
                      if (value['totals']['modelTurns'] == 0)
                        const Notice('mobileWorkspaceUsageEmpty'),
                      breakdown(
                        'mobileWorkspaceUsageByDay',
                        value['byDay'],
                        (r) => '${r['day']} (UTC)',
                      ),
                      breakdown(
                        'mobileWorkspaceUsageByBot',
                        value['byBot'],
                        (r) => r['agentId'] == null
                            ? context.tr('mobileWorkspaceUsageSystem')
                            : r['name'] as String? ??
                                  context.tr('mobileWorkspaceUsageDeletedBot'),
                      ),
                      breakdown(
                        'mobileWorkspaceUsageByModel',
                        value['byModel'],
                        (r) => '${r['provider']} · ${r['model']}',
                      ),
                    ],
                  ],
                ),
              ),
      );
    },
  );
}
