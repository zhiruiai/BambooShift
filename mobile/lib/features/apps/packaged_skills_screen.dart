import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../bots/knowledge_editor.dart';
import '../bots/knowledge_screen.dart';
import '../bots/skill_recipe_picker.dart';
import '../chat/chat_markdown.dart';

class PackagedSkillsScreen extends StatefulWidget {
  const PackagedSkillsScreen({super.key, required this.scope});

  final WorkspaceController scope;

  @override
  State<PackagedSkillsScreen> createState() => _PackagedSkillsScreenState();
}

class _PackagedSkillsScreenState extends State<PackagedSkillsScreen> {
  String? _language;
  late Future<List<Json>> _recipes;
  String _query = '';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final language = Localizations.localeOf(context).languageCode;
    if (_language != language) {
      _language = language;
      _recipes = loadSkillRecipes(language);
    }
  }

  void _preview(Json recipe) {
    if (!widget.scope.active) return;
    FocusScope.of(context).unfocus();
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => _SkillPreview(scope: widget.scope, recipe: recipe),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('mobileAppsPackagedSkills'))),
    body: ListenableBuilder(
      listenable: widget.scope.session,
      builder: (context, _) => !widget.scope.active
          ? const Notice('scopeChanged')
          : FutureBuilder(
              future: _recipes,
              builder: (context, snapshot) {
                if (snapshot.hasError) return const Notice('requestFailed');
                if (!snapshot.hasData) {
                  return const Center(child: CircularProgressIndicator());
                }
                final matches = snapshot.data!.where(
                  (recipe) =>
                      '${recipe['id']} ${recipe['name']} ${recipe['description']}'
                          .toLowerCase()
                          .contains(_query),
                );
                return Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      child: TextField(
                        maxLength: 120,
                        onChanged: (value) =>
                            setState(() => _query = value.trim().toLowerCase()),
                        decoration: InputDecoration(
                          labelText: context.tr('mobileAppsPackagedSearch'),
                          prefixIcon: const Icon(Icons.search),
                          counterText: '',
                        ),
                      ),
                    ),
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                        keyboardDismissBehavior:
                            ScrollViewKeyboardDismissBehavior.onDrag,
                        children: [
                          if (matches.isEmpty)
                            const Notice('mobileAppsPackagedEmpty'),
                          for (final recipe in matches)
                            Card(
                              child: ListTile(
                                leading: const Icon(
                                  Icons.auto_awesome_outlined,
                                ),
                                title: Text(recipe['name'] as String),
                                subtitle: Text(recipe['description'] as String),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () => _preview(recipe),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
    ),
  );
}

class _SkillPreview extends StatefulWidget {
  const _SkillPreview({required this.scope, required this.recipe});

  final WorkspaceController scope;
  final Json recipe;

  @override
  State<_SkillPreview> createState() => _SkillPreviewState();
}

class _SkillPreviewState extends State<_SkillPreview> {
  String? _agentId;
  bool _opening = false;
  bool _failed = false;

  WorkspaceController get _scope => widget.scope;

  bool _canEdit(String id) {
    final bot = _scope.find('agents', id);
    return _scope.active && _scope.owner && bot != null && !isManagedBot(bot);
  }

  Future<void> _edit(String id) async {
    if (_opening || !_canEdit(id)) return;
    setState(() {
      _opening = true;
      _failed = false;
    });
    try {
      await _scope.refresh();
      if (!mounted || !_scope.active) return;
      if (_scope.error != null || !_canEdit(id)) {
        setState(() => _failed = true);
        return;
      }
      var submitted = false;
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (_) => KnowledgeEditor(
            scope: _scope,
            agentId: id,
            kind: 'skills',
            original: {
              'name': widget.recipe['name'],
              'description': widget.recipe['description'],
              'content': widget.recipe['content'],
            },
            onSubmitted: () => submitted = true,
          ),
        ),
      );
      if (mounted && submitted && _canEdit(id)) {
        await Navigator.push<void>(
          context,
          MaterialPageRoute(
            builder: (_) =>
                KnowledgeScreen(scope: _scope, agentId: id, kind: 'skills'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_scope, _scope.session]),
    builder: (context, _) {
      final active = _scope.active;
      final targets = active && _scope.owner
          ? _scope
                .items('agents')
                .where(
                  (bot) =>
                      bot['id'] is String &&
                      (bot['id'] as String).isNotEmpty &&
                      bot['name'] is String &&
                      (bot['name'] as String).isNotEmpty &&
                      !isManagedBot(bot),
                )
          : const <Json>[];
      final id = targets.any((bot) => bot['id'] == _agentId) ? _agentId : null;
      return Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileAppsPackagedPreview'))),
        body: !active
            ? const Notice('scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text(
                    widget.recipe['name'] as String,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 6),
                  Text(widget.recipe['description'] as String),
                  const Notice('mobileAppsPackagedHelp'),
                  if (!_scope.owner) const Notice('mobileAppsPackagedReadOnly'),
                  if (_failed) const Notice('mobileAppsPackagedTargetChanged'),
                  const SizedBox(height: 8),
                  ChatMarkdown(
                    text: widget.recipe['content'] as String,
                    canOpenLink: () => false,
                  ),
                ],
              ),
        bottomNavigationBar: !active || !_scope.owner
            ? null
            : SafeArea(
                top: false,
                minimum: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: targets.isEmpty
                    ? Text(context.tr('mobileAppsPackagedNoBot'))
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          DropdownButtonFormField<String>(
                            key: ValueKey(id),
                            isExpanded: true,
                            initialValue: id,
                            hint: Text(
                              context.tr('mobileAppsPackagedChooseBot'),
                            ),
                            items: [
                              for (final bot in targets)
                                DropdownMenuItem(
                                  value: bot['id'] as String,
                                  child: Text(
                                    bot['name'] as String,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                            ],
                            onChanged: _opening
                                ? null
                                : (value) {
                                    setState(() {
                                      _agentId = value;
                                      _failed = false;
                                    });
                                  },
                          ),
                          const SizedBox(height: 8),
                          FilledButton(
                            onPressed: id == null || _opening
                                ? null
                                : () => _edit(id),
                            child: Text(context.tr('mobileAppsPackagedEdit')),
                          ),
                        ],
                      ),
              ),
      );
    },
  );
}
