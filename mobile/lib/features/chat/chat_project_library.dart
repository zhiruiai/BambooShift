import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/website_project_card.dart';
import 'chat_library_links.dart';

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
        conversationLibraryLinks(messages).isEmpty) {
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
