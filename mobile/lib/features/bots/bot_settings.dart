import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'bot_form.dart';
import 'bot_skills_card.dart';
import 'knowledge_screen.dart';
import '../routines/routines_screen.dart';
import '../computer/computer_screen.dart';

class BotSettings extends StatefulWidget {
  const BotSettings({super.key, required this.scope, required this.bot});
  final WorkspaceController scope;
  final Json bot;
  @override
  State<BotSettings> createState() => _BotSettingsState();
}

class _BotSettingsState extends State<BotSettings> {
  final form = GlobalKey<FormState>();
  late Json draft;
  late String revision;
  bool busy = false;
  bool unknown = false;
  String? error;
  int formVersion = 0;
  @override
  void initState() {
    super.initState();
    _load(widget.bot);
  }

  void _load(Json bot) {
    draft = {
      for (final key in [
        'name',
        'role',
        'description',
        'instructions',
        'avatar',
        'color',
        'modelProfileId',
      ])
        key: bot[key],
      if (bot.containsKey('avatarImageId'))
        'avatarImageId': bot['avatarImageId'],
    };
    revision = bot['configRevision'] as String? ?? '';
    formVersion++;
  }

  Future<void> _save() async {
    if (!widget.scope.active ||
        !widget.scope.owner ||
        isManagedBot(
          widget.scope.find('agents', widget.bot['id'] as String) ?? widget.bot,
        ) ||
        !form.currentState!.validate() ||
        busy ||
        unknown) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.scope.request(
        'PATCH',
        '/agents/${widget.bot['id']}',
        body: {...draft, 'expectedRevision': revision},
      );
      await widget.scope.refresh();
      if (mounted && widget.scope.active) Navigator.pop(context);
    } catch (e) {
      if (mounted && widget.scope.active) {
        setState(() {
          error = e is ApiException ? e.message : 'requestFailed';
          unknown = e is! ApiException || e.status == 0 || e.status >= 500;
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _refresh() async {
    await widget.scope.refresh();
    if (!mounted || !widget.scope.active) return;
    final current = widget.scope.find('agents', widget.bot['id'] as String);
    if (current == null) {
      setState(() => error = 'unavailable');
      return;
    }
    if (await confirm(context, 'loadCurrent')) {
      if (mounted) {
        setState(() {
          _load(current);
          unknown = false;
          error = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.scope, widget.scope.session]),
    builder: (context, _) => _content(context),
  );

  Widget _content(BuildContext context) {
    final scope = widget.scope;
    final botId = widget.bot['id'] as String;
    final expectedRevision = revision;
    final currentBot = scope.find('agents', botId) ?? widget.bot;
    final editable = scope.active && scope.owner && !isManagedBot(currentBot);
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('botSettings'))),
      body: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (!editable)
              Notice(
                isManagedBot(widget.bot) ? 'sharedBotReadOnly' : 'readOnly',
              ),
            if (error != null)
              Notice(
                error!,
                action: 'refresh',
                onAction: busy ? null : _refresh,
              ),
            if (unknown) const Notice('requestUnknown'),
            BotForm(
              key: ValueKey(formVersion),
              initial: draft,
              enabled: editable && !busy && !unknown,
              family: widget.scope.session.avatarTheme,
              avatarScope: scope,
              avatarTargetCurrent: () {
                final current = scope.find('agents', botId);
                return current != null &&
                    !isManagedBot(current) &&
                    (current['configRevision'] as String? ?? '') ==
                        expectedRevision;
              },
              sharedAvatar: currentBot['sharedBot'],
              managed: isManagedBot(currentBot),
              onChanged: (value) => draft = value,
            ),
            const SizedBox(height: 24),
            Card(
              child: ListTile(
                title: Text(context.tr('routines')),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => RoutinesScreen(
                      scope: widget.scope,
                      agentId: widget.bot['id'] as String,
                    ),
                  ),
                ),
              ),
            ),
            Card(
              child: ListTile(
                title: Text(context.tr('mobileComputerTitle')),
                leading: const Icon(Icons.computer),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => ComputerScreen(
                      scope: widget.scope,
                      agentId: widget.bot['id'] as String,
                    ),
                  ),
                ),
              ),
            ),
            BotSkillsCard(scope: scope, agentId: botId),
            for (final kind in ['memories'])
              Card(
                child: ListTile(
                  title: Text(context.tr(kind)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => KnowledgeScreen(
                        scope: widget.scope,
                        agentId: widget.bot['id'] as String,
                        kind: kind,
                      ),
                    ),
                  ),
                ),
              ),
            const SizedBox(height: 24),
            if (editable)
              FilledButton(
                onPressed: busy || unknown ? null : _save,
                child: Text(context.tr('save')),
              ),
          ],
        ),
      ),
    );
  }
}
