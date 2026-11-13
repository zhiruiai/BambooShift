import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/avatar_palette.dart';
import '../../core/bot_access.dart';
import '../../core/creation_controller.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import '../bot_library/original_bot_templates.dart';
import 'bot_draft_screen.dart';
import 'bot_form.dart';
import '../collaboration/team_plans_screen.dart';

class CreateScreen extends StatefulWidget {
  const CreateScreen({
    super.key,
    required this.scope,
    required this.kind,
    this.initialProfile,
  });
  final WorkspaceController scope;
  final String kind;
  final Json? initialProfile;
  @override
  State<CreateScreen> createState() => _CreateScreenState();
}

class _CreateScreenState extends State<CreateScreen> {
  late final CreationController controller;
  final form = GlobalKey<FormState>();
  final title = TextEditingController();
  Json profile = {
    'name': '',
    'role': '',
    'description': '',
    'instructions': '',
    'avatar': 'orb',
    'color': defaultAvatarColor,
  };
  final List<String> selected = [];
  int profileRevision = 0;
  bool profileEdited = false;
  bool get editable =>
      controller.ready && !controller.busy && controller.pending == null;
  bool get canEdit =>
      widget.scope.active &&
      (widget.kind != 'bot' || widget.scope.owner) &&
      editable;
  @override
  void initState() {
    super.initState();
    final initial = widget.initialProfile;
    if (widget.kind == 'bot' && initial != null) {
      profile = Map.of(initial);
    }
    controller = CreationController(widget.scope, widget.kind);
    unawaited(controller.initialize());
  }

  @override
  void dispose() {
    controller.dispose();
    title.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!canEdit) return;
    if (!form.currentState!.validate()) return;
    if (widget.kind == 'group' &&
        (selected.length < 2 || selected.length > 6)) {
      return;
    }
    await controller.start(
      widget.kind == 'bot'
          ? {'profile': profile}
          : {'title': title.text.trim(), 'agentIds': selected.toList()},
    );
    await _finish();
  }

  Future<void> _finish() async {
    final receipt = controller.receipt;
    if (!mounted || receipt == null || receipt['status'] != 'created') return;
    widget.scope.acceptCreation(receipt);
    await controller.finish();
    unawaited(widget.scope.refresh());
    if (mounted && widget.scope.active) {
      Navigator.pop(context, receipt['conversationId'] as String);
    }
  }

  Future<void> _loadProfile(
    Future<Json?> Function() choose,
    String replaceNotice,
  ) async {
    final scope = widget.scope;
    final original = profile;
    bool current() =>
        mounted &&
        identical(scope, widget.scope) &&
        identical(original, profile) &&
        canEdit;
    if (!current()) return;
    final next = await choose();
    if (!mounted || next == null || !current()) return;
    if ((profileEdited ||
            profileRevision > 0 ||
            widget.initialProfile != null) &&
        !await confirm(context, replaceNotice)) {
      return;
    }
    if (!current()) return;
    setState(() {
      profile = next;
      profileEdited = false;
      profileRevision++;
    });
  }

  Future<void> _browseOriginals() => _loadProfile(
    () => previewOriginalBotTemplates(context, widget.scope),
    'mobileStarterReplace',
  );

  Future<void> _draftBot() => _loadProfile(
    () => Navigator.push<Json>(
      context,
      MaterialPageRoute<Json>(
        settings: const RouteSettings(name: '/bots/new/draft'),
        builder: (_) => BotDraftScreen(scope: widget.scope),
      ),
    ),
    'mobileBotDraftReplace',
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      controller,
      widget.scope,
      widget.scope.session,
    ]),
    builder: (context, _) {
      final bots = widget.scope.items('agents').where(botAvailable).toList();
      return Scaffold(
        appBar: AppBar(
          title: Text(context.tr(widget.kind == 'bot' ? 'newBot' : 'newGroup')),
        ),
        body: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (widget.scope.owner)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.groups_outlined),
                    title: Text(context.tr('mobileCollaborationTitle')),
                    subtitle: Text(context.tr('mobileCollaborationIntro')),
                    enabled: editable && widget.scope.active,
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => TeamPlansScreen(scope: widget.scope),
                      ),
                    ),
                  ),
                ),
              if (controller.error != null) Notice(controller.error!),
              if (controller.pending != null) ...[
                Notice(
                  'pendingCreation',
                  action: 'checkResult',
                  onAction: controller.busy
                      ? null
                      : () async {
                          await controller.check();
                          await _finish();
                        },
                ),
                Wrap(
                  spacing: 12,
                  children: [
                    TextButton(
                      onPressed: controller.busy
                          ? null
                          : () async {
                              await controller.retry();
                              await _finish();
                            },
                      child: Text(context.tr('retry')),
                    ),
                    TextButton(
                      onPressed: controller.busy
                          ? null
                          : () async {
                              await controller.cancel();
                              await _finish();
                            },
                      child: Text(context.tr('closeRequest')),
                    ),
                  ],
                ),
              ],
              if (controller.receipt?['status'] == 'missing')
                Notice(
                  'savedRequestMissing',
                  action: 'done',
                  onAction: () => controller.finish(),
                ),
              if (widget.kind == 'bot') ...[
                if (widget.scope.owner) ...[
                  OutlinedButton.icon(
                    onPressed: canEdit ? _draftBot : null,
                    icon: const Icon(Icons.auto_awesome_outlined),
                    label: Text(context.tr('mobileBotDraftTitle')),
                  ),
                  OutlinedButton.icon(
                    onPressed: canEdit ? _browseOriginals : null,
                    icon: const Icon(Icons.library_books_outlined),
                    label: Text(context.tr('mobileStarterBrowse')),
                  ),
                ],
                const SizedBox(height: 12),
                BotForm(
                  key: ValueKey(profileRevision),
                  initial: profile,
                  enabled: canEdit,
                  family: widget.scope.session.avatarTheme,
                  avatarScope: widget.scope.owner ? widget.scope : null,
                  onChanged: (value) {
                    profile = value;
                    profileEdited = true;
                  },
                ),
              ] else ...[
                TextFormField(
                  controller: title,
                  enabled: editable,
                  maxLength: 100,
                  decoration: InputDecoration(
                    labelText: context.tr('groupName'),
                  ),
                  validator: (value) => (value ?? '').trim().isEmpty
                      ? context.tr('required')
                      : null,
                ),
                const SizedBox(height: 12),
                Text(context.tr('groupSize')),
                const SizedBox(height: 12),
                for (final bot in bots)
                  CheckboxListTile(
                    value: selected.contains(bot['id']),
                    onChanged: !editable
                        ? null
                        : (yes) {
                            setState(() {
                              if (yes == true && selected.length < 6) {
                                selected.add(bot['id'] as String);
                              } else {
                                selected.remove(bot['id']);
                              }
                            });
                          },
                    secondary: BotAvatar(
                      bot: bot,
                      family: widget.scope.session.avatarTheme,
                      scope: widget.scope,
                    ),
                    title: Text(bot['name'] as String? ?? ''),
                    subtitle: Text(
                      '${bot['role'] ?? ''}${selected.firstOrNull == bot['id'] ? ' · ${context.tr('lead')}' : ''}',
                    ),
                  ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed:
                    canEdit && (widget.kind == 'bot' || selected.length >= 2)
                    ? _save
                    : null,
                child: Text(context.tr('create')),
              ),
            ],
          ),
        ),
      );
    },
  );
}
