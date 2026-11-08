import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';

Future<List<Json>> loadSkillRecipes(String language) => rootBundle
    .loadString('assets/skills/${language == 'zh' ? 'zh' : 'en'}.json')
    .then((text) => (jsonDecode(text) as List).cast<Json>());

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
