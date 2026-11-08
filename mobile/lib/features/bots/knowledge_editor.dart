import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'knowledge_editor_controller.dart';
import 'skill_recipe_picker.dart';

class KnowledgeEditor extends StatefulWidget {
  const KnowledgeEditor({
    super.key,
    required this.scope,
    required this.agentId,
    required this.kind,
    this.original,
    this.onSubmitted,
  });
  final WorkspaceController scope;
  final String agentId, kind;
  final Json? original;
  final VoidCallback? onSubmitted;
  @override
  State<KnowledgeEditor> createState() => _KnowledgeEditorState();
}

class _KnowledgeEditorState extends State<KnowledgeEditor> {
  late final model = KnowledgeEditorController(
    widget.scope,
    widget.agentId,
    widget.kind,
  );
  late final content = TextEditingController(
    text: widget.original?['content'] as String? ?? '',
  );
  late final name = TextEditingController(
    text: widget.original?['name'] as String? ?? '',
  );
  late final description = TextEditingController(
    text: widget.original?['description'] as String? ?? '',
  );
  late String category = widget.original?['category'] as String? ?? 'context';
  bool get skill => widget.kind == 'skills';
  bool get editable =>
      model.ready && model.allowed && !model.busy && model.pending == null;
  @override
  void initState() {
    super.initState();
    unawaited(model.initialize());
  }

  @override
  void dispose() {
    model.dispose();
    content.dispose();
    name.dispose();
    description.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (content.text.trim().isEmpty || (skill && name.text.trim().isEmpty)) {
      return;
    }
    final success = await model.save({
      'content': content.text.trim(),
      if (skill) ...{
        'name': name.text.trim(),
        'description': description.text.trim(),
      } else
        'category': category,
    }, id: skill ? null : widget.original?['id'] as String?);
    if (success &&
        mounted &&
        widget.scope.active &&
        ModalRoute.of(context)?.isCurrent == true) {
      Navigator.pop(context);
      if (skill) widget.onSubmitted?.call();
    }
  }

  Future<void> forget() async {
    if (!await confirm(context, 'mobileKnowledgeForgetConfirm')) return;
    await model.forget();
    if (mounted && widget.scope.active && model.pending == null) {
      Navigator.pop(context);
    }
  }

  Future<void> fillRecipe() async {
    final recipe = await pickSkillRecipe(context);
    if (!mounted || !editable || recipe == null) return;
    final hasDraft = [
      name,
      description,
      content,
    ].any((field) => field.text.trim().isNotEmpty);
    if (hasDraft &&
        !await confirm(context, 'mobileKnowledgeReplaceWithRecipe')) {
      return;
    }
    if (!mounted || !editable) return;
    name.text = recipe['name'] as String;
    description.text = recipe['description'] as String;
    content.text = recipe['content'] as String;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([model, widget.scope, widget.scope.session]),
    builder: (context, _) {
      return Scaffold(
        appBar: AppBar(
          title: Text(
            context.tr(
              skill
                  ? 'mobileKnowledgeProposeSkill'
                  : 'mobileKnowledgeEditMemory',
            ),
          ),
        ),
        bottomNavigationBar: SafeArea(
          top: false,
          minimum: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: FilledButton(
            onPressed: editable ? save : null,
            child: Text(
              context.tr(skill ? 'mobileKnowledgeSubmitReview' : 'save'),
            ),
          ),
        ),
        body: !model.allowed
            ? Notice(widget.scope.active ? 'unavailable' : 'scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (model.error != null) Notice(model.error!),
                  if (model.accepted != null)
                    const Notice('mobileKnowledgeAccepted'),
                  if (model.pending != null) ...[
                    const Notice('mobileKnowledgeUnknown'),
                    TextButton(
                      onPressed: model.busy ? null : model.check,
                      child: Text(context.tr('checkResult')),
                    ),
                    if (model.checked) ...[
                      for (final item
                          in widget.scope
                              .items(widget.kind)
                              .where((i) => i['agentId'] == widget.agentId))
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: SelectableText(
                              item['content'] as String? ?? '',
                              style: const TextStyle(fontSize: 14),
                            ),
                          ),
                        ),
                      TextButton(
                        onPressed: model.busy ? null : forget,
                        child: Text(context.tr('mobileKnowledgeForget')),
                      ),
                    ],
                  ],
                  if (skill) ...[
                    const Notice('mobileKnowledgeSkillReview'),
                    OutlinedButton.icon(
                      onPressed: editable ? fillRecipe : null,
                      icon: const Icon(Icons.auto_awesome_outlined),
                      label: Text(context.tr('mobileKnowledgeRecipes')),
                    ),
                    TextField(
                      controller: name,
                      enabled: editable,
                      maxLength: 100,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileKnowledgeSkillName'),
                      ),
                    ),
                    TextField(
                      controller: description,
                      enabled: editable,
                      maxLength: 1000,
                      maxLines: 3,
                      decoration: InputDecoration(
                        labelText: context.tr('description'),
                      ),
                    ),
                  ] else
                    DropdownButtonFormField<String>(
                      initialValue: category,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileKnowledgeCategory'),
                      ),
                      items: [
                        for (final value in [
                          'preference',
                          'context',
                          'learning',
                        ])
                          DropdownMenuItem(
                            value: value,
                            child: Text(context.tr(value)),
                          ),
                      ],
                      onChanged: editable
                          ? (value) => setState(() => category = value!)
                          : null,
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: content,
                    enabled: editable,
                    minLines: 6,
                    maxLines: 18,
                    maxLength: skill ? 16000 : 4000,
                    style: const TextStyle(fontSize: 16),
                    decoration: InputDecoration(
                      labelText: context.tr('mobileKnowledgeContent'),
                    ),
                  ),
                ],
              ),
      );
    },
  );
}
