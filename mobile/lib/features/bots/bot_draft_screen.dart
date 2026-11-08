import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import '../settings/model_settings.dart';
import 'bot_creation_preview.dart';

class BotDraftScreen extends StatefulWidget {
  const BotDraftScreen({super.key, required this.scope});

  final WorkspaceController scope;

  @override
  State<BotDraftScreen> createState() => _BotDraftScreenState();
}

class _BotDraftScreenState extends State<BotDraftScreen> {
  final brief = TextEditingController();
  final cancellation = ByteReadCancellation();
  Json? draft;
  bool busy = false, failed = false;

  WorkspaceController get scope => widget.scope;
  bool get current =>
      mounted && scope.active && scope.owner && !cancellation.cancelled;
  bool get configured => scope.data?['settings']?['configured'] == true;
  bool get canGenerate {
    final text = brief.text.trim();
    return current &&
        configured &&
        !busy &&
        text.isNotEmpty &&
        text.length <= 3000 &&
        !text.contains('\x00');
  }

  @override
  void initState() {
    super.initState();
    scope.addListener(_scopeChanged);
    scope.session.addListener(_scopeChanged);
  }

  void _scopeChanged() {
    if (!mounted) return;
    if (!current) cancellation.cancel();
    setState(() {
      if (!current) {
        draft = null;
        busy = false;
        failed = false;
      }
    });
  }

  @override
  void dispose() {
    scope.removeListener(_scopeChanged);
    scope.session.removeListener(_scopeChanged);
    cancellation.cancel();
    brief.dispose();
    super.dispose();
  }

  Future<void> _generate() async {
    if (!canGenerate) return;
    final prompt = brief.text.trim();
    FocusScope.of(context).unfocus();
    setState(() {
      busy = true;
      failed = false;
      draft = null;
    });
    try {
      final response = await scope.session.api.requestValue(
        'POST',
        scope.path('/creation-preview'),
        body: {
          'kind': 'bot',
          'brief': prompt,
          'language': scope.session.api.language,
        },
        expectedUser: scope.userId,
        cancellation: cancellation,
        isCurrent: () => current,
        timeout: const Duration(seconds: 75),
      );
      if (!current) return;
      final profile = botCreationPreview(response);
      setState(() {
        draft = profile;
        failed = profile == null;
      });
    } catch (_) {
      if (current) setState(() => failed = true);
    } finally {
      if (current) setState(() => busy = false);
    }
  }

  void _openModels() {
    if (!current) return;
    Navigator.push(
      context,
      MaterialPageRoute<void>(builder: (_) => ModelSettings(scope: scope)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final preview = draft;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('mobileBotDraftTitle'))),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (!current)
              const Notice('scopeChanged')
            else ...[
              Text(context.tr('mobileBotDraftHelp')),
              const SizedBox(height: 16),
              TextField(
                controller: brief,
                enabled: !busy,
                minLines: 3,
                maxLines: 6,
                maxLength: 3000,
                onChanged: (_) => setState(() {
                  draft = null;
                  failed = false;
                }),
                decoration: InputDecoration(
                  labelText: context.tr('mobileBotDraftBrief'),
                  hintText: context.tr('mobileBotDraftExample'),
                  alignLabelWithHint: true,
                ),
              ),
              if (!configured)
                Notice(
                  'mobileBotDraftNeedsModel',
                  action: 'mobileModelsLibrary',
                  onAction: _openModels,
                ),
              if (busy) const LinearProgressIndicator(),
              if (failed) const Notice('mobileBotDraftFailed'),
              OutlinedButton.icon(
                onPressed: canGenerate ? _generate : null,
                icon: const Icon(Icons.auto_awesome_outlined),
                label: Text(context.tr('avatarThemeGenerate')),
              ),
              if (preview != null) ...[
                const SizedBox(height: 12),
                _DraftSummary(scope: scope, profile: preview),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () {
                    if (current && !busy && identical(preview, draft)) {
                      Navigator.pop(context, preview);
                    }
                  },
                  child: Text(context.tr('mobileBotDraftUse')),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _DraftSummary extends StatelessWidget {
  const _DraftSummary({required this.scope, required this.profile});

  final WorkspaceController scope;
  final Json profile;

  @override
  Widget build(BuildContext context) => Card(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(
          leading: BotAvatar(bot: profile, family: scope.session.avatarTheme),
          title: Text(profile['name'] as String),
          subtitle: Text(profile['role'] as String),
        ),
        if ((profile['description'] as String).isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: SelectableText(profile['description'] as String),
          ),
        if ((profile['instructions'] as String).isNotEmpty)
          ExpansionTile(
            title: Text(context.tr('instructions')),
            childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [SelectableText(profile['instructions'] as String)],
          ),
      ],
    ),
  );
}
