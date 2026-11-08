import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/avatar_preferences.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../collaboration/proposal_access.dart';
import '../collaboration/team_data.dart';
import 'avatar_theme_preview.dart';

GeneratedAvatarTheme? avatarThemeProposal(Json message) {
  if (!isCreationProposal(message)) return null;
  final metadata = message['metadata'];
  return metadata is Json
      ? GeneratedAvatarTheme.preview(metadata['creationPreview'])
      : null;
}

class AvatarThemeCard extends StatefulWidget {
  const AvatarThemeCard({
    super.key,
    required this.scope,
    required this.message,
    required this.theme,
  });

  final WorkspaceController scope;
  final Json message;
  final GeneratedAvatarTheme theme;

  @override
  State<AvatarThemeCard> createState() => _AvatarThemeCardState();
}

class _AvatarThemeCardState extends State<AvatarThemeCard> {
  ProposalAccess? pending;
  bool failed = false;

  bool get canApply =>
      !widget.scope.session.avatarSync.writing &&
      canReviewCreation(widget.scope, widget.message);

  Future<void> _apply() async {
    if (!canApply || pending != null) return;
    final scope = widget.scope;
    final expected = copyJson(widget.message);
    final theme = widget.theme;
    final access = ProposalAccess(scope);
    setState(() {
      pending = access;
      failed = false;
    });
    try {
      final actual = await access.creation(expected);
      final actualTheme = avatarThemeProposal(actual);
      if (actualTheme == null ||
          canonical(actualTheme.toJson()) != canonical(theme.toJson())) {
        throw const ApiException('STALE_PROPOSAL', 'unavailable');
      }
      if (!mounted ||
          !access.active ||
          !identical(scope, widget.scope) ||
          canonical(widget.message) != canonical(expected)) {
        return;
      }
      await scope.session.preferences(customAvatar: theme);
    } catch (_) {
      if (mounted && access.active && identical(scope, widget.scope)) {
        setState(() => failed = true);
      }
    } finally {
      access.dispose();
      if (mounted && identical(pending, access)) {
        setState(() => pending = null);
      }
    }
  }

  @override
  void dispose() {
    pending?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.scope, widget.scope.session]),
    builder: (context, _) {
      final session = widget.scope.session;
      final theme = widget.theme;
      final workspaceTheme = session.avatarSync.effective != null;
      final applied =
          session.useCustomAvatarTheme &&
          canonical(session.customAvatarTheme?.toJson()) ==
              canonical(theme.toJson());
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                context.tr('avatarThemeProposal'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 6),
              Text(theme.name),
              const SizedBox(height: 8),
              AvatarThemePreview(family: theme.motif, generated: theme),
              if (failed) Text(context.tr('unavailable')),
              if (pending != null) const LinearProgressIndicator(),
              if (canApply && !applied)
                TextButton(
                  onPressed: pending == null ? _apply : null,
                  child: Text(
                    context.tr(
                      workspaceTheme
                          ? 'avatarThemePreviewWorkspace'
                          : 'avatarThemeApply',
                    ),
                  ),
                ),
              if (applied)
                Text(
                  context.tr(
                    workspaceTheme
                        ? (session.avatarSync.hasDraft
                              ? 'avatarThemeSyncDraft'
                              : 'avatarThemeSyncSaved')
                        : 'avatarThemeApplied',
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}
