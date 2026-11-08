import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'library_avatar.dart';

class BlueprintPreview extends StatelessWidget {
  const BlueprintPreview({
    super.key,
    required this.scope,
    required this.blueprint,
    this.avatarPath,
  });
  final WorkspaceController scope;
  final Json blueprint;
  final String? avatarPath;
  @override
  Widget build(BuildContext context) {
    final p = blueprint['profile'] as Json;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LibraryAvatar(
          scope: scope,
          profile: p,
          path: avatarPath,
          expectedImage: blueprint['avatar'] != null,
        ),
        const SizedBox(height: 12),
        Text(p['name'], style: Theme.of(context).textTheme.titleLarge),
        Text(p['role']),
        const SizedBox(height: 12),
        SelectableText(p['description']),
        ExpansionTile(
          title: Text(context.tr('instructions')),
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: SelectableText(p['instructions']),
            ),
          ],
        ),
        Text(
          '${context.tr('skills')} · ${(blueprint['skills'] as List).length}',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        for (final skill in blueprint['skills'] as List)
          Card(
            child: ExpansionTile(
              title: Text(skill['name']),
              subtitle: Text(skill['description']),
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(skill['content']),
                ),
              ],
            ),
          ),
        Text(
          '${context.tr('routines')} · ${(blueprint['routines'] as List).length}',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        for (final routine in blueprint['routines'] as List)
          Card(
            child: ExpansionTile(
              title: Text(routine['title']),
              subtitle: Text(
                '${routine['schedule']} · ${routine['timeZone'] ?? 'Asia/Shanghai'} · ${context.tr(routine['enabled'] == true ? 'mobileLibraryEnabled' : 'mobileLibraryPaused')}',
              ),
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(routine['prompt']),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class RoutineInstallChoice extends StatelessWidget {
  const RoutineInstallChoice({
    super.key,
    required this.value,
    required this.enabled,
    required this.onChanged,
  });
  final String value;
  final bool enabled;
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      DropdownButtonFormField<String>(
        initialValue: value,
        isExpanded: true,
        decoration: InputDecoration(
          labelText: context.tr('mobileLibraryRoutines'),
        ),
        items: [
          for (final mode in ['pause', 'preserve'])
            DropdownMenuItem(
              value: mode,
              child: Text(context.tr('mobileLibraryRoutine_$mode')),
            ),
        ],
        onChanged: enabled
            ? (v) {
                if (v != null) onChanged(v);
              }
            : null,
      ),
      const SizedBox(height: 8),
      Text(
        context.tr(
          value == 'preserve'
              ? 'mobileLibraryPreserveWarning'
              : 'mobileLibraryPauseHint',
        ),
      ),
    ],
  );
}
