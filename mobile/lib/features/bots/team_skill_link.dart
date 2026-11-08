import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';

bool isTeamSkillLinkId(Object? value) =>
    isRequestId(value) && (value as String) == value.toLowerCase();

Uri? teamSkillAddress(
  WorkspaceController scope,
  Object? teamId,
  Object? publicationId,
  Object? linkId,
) {
  if (!scope.active ||
      !isTeamSkillLinkId(teamId) ||
      !isTeamSkillLinkId(publicationId) ||
      !isTeamSkillLinkId(linkId)) {
    return null;
  }
  final server = scope.session.api.server;
  if (server == null) return null;
  return Uri.parse(server.origin).replace(
    pathSegments: [
      'team-skills',
      teamId as String,
      publicationId as String,
      linkId as String,
    ],
  );
}

class TeamSkillLinkButton extends StatelessWidget {
  const TeamSkillLinkButton({
    super.key,
    required this.scope,
    required this.teamId,
    required this.publicationId,
    required this.linkId,
    this.enabled = true,
  });

  final WorkspaceController scope;
  final Object? teamId, publicationId, linkId;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final uri = teamSkillAddress(scope, teamId, publicationId, linkId);
    if (uri == null) return const SizedBox.shrink();
    return TextButton.icon(
      onPressed: enabled ? () => _copy(context, uri) : null,
      icon: const Icon(Icons.link),
      label: Text(context.tr('mobileTeamSkillCopyLink')),
    );
  }

  Future<void> _copy(BuildContext context, Uri uri) async {
    if (teamSkillAddress(scope, teamId, publicationId, linkId) != uri) return;
    var message = 'copied';
    try {
      await Clipboard.setData(ClipboardData(text: uri.toString()));
    } catch (_) {
      message = 'requestFailed';
    }
    if (context.mounted && scope.active) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(context.tr(message))));
    }
  }
}
