import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';

typedef ChatSkill = ({
  String id,
  String agentId,
  String agentName,
  String name,
  int version,
});

List<ChatSkill> chatSkills(
  WorkspaceController scope,
  Json? conversation,
  ChatDraftOptions options,
) {
  final members = conversation?['agentIds'];
  if (!scope.active ||
      conversation?['demo'] == true ||
      members is! List ||
      options.mentions != null) {
    return [];
  }
  final agents = <String, String>{};
  for (final id in members.whereType<String>()) {
    if (options.agentId != null && options.agentId != id) continue;
    final agent = scope.find('agents', id);
    if (agent != null && !isManagedBot(agent) && agent['name'] is String) {
      agents[id] = agent['name'] as String;
    }
  }
  final result = <ChatSkill>[];
  for (final skill in scope.items('skills')) {
    final id = skill['id'];
    final agentId = skill['agentId'];
    final agentName = agents[agentId];
    final name = skill['name'];
    final version = skill['version'];
    if (isChatReference(id) &&
        agentId is String &&
        agentName != null &&
        name is String &&
        name.trim().isNotEmpty &&
        version is int &&
        version > 0 &&
        skill['status'] == 'active' &&
        skill['content'] is String) {
      result.add((
        id: id as String,
        agentId: agentId,
        agentName: agentName,
        name: name,
        version: version,
      ));
    }
  }
  return result
    ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
}

Future<ChatSkill?> chooseChatSkill(
  BuildContext context,
  List<ChatSkill> skills,
) => showModalBottomSheet<ChatSkill>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (context) => FractionallySizedBox(
    heightFactor: .72,
    child: SafeArea(
      top: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
            child: Text(
              context.tr('chatUseSkill'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Text(context.tr('chatSkillHelp')),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: skills.length,
              itemBuilder: (context, index) {
                final skill = skills[index];
                return ListTile(
                  leading: const Icon(Icons.auto_awesome_outlined),
                  title: Text(skill.name),
                  subtitle: Text('${skill.agentName} · v${skill.version}'),
                  onTap: () => Navigator.pop(context, skill),
                );
              },
            ),
          ),
        ],
      ),
    ),
  ),
);
