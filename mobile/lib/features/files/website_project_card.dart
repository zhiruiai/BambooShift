import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'website_project_client.dart';
import 'website_project_data.dart';
import 'website_project_screen.dart';

export 'website_project_data.dart' show websiteProjectFor;

class WebsiteProjectCard extends StatelessWidget {
  const WebsiteProjectCard({
    super.key,
    required this.scope,
    required this.message,
    this.onDiscuss,
  });
  final WorkspaceController scope;
  final Json message;
  final VoidCallback? onDiscuss;

  @override
  Widget build(BuildContext context) {
    final project = websiteProjectFor(message);
    if (project == null) return const SizedBox.shrink();
    final client = WebsiteProjectClient(scope, message);
    return Card(
      child: ListTile(
        leading: const Icon(Icons.language_outlined),
        title: Text(
          project.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        subtitle: Text(
          '${context.tr('mobileWebsiteProject')} · ${websiteFileCount(context, project)}',
          style: const TextStyle(fontSize: 12),
        ),
        trailing: IconButton(
          onPressed: client.active ? () => _open(context, client) : null,
          icon: const Icon(Icons.chevron_right),
          tooltip: context.tr('mobileWebsiteOpen'),
        ),
        onTap: client.active ? () => _open(context, client) : null,
      ),
    );
  }

  void _open(BuildContext context, WebsiteProjectClient client) {
    if (!client.active) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            WebsiteProjectScreen(client: client, onDiscuss: onDiscuss),
      ),
    );
  }
}

class WebsiteProjectLibrary extends StatelessWidget {
  const WebsiteProjectLibrary({
    super.key,
    required this.scope,
    required this.messages,
  });
  final WorkspaceController scope;
  final Iterable<Json> messages;

  @override
  Widget build(BuildContext context) {
    final latest = latestWebsiteProjects(messages);
    if (latest.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(
            context.tr('mobileWebsiteLibrary'),
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
        ),
        for (final message in latest)
          WebsiteProjectCard(
            key: ValueKey(message['id']),
            scope: scope,
            message: message,
          ),
      ],
    );
  }
}
