import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/avatar_preferences.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'avatar_theme_preview.dart';

class AvatarThemeGenerator extends StatefulWidget {
  const AvatarThemeGenerator({super.key, required this.scope});

  final WorkspaceController scope;

  @override
  State<AvatarThemeGenerator> createState() => _AvatarThemeGeneratorState();
}

class _AvatarThemeGeneratorState extends State<AvatarThemeGenerator> {
  final brief = TextEditingController();
  final cancellation = ByteReadCancellation();
  GeneratedAvatarTheme? draft;
  bool busy = false;
  bool failed = false;

  WorkspaceController get scope => widget.scope;
  bool get current =>
      mounted && scope.active && scope.owner && !cancellation.cancelled;

  bool get canGenerate {
    final value = brief.text.trim();
    return current &&
        !busy &&
        value.isNotEmpty &&
        value.length <= 3000 &&
        !value.contains('\x00');
  }

  @override
  void initState() {
    super.initState();
    scope.session.addListener(_identityChanged);
  }

  void _identityChanged() {
    if (current) return;
    cancellation.cancel();
    if (mounted) {
      setState(() {
        draft = null;
        busy = false;
        failed = false;
      });
    }
  }

  @override
  void dispose() {
    scope.session.removeListener(_identityChanged);
    cancellation.cancel();
    brief.dispose();
    super.dispose();
  }

  Future<void> _generate() async {
    if (!canGenerate) return;
    final value = brief.text.trim();
    setState(() {
      busy = true;
      failed = false;
      draft = null;
    });
    try {
      final response = await scope.session.api.requestValue(
        'POST',
        scope.path('/creation-preview'),
        body: {
          'kind': 'theme',
          'brief': value,
          'language': scope.session.api.language,
        },
        expectedUser: scope.userId,
        cancellation: cancellation,
        isCurrent: () => current,
        timeout: const Duration(seconds: 75),
      );
      if (!current) return;
      final parsed = GeneratedAvatarTheme.preview(response);
      if (parsed == null) {
        throw const ApiException('INVALID_CREATION_PREVIEW', 'requestFailed');
      }
      setState(() => draft = parsed);
    } catch (_) {
      if (current) setState(() => failed = true);
    } finally {
      if (current) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final proposal = draft;
    return AlertDialog(
      title: Text(context.tr('avatarThemeDesign')),
      scrollable: true,
      content: SizedBox(
        width: 360,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              context.tr(
                scope.session.avatarSync.effective == null
                    ? 'avatarThemeDesignHelp'
                    : 'avatarThemeDesignWorkspaceHelp',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: brief,
              maxLength: 3000,
              minLines: 2,
              maxLines: 5,
              enabled: current && !busy,
              onChanged: (_) => setState(() {
                draft = null;
                failed = false;
              }),
              decoration: InputDecoration(
                labelText: context.tr('avatarThemeBrief'),
              ),
            ),
            if (busy) const LinearProgressIndicator(),
            if (failed) Text(context.tr('avatarThemeFailed')),
            if (proposal != null) ...[
              const SizedBox(height: 12),
              AvatarThemePreview(family: proposal.motif, generated: proposal),
              const SizedBox(height: 4),
              Text(proposal.name, textAlign: TextAlign.center),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(context.tr('cancel')),
        ),
        OutlinedButton(
          onPressed: canGenerate ? _generate : null,
          child: Text(context.tr('avatarThemeGenerate')),
        ),
        if (proposal != null)
          FilledButton(
            onPressed: current && !busy
                ? () {
                    if (current) Navigator.pop(context, proposal);
                  }
                : null,
            child: Text(
              context.tr(
                scope.session.avatarSync.effective == null
                    ? 'avatarThemeApply'
                    : 'avatarThemePreviewWorkspace',
              ),
            ),
          ),
      ],
    );
  }
}
