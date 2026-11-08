import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../apps/connections_list.dart';
import '../bots/memory_import_screen.dart';
import '../usage/usage_screen.dart';
import '../updates/updates_screen.dart';
import 'device_settings.dart';
import 'model_settings.dart';
import 'team_settings.dart';
import 'team_skill_policy_screen.dart';
import 'primary_settings.dart';
import 'time_zone_settings.dart';

class WorkspaceSettings extends StatelessWidget {
  const WorkspaceSettings({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Card(
        child: ListTile(
          leading: const Icon(Icons.bar_chart),
          title: Text(context.tr('mobileWorkspaceUsageTitle')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(builder: (_) => UsageScreen(scope: scope)),
          ),
        ),
      ),
      if (scope.owner && scope.session.workspace?['kind'] == 'personal')
        Card(
          child: ListTile(
            leading: const Icon(Icons.psychology_outlined),
            title: Text(context.tr('mobileKnowledgeImport')),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => MemoryImportScreen(scope: scope),
              ),
            ),
          ),
        ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.extension_outlined),
          title: Text(context.tr('mobileAppsTitle')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => ConnectionsList(scope: scope),
            ),
          ),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.tune),
          title: Text(context.tr('model')),
          subtitle: Text(
            context.tr(
              scope.data?['settings']?['configured'] == true
                  ? 'modelConfigured'
                  : 'modelMissing',
            ),
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => ModelSettings(scope: scope),
            ),
          ),
        ),
      ),
      if (scope.session.workspace?['kind'] == 'team')
        Card(
          child: ListTile(
            leading: const Icon(Icons.people_outline),
            title: Text(context.tr('members')),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => TeamSettings(scope: scope),
              ),
            ),
          ),
        ),
      if (scope.session.workspace?['kind'] == 'team' && scope.owner)
        Card(
          child: ListTile(
            leading: const Icon(Icons.rule_outlined),
            title: Text(context.tr('mobileTeamSkillPolicyTitle')),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              if (!scope.active || !scope.owner) return;
              Navigator.push<void>(
                context,
                MaterialPageRoute(
                  builder: (_) => TeamSkillPolicyScreen(scope: scope),
                ),
              );
            },
          ),
        ),
      if (scope.session.workspace?['kind'] == 'personal')
        Card(
          child: ListTile(
            leading: const Icon(Icons.star_outline),
            title: Text(context.tr('primaryBot')),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => PrimarySettings(scope: scope),
              ),
            ),
          ),
        ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.schedule),
          title: Text(context.tr('timeZone')),
          subtitle: Text(
            scope.data?['workspaceTimeZone']?['timeZone'] as String? ?? '',
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => TimeZoneSettings(scope: scope),
            ),
          ),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.palette_outlined),
          title: Text(context.tr('appearance')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) =>
                  DeviceSettings(session: scope.session, scope: scope),
            ),
          ),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.system_update_alt),
          title: Text(context.tr('mobileUpdatesTitle')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute<void>(
              builder: (_) => UpdatesScreen(scope: scope),
            ),
          ),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.space_dashboard_outlined),
          title: Text(context.tr('chooseWorkspace')),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => scope.session.selectWorkspace(null),
        ),
      ),
    ],
  );
}
