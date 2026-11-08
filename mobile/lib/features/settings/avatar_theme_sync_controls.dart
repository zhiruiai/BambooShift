import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

class AvatarThemeSyncControls extends StatelessWidget {
  const AvatarThemeSyncControls({super.key, required this.scope});

  final WorkspaceController scope;

  Future<void> _remove(BuildContext context) async {
    final sync = scope.session.avatarSync;
    if (!scope.active || !sync.canRemove) return;
    if (await confirm(context, 'avatarThemeSyncRemoveConfirm') &&
        context.mounted &&
        scope.active) {
      await sync.save(null);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!scope.active) return const SizedBox.shrink();
    final session = scope.session, sync = scope.session.avatarSync;
    final status =
        sync.problem ??
        (sync.hasDraft
            ? 'avatarThemeSyncDraft'
            : sync.synced
            ? 'avatarThemeSyncSaved'
            : 'avatarThemeSyncDevice');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          context.tr('avatarThemeSyncTitle'),
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 4),
        Text(context.tr('avatarThemeSyncHelp')),
        const SizedBox(height: 8),
        Semantics(liveRegion: true, child: Text(context.tr(status))),
        if (sync.busy)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: LinearProgressIndicator(),
          ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            FilledButton(
              onPressed: sync.canSave(session.avatarSelection)
                  ? () => sync.save(session.avatarSelection)
                  : null,
              child: Text(context.tr('avatarThemeSyncSave')),
            ),
            if (sync.synced)
              OutlinedButton(
                onPressed: sync.canRemove ? () => _remove(context) : null,
                child: Text(context.tr('avatarThemeSyncRemove')),
              ),
            if (sync.hasDraft)
              TextButton(
                onPressed: sync.writing ? null : sync.discard,
                child: Text(context.tr('avatarThemeSyncDiscard')),
              ),
            TextButton(
              onPressed: sync.busy ? null : sync.reload,
              child: Text(context.tr('avatarThemeSyncReload')),
            ),
          ],
        ),
      ],
    );
  }
}
