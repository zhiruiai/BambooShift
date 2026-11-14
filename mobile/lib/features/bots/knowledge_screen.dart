import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'knowledge_editor.dart';
import 'memory_import_screen.dart';
import 'skill_recipe_picker.dart';
import 'team_skills_screen.dart';

class KnowledgeScreen extends StatefulWidget {
  const KnowledgeScreen({
    super.key,
    required this.scope,
    required this.agentId,
    required this.kind,
  });
  final WorkspaceController scope;
  final String agentId;
  final String kind;
  @override
  State<KnowledgeScreen> createState() => _KnowledgeScreenState();
}

class _KnowledgeScreenState extends State<KnowledgeScreen> {
  bool busy = false;
  String? error;
  bool get canManageSkills {
    final bot = widget.scope.find('agents', widget.agentId);
    return widget.scope.active &&
        widget.scope.owner &&
        bot != null &&
        !isManagedBot(bot);
  }

  Future<void> _chooseSkill() async {
    if (busy || !canManageSkills) return;
    final recipe = await pickSkillRecipe(context);
    if (!mounted || recipe == null || busy || !canManageSkills) return;
    await _edit(recipe);
  }

  Future<void> _teamSkills() async {
    if (busy || !widget.scope.active) return;
    final agentId = await Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (_) => TeamSkillsScreen(
          scope: widget.scope,
          sourceAgentId: widget.agentId,
        ),
      ),
    );
    if (!mounted ||
        !widget.scope.active ||
        agentId == null ||
        agentId == widget.agentId) {
      return;
    }
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => KnowledgeScreen(
          scope: widget.scope,
          agentId: agentId,
          kind: 'skills',
        ),
      ),
    );
  }

  Future<void> _edit([Json? original]) async {
    if (busy ||
        !widget.scope.active ||
        (widget.kind == 'skills' && !canManageSkills)) {
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => KnowledgeEditor(
          scope: widget.scope,
          agentId: widget.agentId,
          kind: widget.kind,
          original: original,
        ),
      ),
    );
    if (mounted && widget.scope.active) await widget.scope.refresh();
  }

  Future<void> _change(Json item, String action) async {
    if (busy || (widget.kind == 'skills' && !canManageSkills)) return;
    final current = widget.scope
        .items('skills')
        .where(
          (s) =>
              s['agentId'] == widget.agentId &&
              s['name'] == item['name'] &&
              s['status'] == 'active',
        )
        .firstOrNull;
    if (!await confirm(
      context,
      action == 'delete' ? 'deleteConfirm' : 'skillConfirm',
    )) {
      return;
    }
    if (!mounted ||
        !widget.scope.active ||
        (widget.kind == 'skills' && !canManageSkills)) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.scope.request(
        action == 'delete' ? 'DELETE' : 'POST',
        '/${widget.kind}/${item['id']}${action == 'delete' ? '' : '/$action'}',
        body: action == 'delete' ? null : {'expectedActiveId': current?['id']},
      );
      await widget.scope.refresh();
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() => error = e is ApiException ? e.message : 'requestFailed');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.scope, widget.scope.session]),
    builder: (context, _) {
      final items = widget.scope
          .items(widget.kind)
          .where((item) => item['agentId'] == widget.agentId)
          .toList();
      final bot = widget.scope.find('agents', widget.agentId);
      final local = bot != null && !isManagedBot(bot);
      final allowed =
          widget.scope.active &&
          bot != null &&
          (widget.kind == 'memories' || (widget.scope.owner && local));
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr(widget.kind)),
          actions: [
            if (allowed)
              IconButton(
                tooltip: context.tr('mobileKnowledgeAdd'),
                onPressed: busy ? null : () => _edit(),
                icon: const Icon(Icons.add),
              ),
          ],
        ),
        body: RefreshIndicator(
          onRefresh: widget.scope.refresh,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (widget.kind == 'skills') ...[
                if (bot?['name'] is String)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      bot!['name'] as String,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                const Notice('mobileBotSkillsHelp'),
                if (allowed)
                  OutlinedButton.icon(
                    onPressed: busy ? null : _chooseSkill,
                    icon: const Icon(Icons.library_add_outlined),
                    label: Text(context.tr('mobileKnowledgeRecipes')),
                  ),
              ],
              if (widget.kind == 'skills' &&
                  widget.scope.session.workspace?['kind'] == 'team')
                OutlinedButton.icon(
                  onPressed: busy || !widget.scope.active ? null : _teamSkills,
                  icon: const Icon(Icons.groups_outlined),
                  label: Text(context.tr('mobileTeamSkillTitle')),
                ),
              if (widget.kind == 'memories' &&
                  widget.scope.owner &&
                  widget.scope.session.workspace?['kind'] == 'personal')
                Card(
                  child: ListTile(
                    title: Text(context.tr('mobileKnowledgeImport')),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => MemoryImportScreen(scope: widget.scope),
                      ),
                    ),
                  ),
                ),
              if (error != null)
                Notice(
                  error!,
                  action: 'refresh',
                  onAction: () => widget.scope.refresh(),
                ),
              if (items.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(context.tr('noItems')),
                ),
              for (final item in items)
                Card(
                  child: ExpansionTile(
                    title: Text(
                      widget.kind == 'skills'
                          ? item['name'] as String? ?? ''
                          : item['content'] as String? ?? '',
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: widget.kind == 'skills'
                        ? Text(
                            '${context.tr(item['status'] as String? ?? '')} · v${item['version'] ?? 1}',
                          )
                        : Text(
                            context.tr(
                              item['category'] as String? ?? 'context',
                            ),
                          ),
                    childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    expandedCrossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (item['teamSource'] is Json)
                        Text(
                          "${context.tr('mobileTeamSkillPinned')} v${item['teamSource']['version']}",
                        ),
                      if (widget.kind == 'skills' &&
                          (item['description'] as String? ?? '').isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Text(item['description'] as String),
                        ),
                      SelectableText(
                        item['content'] as String? ?? '',
                        style: const TextStyle(fontSize: 14, height: 1.5),
                      ),
                      if (allowed)
                        Wrap(
                          spacing: 8,
                          children: [
                            TextButton(
                              onPressed: busy ? null : () => _edit(item),
                              child: Text(
                                context.tr(
                                  widget.kind == 'skills'
                                      ? 'mobileKnowledgeNewVersion'
                                      : 'edit',
                                ),
                              ),
                            ),
                            if (widget.kind == 'skills')
                              TextButton(
                                onPressed: busy
                                    ? null
                                    : () => _change(
                                        item,
                                        item['status'] == 'proposed'
                                            ? 'approve'
                                            : item['status'] == 'active'
                                            ? 'disable'
                                            : 'restore',
                                      ),
                                child: Text(
                                  context.tr(
                                    item['status'] == 'proposed'
                                        ? 'approve'
                                        : item['status'] == 'active'
                                        ? 'disable'
                                        : 'restore',
                                  ),
                                ),
                              ),
                            TextButton(
                              onPressed: busy
                                  ? null
                                  : () => _change(item, 'delete'),
                              child: Text(context.tr('delete')),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}
