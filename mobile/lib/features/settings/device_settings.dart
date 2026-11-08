import 'package:flutter/material.dart';

import '../../core/app_session.dart';
import '../../core/avatar_preferences.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../auth/server_screen.dart';
import 'account_settings.dart';
import 'avatar_theme_generator.dart';
import 'avatar_theme_picker.dart';
import 'avatar_theme_sync_controls.dart';

class DeviceSettings extends StatelessWidget {
  const DeviceSettings({super.key, required this.session, this.scope});
  final AppSession session;
  final WorkspaceController? scope;

  Future<void> _designAvatar(
    BuildContext context,
    WorkspaceController active,
  ) async {
    if (!active.active || !active.owner) return;
    final proposal = await showDialog<GeneratedAvatarTheme>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AvatarThemeGenerator(scope: active),
    );
    if (context.mounted && active.active && active.owner && proposal != null) {
      await session.preferences(customAvatar: proposal);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: Listenable.merge([session, scope]),
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: Text(context.tr('settings'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (session.user != null)
            Card(
              child: ListTile(
                title: Text(session.user!['name'] as String? ?? ''),
                subtitle: Text(session.user!['email'] as String? ?? ''),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => AccountSettings(session: session),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 12),
          Text(
            context.tr('appearance'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<ThemeMode>(
            initialValue: session.theme,
            decoration: InputDecoration(labelText: context.tr('appearance')),
            items: ThemeMode.values
                .map(
                  (v) => DropdownMenuItem(
                    value: v,
                    child: Text(context.tr(v.name)),
                  ),
                )
                .toList(),
            onChanged: (v) {
              if (v != null) session.preferences(mode: v);
            },
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            initialValue: session.locale.languageCode,
            decoration: InputDecoration(labelText: context.tr('language')),
            items: const [
              DropdownMenuItem(value: 'zh', child: Text('中文')),
              DropdownMenuItem(value: 'en', child: Text('English')),
            ],
            onChanged: (v) {
              if (v != null) session.preferences(language: Locale(v));
            },
          ),
          const SizedBox(height: 16),
          AvatarThemePicker(
            selected: session.avatarTheme,
            generated: session.customAvatarTheme,
            generatedSelected: session.useCustomAvatarTheme,
            onChanged: session.avatarSync.writing
                ? null
                : (family) => session.preferences(avatars: family),
            onSelectGenerated: session.avatarSync.writing
                ? null
                : () => session.preferences(useCustomAvatar: true),
          ),
          if (scope case final WorkspaceController active
              when active.active && active.owner) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed:
                  active.data?['settings']?['configured'] == true &&
                      !session.avatarSync.writing
                  ? () => _designAvatar(context, active)
                  : null,
              icon: const Icon(Icons.auto_awesome_outlined),
              label: Text(context.tr('avatarThemeDesign')),
            ),
            if (active.data?['settings']?['configured'] != true)
              Text(context.tr('modelMissing')),
          ],
          if (scope case final WorkspaceController active
              when active.active) ...[
            const SizedBox(height: 12),
            AvatarThemeSyncControls(scope: active),
          ],
          const SizedBox(height: 12),
          Text(
            context.tr(
              scope?.active == true ? 'avatarThemeDeviceOnly' : 'deviceOnly',
            ),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 24),
          Card(
            child: ListTile(
              title: Text(context.tr('server')),
              subtitle: Text(session.api.server?.origin ?? ''),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) =>
                      ServerScreen(session: session, canClose: true),
                ),
              ),
            ),
          ),
          if (session.error != null) Notice(session.error!),
          if (session.user != null)
            Padding(
              padding: const EdgeInsets.only(top: 20),
              child: OutlinedButton.icon(
                onPressed: session.busy
                    ? null
                    : () async {
                        if (await confirm(context, 'signOutConfirm')) {
                          await session.signOut();
                        }
                      },
                icon: const Icon(Icons.logout),
                label: Text(context.tr('signOut')),
              ),
            ),
        ],
      ),
    ),
  );
}
