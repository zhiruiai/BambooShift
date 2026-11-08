import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/request_ids.dart';
import '../../l10n/strings.dart';
import 'team_avatar.dart';
import 'team_controller.dart';
import 'team_member_editor.dart';

class TeamEditor extends StatelessWidget {
  const TeamEditor({super.key, required this.controller});
  final TeamController controller;
  void add(bool reuse) {
    if (!controller.editable) return;
    final draft = controller.draft!, members = draft['members'] as List;
    if (members.length >= 6) return;
    final used = members.map((m) => m['agentId']).toSet();
    final bot = controller.scope
        .items('agents')
        .where((a) => botAvailable(a) && !used.contains(a['id']))
        .firstOrNull;
    if (reuse && bot == null) return;
    final row = <String, dynamic>{
      'key': requestId(),
      'kind': reuse ? 'reuse' : 'create',
      'assignment': '',
      if (reuse)
        'agentId': bot!['id']
      else ...{
        'name': '',
        'role': '',
        'description': '',
        'instructions': '',
        'color': '#76568d',
        'avatar': 'orb',
      },
    };
    controller.update({
      ...draft,
      'members': [...members, row],
    });
  }

  @override
  Widget build(BuildContext context) {
    final draft = controller.draft!, members = draft['members'] as List;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextFormField(
          initialValue: draft['title'],
          enabled: controller.editable,
          maxLength: 100,
          decoration: InputDecoration(labelText: context.tr('groupName')),
          onChanged: (value) =>
              controller.update({...controller.draft!, 'title': value}),
        ),
        TextFormField(
          initialValue: draft['summary'],
          enabled: controller.editable,
          maxLength: 2000,
          minLines: 2,
          maxLines: 6,
          decoration: InputDecoration(
            labelText: context.tr('mobileCollaborationSummary'),
          ),
          onChanged: (value) =>
              controller.update({...controller.draft!, 'summary': value}),
        ),
        Text('${members.length}/6 · ${context.tr('mobileCollaborationCount')}'),
        for (final member in members)
          TeamMemberEditor(
            key: ValueKey('${controller.editorVersion}:${member['key']}'),
            controller: controller,
            member: member as Json,
          ),
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton(
              onPressed: controller.editable && members.length < 6
                  ? () => add(true)
                  : null,
              child: Text(context.tr('mobileCollaborationAddExisting')),
            ),
            OutlinedButton(
              onPressed: controller.editable && members.length < 6
                  ? () => add(false)
                  : null,
              child: Text(context.tr('mobileCollaborationAddNew')),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text(context.tr('mobileCollaborationReviewHint')),
        TextButton(
          onPressed:
              controller.editable && members.any((m) => m['kind'] == 'reuse')
              ? controller.reviewBots
              : null,
          child: Text(context.tr('mobileCollaborationReview')),
        ),
        if (controller.review != null) ...[
          for (final item
              in (controller.review!['members'] as List).whereType<Json>())
            _ReviewedBot(item: item, controller: controller),
          OutlinedButton(
            onPressed: controller.editable ? controller.acceptReview : null,
            child: Text(context.tr('mobileCollaborationAcceptReview')),
          ),
        ],
      ],
    );
  }
}

class _ReviewedBot extends StatelessWidget {
  const _ReviewedBot({required this.item, required this.controller});
  final Json item;
  final TeamController controller;
  @override
  Widget build(BuildContext context) {
    final profile = item['profile'] as Json;
    return Card(
      child: ExpansionTile(
        leading: TeamAvatar(scope: controller.scope, profile: profile),
        title: Text(profile['name'] as String),
        subtitle: Text(
          '${profile['role']} · ${context.tr('mobileCollaborationReview_${item['state']}')}',
        ),
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(context.tr('description')),
                SelectableText(profile['description'] as String),
                const SizedBox(height: 12),
                Text(context.tr('instructions')),
                SelectableText(profile['instructions'] as String),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
