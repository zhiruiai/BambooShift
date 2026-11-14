import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../l10n/strings.dart';
import 'team_avatar.dart';
import '../bots/bot_form.dart';
import 'team_controller.dart';
import 'team_data.dart';

class TeamMemberEditor extends StatelessWidget {
  const TeamMemberEditor({
    super.key,
    required this.controller,
    required this.member,
  });
  final TeamController controller;
  final Json member;
  void patch(Json fields) {
    if (!controller.editable) return;
    final next = copyJson(controller.draft!);
    next['members'] = (next['members'] as List)
        .map(
          (row) => row['key'] == member['key']
              ? <String, dynamic>{...row, ...fields}
              : row,
        )
        .toList();
    controller.update(next);
  }

  @override
  Widget build(BuildContext context) {
    final draft = controller.draft!;
    final agents = controller.scope.items('agents');
    final reuse = member['kind'] == 'reuse';
    final bot = reuse
        ? agents.where((a) => a['id'] == member['agentId']).firstOrNull
        : member;
    final used = (draft['members'] as List)
        .where((m) => m['key'] != member['key'])
        .map((m) => m['agentId'])
        .toSet();
    final candidates = agents
        .where((a) => botAvailable(a) && !used.contains(a['id']))
        .toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (bot != null)
                  TeamAvatar(scope: controller.scope, profile: bot),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    bot?['name'] as String? ??
                        context.tr('mobileCollaborationBotMissing'),
                  ),
                ),
                IconButton(
                  tooltip: context.tr('mobileCollaborationRemove'),
                  onPressed:
                      controller.editable &&
                          (draft['members'] as List).length > 1
                      ? () {
                          final next = copyJson(controller.draft!);
                          next['members'] = (next['members'] as List)
                              .where((m) => m['key'] != member['key'])
                              .toList();
                          if (next['leadKey'] == member['key']) {
                            next['leadKey'] = next['members'][0]['key'];
                          }
                          controller.update(next);
                        }
                      : null,
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            if (reuse)
              DropdownButtonFormField<String>(
                key: ValueKey('${member['key']}:${member['agentId']}'),
                initialValue:
                    candidates.any((a) => a['id'] == member['agentId'])
                    ? member['agentId']
                    : null,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: context.tr('mobileCollaborationReuse'),
                ),
                items: candidates
                    .map(
                      (a) => DropdownMenuItem<String>(
                        value: a['id'],
                        child: Text(
                          '${a['name']} · ${a['role']}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: controller.editable
                    ? (id) {
                        if (id != null) patch({'agentId': id});
                      }
                    : null,
              )
            else
              ExpansionTile(
                title: Text(context.tr('mobileCollaborationNewProfile')),
                children: [
                  BotForm(
                    initial: member,
                    enabled: controller.editable,
                    family: controller.scope.session.avatarTheme,
                    modelScope: controller.scope,
                    onChanged: (profile) => patch({
                      for (final key in [
                        'name',
                        'role',
                        'description',
                        'instructions',
                        'avatar',
                        'color',
                        'avatarImageId',
                        'modelProfileId',
                      ])
                        if (profile.containsKey(key)) key: profile[key],
                    }),
                  ),
                ],
              ),
            const SizedBox(height: 12),
            TextFormField(
              initialValue: member['assignment'] as String? ?? '',
              enabled: controller.editable,
              maxLength: 2000,
              minLines: 2,
              maxLines: 6,
              decoration: InputDecoration(
                labelText: context.tr('mobileCollaborationAssignment'),
              ),
              onChanged: (value) => patch({'assignment': value}),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(context.tr('lead')),
              value: draft['leadKey'] == member['key'],
              onChanged: controller.editable
                  ? (yes) {
                      if (yes == true) {
                        controller.update({
                          ...controller.draft!,
                          'leadKey': member['key'],
                        });
                      }
                    }
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
