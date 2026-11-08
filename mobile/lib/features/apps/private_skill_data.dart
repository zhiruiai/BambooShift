import '../../core/api.dart';

final _identifier = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final _revision = RegExp(r'^[a-f0-9]{64}$');
const _invalid = ApiException(
  'INVALID_RESPONSE',
  'mobileAppsPrivateSkillsInvalid',
);

typedef PrivateSkillBot = ({String id, String name});
typedef PrivateSkillKey = ({String id, String revision});

String _id(Object? value) {
  if (value is! String || !_identifier.hasMatch(value)) throw _invalid;
  return value;
}

String _text(Object? value, {bool allowEmpty = false}) {
  if (value is! String || (!allowEmpty && value.trim().isEmpty)) throw _invalid;
  return value;
}

class PrivateSkill {
  PrivateSkill._(Json data)
    : id = _id(data['id']),
      sourceAgentId = _id(data['sourceAgentId']),
      sourceAgentName = _text(data['sourceAgentName']),
      name = _text(data['name']),
      description = _text(data['description'], allowEmpty: true),
      content = _text(data['content']),
      version = data['version'] is int ? data['version'] : 0,
      revision = _text(data['revision']),
      available = data['available'] == true,
      enabledAgentIds = _enabled(data['enabledAgentIds']) {
    if (version < 1 ||
        version > 9007199254740991 ||
        name.length > 100 ||
        description.length > 1000 ||
        content.length > 16000 ||
        !_revision.hasMatch(revision) ||
        data['available'] is! bool ||
        enabledAgentIds.contains(sourceAgentId)) {
      throw _invalid;
    }
  }

  final String id, sourceAgentId, sourceAgentName, name, description, content;
  final int version;
  final String revision;
  final bool available;
  final Set<String> enabledAgentIds;
  PrivateSkillKey get key => (id: id, revision: revision);

  static Set<String> _enabled(Object? value) {
    if (value is! List) throw _invalid;
    final ids = value.map(_id).toSet();
    if (ids.length != value.length) throw _invalid;
    return Set.unmodifiable(ids);
  }
}

class PrivateSkillShelf {
  const PrivateSkillShelf(this.agents, this.skills);
  final List<PrivateSkillBot> agents;
  final List<PrivateSkill> skills;

  factory PrivateSkillShelf.parse(Json data) {
    final agents = data['agents'];
    final skills = data['skills'];
    if (agents is! List || skills is! List) throw _invalid;
    final local = <PrivateSkillBot>[];
    final ids = <String>{};
    for (final row in agents) {
      if (row is! Json) throw _invalid;
      final id = _id(row['id']);
      if (!ids.add(id)) throw _invalid;
      local.add((id: id, name: _text(row['name'])));
    }
    final entries = <PrivateSkill>[];
    final keys = <PrivateSkillKey>{};
    for (final row in skills) {
      if (row is! Json) throw _invalid;
      final skill = PrivateSkill._(row);
      if (!keys.add(skill.key) ||
          (skill.available && !ids.contains(skill.sourceAgentId)) ||
          !ids.containsAll(skill.enabledAgentIds)) {
        throw _invalid;
      }
      entries.add(skill);
    }
    return PrivateSkillShelf(
      List.unmodifiable(local),
      List.unmodifiable(entries),
    );
  }

  PrivateSkill? find(PrivateSkillKey? key) =>
      skills.where((skill) => skill.key == key).firstOrNull;

  List<PrivateSkillBot> targets(PrivateSkill skill) => agents
      .where(
        (bot) =>
            bot.id != skill.sourceAgentId &&
            (skill.available || skill.enabledAgentIds.contains(bot.id)),
      )
      .toList();

  PrivateSkill? earlier(PrivateSkill skill, String targetId) => skills
      .where(
        (row) =>
            row.key != skill.key &&
            row.sourceAgentId == skill.sourceAgentId &&
            row.name == skill.name &&
            row.enabledAgentIds.contains(targetId),
      )
      .firstOrNull;
}
