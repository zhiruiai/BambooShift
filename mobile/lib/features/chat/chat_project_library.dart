import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/website_project_card.dart';
import 'chat_library_links.dart';
import 'file_card.dart';
import 'file_preview_data.dart';

Iterable<Json> _conversationFileMessages(
  WorkspaceController scope,
  List<Json> messages,
) sync* {
  final seen = <String>{};
  for (final message in messages.reversed) {
    final file = ChatFile.fromMessage(scope, message);
    if (file != null && seen.add(file.id)) yield message;
  }
}

class ChatProjectLibrary extends StatelessWidget {
  const ChatProjectLibrary(this.scope, this.conversationId, {super.key});

  final WorkspaceController scope;
  final String conversationId;

  List<Json> get _messages =>
      scope.active && scope.find('conversations', conversationId) != null
      ? scope
            .items('messages')
            .where((message) => message['conversationId'] == conversationId)
            .toList()
      : const [];

  @override
  Widget build(BuildContext context) {
    final messages = _messages;
    if (!messages.any((message) => websiteProjectFor(message) != null) &&
        conversationLibraryLinks(messages).isEmpty &&
        _conversationFileMessages(scope, messages).isEmpty) {
      return const SizedBox.shrink();
    }
    return IconButton(
      tooltip: context.tr('mobileChatLibraryTitle'),
      icon: const Icon(Icons.folder_outlined),
      onPressed: () {
        if (!scope.active ||
            scope.find('conversations', conversationId) == null) {
          return;
        }
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (context) => Scaffold(
              appBar: AppBar(title: Text(context.tr('mobileChatLibraryTitle'))),
              body: ListenableBuilder(
                listenable: Listenable.merge([scope, scope.session]),
                builder: (context, _) {
                  if (!scope.active ||
                      scope.find('conversations', conversationId) == null) {
                    return Center(child: Text(context.tr('scopeChanged')));
                  }
                  final messages = _messages;
                  return ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      WebsiteProjectLibrary(scope: scope, messages: messages),
                      _ChatLibraryFiles(
                        scope: scope,
                        messages: _conversationFileMessages(scope, messages),
                      ),
                      ChatLibraryLinks(
                        scope: scope,
                        conversationId: conversationId,
                        links: conversationLibraryLinks(messages),
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ChatLibraryFiles extends StatefulWidget {
  const _ChatLibraryFiles({required this.scope, required this.messages});
  final WorkspaceController scope;
  final Iterable<Json> messages;

  @override
  State<_ChatLibraryFiles> createState() => _ChatLibraryFilesState();
}

class _ChatLibraryFilesState extends State<_ChatLibraryFiles> {
  static const pageSize = 12;
  int visible = pageSize;

  @override
  Widget build(BuildContext context) {
    final messages = widget.messages.take(visible + 1).toList();
    if (messages.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(
            context.tr('mobileSearchFiles'),
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
        ),
        for (final message in messages.take(visible))
          ChatFileCard(
            key: ValueKey(message['metadata']['fileId']),
            scope: widget.scope,
            message: message,
          ),
        if (visible < messages.length)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              onPressed: () => setState(() => visible += pageSize),
              child: Text(context.tr('mobileChatLibraryMoreFiles')),
            ),
          ),
      ],
    );
  }
}
