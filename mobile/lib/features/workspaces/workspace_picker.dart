import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/app_session.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../settings/device_settings.dart';

class WorkspacePicker extends StatelessWidget {
  const WorkspacePicker({super.key, required this.session});
  final AppSession session;
  Future<void> _join(BuildContext context) async {
    final input = TextEditingController();
    final token = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(context.tr('joinTeam')),
        content: TextField(
          controller: input,
          autocorrect: false,
          decoration: InputDecoration(labelText: context.tr('invitation')),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(context.tr('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, input.text.trim()),
            child: Text(context.tr('join')),
          ),
        ],
      ),
    );
    input.dispose();
    if (token == null || !context.mounted) return;
    final parsed = Uri.tryParse(token);
    final raw = parsed != null && parsed.hasScheme
        ? parsed.pathSegments.lastOrNull
        : token;
    if (raw == null || !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(raw)) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(context.tr('requestFailed'))));
      return;
    }
    final actor = session.userId;
    final stamp = session.api.generation;
    try {
      final preview = await session.api.request('GET', '/api/invitations/$raw');
      session.api.guard(stamp);
      if (!context.mounted || session.userId != actor) return;
      if (preview['available'] != true) {
        throw const ApiException('UNAVAILABLE', 'unavailable');
      }
      final approved = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(context.tr('joinTeam')),
          content: Text(preview['workspaceName'] as String? ?? ''),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(context.tr('cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(context.tr('join')),
            ),
          ],
        ),
      );
      if (approved != true ||
          session.userId != actor ||
          session.api.generation != stamp) {
        return;
      }
      await session.api.request(
        'POST',
        '/api/invitations/$raw/accept',
        expectedUser: actor,
      );
      await session.refresh();
    } catch (e) {
      if (context.mounted && session.api.generation == stamp) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              context.tr(e is ApiException ? e.message : 'requestFailed'),
            ),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(context.tr('chooseWorkspace')),
      actions: [
        IconButton(
          tooltip: context.tr('settings'),
          onPressed: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => DeviceSettings(session: session),
            ),
          ),
          icon: const Icon(Icons.settings_outlined),
        ),
      ],
    ),
    body: RefreshIndicator(
      onRefresh: session.refresh,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            session.user?['name'] as String? ?? '',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 4),
          Text(session.user?['email'] as String? ?? ''),
          const SizedBox(height: 24),
          if (session.error != null) Notice(session.error!),
          for (final space in session.workspaces)
            Card(
              child: ListTile(
                contentPadding: const EdgeInsets.all(16),
                leading: CircleAvatar(
                  backgroundColor: Theme.of(
                    context,
                  ).colorScheme.secondaryContainer,
                  child: Icon(
                    space['kind'] == 'team'
                        ? Icons.group_outlined
                        : Icons.person_outline,
                  ),
                ),
                title: Text(space['name'] as String? ?? ''),
                subtitle: Text(
                  '${context.tr(space['kind'] == 'team' ? 'teamSpace' : 'personalSpace')} · ${context.tr(space['role'] as String? ?? 'member')}',
                ),
                trailing: space['status'] == 'active'
                    ? const Icon(Icons.chevron_right)
                    : Text(context.tr('suspended')),
                onTap: space['status'] == 'active'
                    ? () => session.selectWorkspace(space)
                    : null,
              ),
            ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => _join(context),
            icon: const Icon(Icons.person_add_outlined),
            label: Text(context.tr('joinTeam')),
          ),
        ],
      ),
    ),
  );
}
