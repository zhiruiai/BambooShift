import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/message_links.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../bots/bot_settings.dart';
import '../chat/chat_screen.dart';
import '../chat/file_preview_data.dart';
import '../chat/file_preview_screen.dart';
import '../files/website_project_client.dart';
import '../files/website_project_data.dart';
import '../files/website_project_screen.dart';
import '../routines/routine_history.dart';
import 'workspace_search_data.dart';

class WorkspaceSearchScreen extends StatefulWidget {
  const WorkspaceSearchScreen({super.key, required this.scope});
  final WorkspaceController scope;

  @override
  State<WorkspaceSearchScreen> createState() => _WorkspaceSearchScreenState();
}

class _WorkspaceSearchScreenState extends State<WorkspaceSearchScreen> {
  final input = TextEditingController();
  SearchKind? category;
  Json? snapshot;
  WorkspaceSearchIndex? index;

  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  Widget? destination(WorkspaceSearchHit hit) {
    final scope = widget.scope;
    if (!scope.active) return null;
    switch (hit.kind) {
      case SearchKind.message || SearchKind.link:
        final message = scope.find('messages', hit.id);
        if (hit.kind == SearchKind.link &&
            (message == null ||
                !messageLinks(message).any((link) => link.uri == hit.url))) {
          return null;
        }
        final conversationId = message?['conversationId'];
        if (conversationId is String &&
            scope.find('conversations', conversationId) != null) {
          return ChatScreen(
            scope: scope,
            conversationId: conversationId,
            initialMessageId: hit.id,
            threadRootId: chatThreadRoot(message),
          );
        }
      case SearchKind.bot:
        final bot = scope.find('agents', hit.id);
        if (bot == null) return null;
        final chat = scope.items('conversations').where((chat) {
          final members = chat['agentIds'];
          return chat['isGroup'] != true &&
              members is List &&
              members.length == 1 &&
              members.single == hit.id &&
              chat['id'] is String;
        }).firstOrNull;
        return chat == null
            ? BotSettings(scope: scope, bot: bot)
            : ChatScreen(scope: scope, conversationId: chat['id'] as String);
      case SearchKind.group:
        if (scope.find('conversations', hit.id)?['isGroup'] == true) {
          return ChatScreen(scope: scope, conversationId: hit.id);
        }
      case SearchKind.file:
        final row = scope.find('files', hit.id);
        if (row == null) return null;
        final conversationId = row['conversationId'];
        if (conversationId != null &&
            (conversationId is! String ||
                scope.find('conversations', conversationId) == null)) {
          return null;
        }
        final file = ChatFile.fromWorkspace(row);
        if (file != null) {
          return FilePreviewScreen(
            scope: scope,
            file: file,
            conversationId: conversationId as String?,
          );
        }
      case SearchKind.routine:
        if (scope.find('routines', hit.id) != null) {
          return RoutineHistory(scope: scope, routineId: hit.id);
        }
      case SearchKind.website:
        final message = scope.find('messages', hit.id);
        final version = message == null ? null : websiteProjectFor(message);
        if (message == null ||
            version == null ||
            message['status'] == 'running' ||
            version.id != hit.websiteVersion) {
          return null;
        }
        final client = WebsiteProjectClient(scope, message);
        if (client.active) return WebsiteProjectScreen(client: client);
    }
    return null;
  }

  void open(WorkspaceSearchHit hit) {
    final screen = destination(hit);
    if (screen == null) return;
    FocusScope.of(context).unfocus();
    Navigator.push(context, MaterialPageRoute<void>(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(context.tr('mobileSearchTitle'))),
    body: SafeArea(
      top: false,
      child: ListenableBuilder(
        listenable: Listenable.merge([widget.scope, widget.scope.session]),
        builder: (context, _) {
          final current = widget.scope.active ? widget.scope.data : null;
          if (!identical(snapshot, current)) {
            snapshot = current;
            index = current == null ? null : WorkspaceSearchIndex(current);
          }
          final results = index?.search(input.text, category);
          if (results == null) return const Notice('unavailable');
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: TextField(
                  controller: input,
                  autofocus: true,
                  maxLength: 160,
                  onChanged: (_) => setState(() {}),
                  textInputAction: TextInputAction.search,
                  style: const TextStyle(fontSize: 16),
                  decoration: InputDecoration(
                    labelText: context.tr('mobileSearchHint'),
                    prefixIcon: const Icon(Icons.search),
                    counterText: '',
                    suffixIcon: input.text.isEmpty
                        ? null
                        : IconButton(
                            tooltip: context.tr('mobileSearchClear'),
                            onPressed: () => setState(input.clear),
                            icon: const Icon(Icons.close),
                          ),
                  ),
                ),
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      for (final kind in [null, ...SearchKind.values])
                        Padding(
                          padding: const EdgeInsetsDirectional.only(end: 8),
                          child: ChoiceChip(
                            label: Text(
                              context.tr(kind?.label ?? 'mobileSearchAll'),
                            ),
                            selected: category == kind,
                            showCheckmark: false,
                            onSelected: (_) => setState(() => category = kind),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const Divider(),
              Expanded(
                child: results.hits.isEmpty
                    ? Center(child: Text(context.tr('mobileSearchEmpty')))
                    : ListView.builder(
                        key: ValueKey((input.text, category)),
                        keyboardDismissBehavior:
                            ScrollViewKeyboardDismissBehavior.onDrag,
                        padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
                        itemCount:
                            results.hits.length + (results.truncated ? 1 : 0),
                        itemBuilder: (context, i) {
                          if (i == results.hits.length) {
                            return Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(context.tr('mobileSearchTruncated')),
                            );
                          }
                          final hit = results.hits[i];
                          final snippet = hit.snippet(input.text);
                          final delivered =
                              hit.kind == SearchKind.website && hit.time > 0
                              ? DateTime.fromMillisecondsSinceEpoch(hit.time)
                              : null;
                          final locale = MaterialLocalizations.of(context);
                          return ListTile(
                            key: ValueKey(hit.key),
                            leading: Icon(_icon(hit.kind)),
                            title: Text(
                              hit.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              [
                                context.tr(hit.kind.label),
                                if (delivered != null)
                                  '${locale.formatCompactDate(delivered)} ${locale.formatTimeOfDay(TimeOfDay.fromDateTime(delivered))}',
                                if (snippet.isNotEmpty) snippet,
                              ].join(' · '),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            onTap: () => open(hit),
                          );
                        },
                      ),
              ),
            ],
          );
        },
      ),
    ),
  );
}

IconData _icon(SearchKind kind) => switch (kind) {
  SearchKind.message => Icons.chat_bubble_outline,
  SearchKind.bot => Icons.smart_toy_outlined,
  SearchKind.group => Icons.group_outlined,
  SearchKind.file => Icons.description_outlined,
  SearchKind.website => Icons.language_outlined,
  SearchKind.link => Icons.link_outlined,
  SearchKind.routine => Icons.schedule_outlined,
};
