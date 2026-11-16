import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'knowledge_editor_controller.dart';
import 'skill_file_import.dart';
import 'skill_package_data.dart';
import 'skill_package_preview.dart';
import 'skill_recipe_picker.dart';

class KnowledgeEditor extends StatefulWidget {
  const KnowledgeEditor({
    super.key,
    required this.scope,
    required this.agentId,
    required this.kind,
    this.original,
    this.onSubmitted,
    this.pickSkillFile = pickSkillMarkdown,
  });
  final WorkspaceController scope;
  final String agentId, kind;
  final Json? original;
  final VoidCallback? onSubmitted;
  final SkillFilePicker pickSkillFile;
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
  late Json? packageDraft = widget.original?['packageDraft'] as Json?;
  bool get skill => widget.kind == 'skills';
  bool get hasDraft =>
      name.text.isNotEmpty ||
      description.text.isNotEmpty ||
      content.text.isNotEmpty;
  bool importing = false, imported = false;
  String? importError;
  bool invalidPackage = false;
  int importEpoch = 0;
  bool get editable =>
      model.ready && model.allowed && !model.busy && model.pending == null;
  @override
  void initState() {
    super.initState();
    widget.scope.addListener(invalidateImport);
    widget.scope.session.addListener(invalidateImport);
    unawaited(model.initialize());
  }

  @override
  void dispose() {
    widget.scope.removeListener(invalidateImport);
    widget.scope.session.removeListener(invalidateImport);
    model.dispose();
    content.dispose();
    name.dispose();
    description.dispose();
    super.dispose();
  }

  void invalidateImport() {
    if (!importing || model.allowed) return;
    importEpoch++;
    setState(() => importing = false);
  }

  Future<void> importSkill() async {
    if (!editable || hasDraft || importing) return;
    final scope = widget.scope;
    final epoch = ++importEpoch;
    bool current() =>
        mounted &&
        epoch == importEpoch &&
        identical(widget.scope, scope) &&
        widget.agentId == model.agentId &&
        editable &&
        !hasDraft &&
        ModalRoute.isCurrentOf(context) != false;
    setState(() {
      importing = true;
      importError = null;
    });
    try {
      final file = await widget.pickSkillFile();
      if (!current() || file == null) return;
      final draft = await readSkillMarkdown(file, isCurrent: current);
      if (!current() || draft == null) return;
      name.text = draft.name;
      description.text = draft.description;
      content.text = draft.content;
      imported = true;
    } on FormatException {
      if (current()) importError = 'mobileKnowledgeImportInvalid';
    } catch (_) {
      if (current()) importError = 'mobileKnowledgeImportReadFailed';
    } finally {
      if (mounted && importEpoch == epoch) {
        setState(() => importing = false);
      }
    }
  }

  Future<void> save() async {
    if (content.text.trim().isEmpty || (skill && name.text.trim().isEmpty)) {
      return;
    }
    final package = packageDraft;
    if (skill &&
        package != null &&
        (name.text != package['root'] ||
            description.text.trim().isEmpty ||
            description.text.trim().runes.length > 1024 ||
            description.text.contains('\u0000') ||
            content.text.contains('\u0000') ||
            utf8.encode(content.text).length > skillPackageMaxContentBytes)) {
      setState(() => invalidPackage = true);
      return;
    }
    if (invalidPackage) setState(() => invalidPackage = false);
    final success = await model.save({
      'content': package == null ? content.text.trim() : content.text,
      if (skill) ...{
        'name': name.text.trim(),
        'description': description.text.trim(),
        'skillPackage': ?package,
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
    final draft = skillRecipeDraft(recipe);
    name.text = draft['name'] as String;
    description.text = draft['description'] as String;
    content.text = draft['content'] as String;
    setState(() {
      packageDraft = draft['packageDraft'] as Json;
      imported = false;
      importError = null;
      invalidPackage = false;
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([model, widget.scope, widget.scope.session]),
    builder: (context, _) {
      final package = skill ? packageDraft : null;
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
                  if (invalidPackage)
                    const Notice('mobileSkillPackageDraftInvalid'),
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
                    if (importError case final error?) Notice(error),
                    if (imported) const Notice('mobileKnowledgeImportedSkill'),
                    ListenableBuilder(
                      listenable: Listenable.merge([
                        name,
                        description,
                        content,
                      ]),
                      builder: (context, _) => hasDraft
                          ? const SizedBox.shrink()
                          : OutlinedButton.icon(
                              onPressed: editable && !importing
                                  ? importSkill
                                  : null,
                              icon: const Icon(Icons.file_open_outlined),
                              label: Text(
                                context.tr('mobileKnowledgeImportSkill'),
                              ),
                            ),
                    ),
                    OutlinedButton.icon(
                      onPressed: editable ? fillRecipe : null,
                      icon: const Icon(Icons.auto_awesome_outlined),
                      label: Text(context.tr('mobileKnowledgeRecipes')),
                    ),
                    if (package != null)
                      Text(
                        skillDisplayName({
                          'name': package['root'],
                          'skillPackage': package,
                        }),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    TextField(
                      controller: name,
                      enabled: editable,
                      readOnly: package != null,
                      maxLength: 100,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileKnowledgeSkillName'),
                      ),
                    ),
                    TextField(
                      controller: description,
                      enabled: editable,
                      maxLength: package == null ? 1000 : 1024,
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
                    maxLength: skill
                        ? (package == null
                              ? 16000
                              : skillPackageMaxContentBytes)
                        : 4000,
                    style: const TextStyle(fontSize: 16),
                    decoration: InputDecoration(
                      labelText: context.tr('mobileKnowledgeContent'),
                    ),
                  ),
                  if (package != null)
                    SkillPackagePreview(
                      package: SkillPackageDetails.draft(package),
                    ),
                ],
              ),
      );
    },
  );
}
