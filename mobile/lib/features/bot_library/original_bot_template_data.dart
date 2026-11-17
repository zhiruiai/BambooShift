import 'dart:convert';

import 'package:flutter/services.dart';

import '../../core/api.dart';

class OriginalBotTemplate {
  const OriginalBotTemplate(this.id, this.category, this.profile,
      {this.foundationSkills = const []});

  final String id, category;
  final Json profile;
  final List<String> foundationSkills;
}

Future<List<OriginalBotTemplate>> loadOriginalBotTemplates(
  String language,
) async {
  final source = await rootBundle.loadString(
    'assets/templates/bot-starter-templates.json',
  );
  final catalog = jsonDecode(source) as Json;
  final locale = language == 'en' ? 'en' : 'zh-CN';
  final packs = jsonDecode(await rootBundle
      .loadString('assets/templates/starter-skill-packs.json')) as Json;
  final workflows = jsonDecode(await rootBundle.loadString(
      'assets/skills/${locale == 'en' ? 'en' : 'zh'}.json')) as List;
  final foundation = (packs['foundation'] as List)
      .map((id) => (workflows
          .cast<Json>()
          .firstWhere((item) => item['id'] == id)['name'] as String))
      .toList();
  return catalog.entries.map((entry) {
    final template = entry.value as Json;
    final localized = template['locales'][locale] as Json;
    return OriginalBotTemplate(
        entry.key,
        localized['category'] as String,
        {
          for (final field in ['name', 'role', 'description', 'instructions'])
            field: localized[field] as String,
          'avatar': template['avatar'] as String,
          'color': template['color'] as String,
          'avatarImageId': null,
        },
        foundationSkills: foundation);
  }).toList();
}

List<OriginalBotTemplate> filterOriginalBotTemplates(
  List<OriginalBotTemplate> templates,
  String query,
  String category,
) {
  final words = query.trim().toLowerCase().split(RegExp(r'\s+'));
  return templates.where((template) {
    if (category.isNotEmpty && template.id != category) return false;
    final searchable = [
      for (final field in ['name', 'role', 'description', 'instructions'])
        template.profile[field],
    ].join(' ').toLowerCase();
    return words.every(searchable.contains);
  }).toList();
}
