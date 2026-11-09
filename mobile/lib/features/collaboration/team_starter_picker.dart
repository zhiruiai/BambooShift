import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'team_controller.dart';

Future<Json?> pickTeamStarter(
  BuildContext context,
  TeamController controller,
  String language,
) => showDialog<Json>(
  context: context,
  builder: (_) =>
      _TeamStarterDialog(controller: controller, language: language),
);

class _TeamStarterDialog extends StatefulWidget {
  const _TeamStarterDialog({required this.controller, required this.language});

  final TeamController controller;
  final String language;

  @override
  State<_TeamStarterDialog> createState() => _TeamStarterDialogState();
}

class _TeamStarterDialogState extends State<_TeamStarterDialog> {
  late final Future<List<Json>> templates = widget.controller.starterTemplates(
    widget.language,
  );

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return AlertDialog(
      title: Text(context.tr('mobileTeamStarterTitle')),
      content: SizedBox(
        width: 440,
        child: ListenableBuilder(
          listenable: controller,
          builder: (context, _) => !controller.active
              ? const Notice('scopeChanged')
              : controller.starterLanguage != widget.language
              ? const Notice('mobileTeamStarterLocaleChanged')
              : FutureBuilder<List<Json>>(
                  future: templates,
                  builder: (context, snapshot) {
                    if (snapshot.hasError) return const Notice('requestFailed');
                    final rows = snapshot.data;
                    if (rows == null) return const LinearProgressIndicator();
                    return SingleChildScrollView(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(context.tr('mobileTeamStarterHelp')),
                          for (final row in rows)
                            ExpansionTile(
                              key: ValueKey(row['id']),
                              tilePadding: EdgeInsets.zero,
                              leading: Icon(switch (row['id']) {
                                'launch' => Icons.rocket_launch_outlined,
                                'close' => Icons.calculate_outlined,
                                'support' => Icons.headset_mic_outlined,
                                'study' => Icons.auto_stories_outlined,
                                'creator' => Icons.video_library_outlined,
                                'office' => Icons.fact_check_outlined,
                                _ => Icons.group_outlined,
                              }),
                              title: Text(row['draft']['title'] as String),
                              subtitle: Text(row['draft']['summary'] as String),
                              children: [
                                for (final member
                                    in row['draft']['members'] as List)
                                  ListTile(
                                    title: Text(member['name'] as String),
                                    subtitle: Text(
                                      member['assignment'] as String,
                                    ),
                                  ),
                                FilledButton(
                                  onPressed: () {
                                    if (controller.active &&
                                        controller.starterLanguage ==
                                            widget.language) {
                                      Navigator.pop(context, row);
                                    }
                                  },
                                  child: Text(
                                    context.tr('mobileTeamStarterUse'),
                                  ),
                                ),
                              ],
                            ),
                        ],
                      ),
                    );
                  },
                ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(context.tr('cancel')),
        ),
      ],
    );
  }
}
