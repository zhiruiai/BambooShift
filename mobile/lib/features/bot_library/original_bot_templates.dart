import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';
import '../../widgets/common.dart';
import 'original_bot_template_data.dart';

Future<Json?> previewOriginalBotTemplates(
  BuildContext context,
  WorkspaceController scope,
) => Navigator.push<Json>(
  context,
  MaterialPageRoute(builder: (_) => _OriginalBotCatalog(scope: scope)),
);

class _OriginalBotCatalog extends StatefulWidget {
  const _OriginalBotCatalog({required this.scope});

  final WorkspaceController scope;

  @override
  State<_OriginalBotCatalog> createState() => _OriginalBotCatalogState();
}

class _OriginalBotCatalogState extends State<_OriginalBotCatalog> {
  final search = TextEditingController();
  String category = '';
  String? language;
  late Future<List<OriginalBotTemplate>> catalog;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final locale = Localizations.localeOf(context).languageCode;
    if (locale == language) return;
    language = locale;
    catalog = loadOriginalBotTemplates(locale);
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> review(OriginalBotTemplate template) async {
    final scope = widget.scope;
    if (!scope.active) return;
    FocusScope.of(context).unfocus();
    final selected = await Navigator.push<Json>(
      context,
      MaterialPageRoute(
        builder: (_) => _OriginalBotReview(scope: scope, template: template),
      ),
    );
    if (mounted && scope.active && scope.owner && selected != null) {
      Navigator.pop(context, selected);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('mobileStarterTitle'))),
    body: ListenableBuilder(
      listenable: widget.scope.session,
      builder: (context, _) => !widget.scope.active
          ? const Notice('scopeChanged')
          : FutureBuilder(
              future: catalog,
              builder: (context, snapshot) {
                if (snapshot.hasError) return const Notice('requestFailed');
                final templates = snapshot.data;
                if (templates == null) return const LinearProgressIndicator();
                return ListView(
                  padding: const EdgeInsets.all(16),
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  children: [
                    Text(context.tr('mobileStarterHelp')),
                    const SizedBox(height: 12),
                    TextField(
                      controller: search,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileStarterSearch'),
                        prefixIcon: const Icon(Icons.search),
                      ),
                      textInputAction: TextInputAction.search,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: category,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: context.tr('mobileStarterCategory'),
                      ),
                      items: [
                        DropdownMenuItem(
                          value: '',
                          child: Text(context.tr('mobileStarterAll')),
                        ),
                        for (final template in templates)
                          DropdownMenuItem(
                            value: template.id,
                            child: Text(template.category),
                          ),
                      ],
                      onChanged: (value) =>
                          setState(() => category = value ?? ''),
                    ),
                    const SizedBox(height: 12),
                    ...results(templates),
                    const SizedBox(height: 12),
                    Text(context.tr('mobileStarterNotice')),
                  ],
                );
              },
            ),
    ),
  );

  List<Widget> results(List<OriginalBotTemplate> templates) {
    final visible = filterOriginalBotTemplates(
      templates,
      search.text,
      category,
    );
    if (visible.isEmpty) return [const Notice('mobileStarterEmpty')];
    return [
      for (final template in visible)
        Card(
          key: ValueKey(template.id),
          child: ListTile(
            leading: BotAvatar(
              bot: template.profile,
              family: widget.scope.session.avatarTheme,
              size: 40,
            ),
            title: Text(template.profile['name'] as String),
            subtitle: Text(
              '${template.category}\n${template.profile['description']}',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => review(template),
          ),
        ),
    ];
  }
}

class _OriginalBotReview extends StatelessWidget {
  const _OriginalBotReview({required this.scope, required this.template});

  final WorkspaceController scope;
  final OriginalBotTemplate template;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: scope.session,
    builder: (context, _) {
      final profile = template.profile;
      return Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileStarterReview'))),
        body: !scope.active
            ? const Notice('scopeChanged')
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Row(
                    children: [
                      BotAvatar(
                        bot: profile,
                        family: scope.session.avatarTheme,
                        size: 56,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              profile['name'] as String,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            Text(profile['role'] as String),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Text(profile['description'] as String),
                  const SizedBox(height: 20),
                  Text(
                    context.tr('instructions'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  SelectableText(profile['instructions'] as String),
                ],
              ),
        bottomNavigationBar: !scope.active
            ? null
            : SafeArea(
                top: false,
                minimum: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: scope.owner
                    ? FilledButton(
                        onPressed: () {
                          if (scope.active && scope.owner) {
                            Navigator.pop(
                              context,
                              Map<String, dynamic>.of(profile),
                            );
                          }
                        },
                        child: Text(context.tr('mobileStarterUse')),
                      )
                    : Text(context.tr('mobileStarterReadOnly')),
              ),
      );
    },
  );
}
