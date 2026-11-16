import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'skill_package_data.dart';

Future<List<Json>> loadSkillRecipes(String language) async {
  final chinese = language == 'zh' || language == 'zh-CN';
  final texts = await Future.wait([
    rootBundle.loadString('assets/skills/${chinese ? 'zh' : 'en'}.json'),
    rootBundle.loadString('assets/skills/workflow-resources.json'),
  ]);
  final rows = (jsonDecode(texts[0]) as List).cast<Json>();
  final resources = jsonDecode(texts[1]) as Json;
  return [
    for (final row in rows)
      _withResources(
        row,
        resources[row['id']] as Json,
        chinese ? 'zh-CN' : 'en',
      ),
  ];
}

Json skillRecipeDraft(Json recipe) => {
  'name': recipe['id'],
  'description': recipe['description'],
  'content': recipe['content'],
  'packageDraft': recipe['packageDraft'],
};

Json _withResources(Json recipe, Json resources, String locale) {
  final id = recipe['id'] as String;
  final files = resources['files'] as Json;
  final content = (recipe['content'] as String).trimRight();
  final instruction = (resources['instruction'] as Json)[locale] as String;
  final instructions = '$content\n\n$instruction\n';
  if (!validSkillPackageName(id) ||
      instruction.trim().isEmpty ||
      utf8.encode(instructions).length > skillPackageMaxContentBytes ||
      files.isEmpty ||
      files.length >= skillPackageMaxFiles) {
    throw const FormatException('Invalid bundled skill');
  }
  final paths = {'skill.md'};
  final encoded = <Json>[];
  var size = utf8.encode(instructions).length;
  for (final MapEntry(:key, :value) in files.entries) {
    final bytes = utf8.encode(value as String);
    size += bytes.length;
    if (!validSkillPackagePath(key) ||
        bytes.length > skillPackageMaxFileBytes ||
        size > skillPackageMaxBytes ||
        !paths.add(key.toLowerCase())) {
      throw const FormatException('Invalid bundled skill resource');
    }
    encoded.add({'path': key, 'base64': base64Encode(bytes)});
  }
  for (final path in paths) {
    for (final slash in '/'.allMatches(path)) {
      if (paths.contains(path.substring(0, slash.start))) {
        throw const FormatException('Conflicting bundled skill paths');
      }
    }
  }
  return {
    ...recipe,
    'content': instructions,
    'packageDraft': {
      'root': id,
      'frontmatter': {
        if (resources['license'] case final String value) 'license': value,
        if (resources['compatibility'] case final String value)
          'compatibility': value,
        'metadata': {
          'title': recipe['name'],
          if (resources['source'] case final String value) 'source': value,
        },
      },
      'files': encoded,
    },
  };
}

Future<Json?> pickSkillRecipe(BuildContext context) {
  final recipes = loadSkillRecipes(
    Localizations.localeOf(context).languageCode,
  );
  return showModalBottomSheet<Json>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: FutureBuilder(
        future: recipes,
        builder: (context, snapshot) {
          if (snapshot.hasError) return const Notice('requestFailed');
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Text(
                  context.tr('mobileKnowledgeRecipes'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              for (final recipe in snapshot.data!)
                ListTile(
                  leading: const Icon(Icons.auto_awesome_outlined),
                  title: Text(recipe['name'] as String),
                  subtitle: Text(recipe['description'] as String),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.pop(context, recipe),
                ),
            ],
          );
        },
      ),
    ),
  );
}
