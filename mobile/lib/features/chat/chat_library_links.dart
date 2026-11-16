import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/message_links.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'chat_link_launcher.dart';
import 'chat_screen.dart';

typedef LibraryLink = ({String messageId, MessageLink link});

Iterable<LibraryLink> conversationLibraryLinks(List<Json> messages) sync* {
  final seen = <Uri>{};
  for (final message in messages.reversed) {
    final id = message['id'];
    if (id is! String) continue;
    for (final link in messageLinks(message)) {
      if (seen.add(link.uri)) yield (messageId: id, link: link);
    }
  }
}

class ChatLibraryLinks extends StatefulWidget {
  const ChatLibraryLinks({
    super.key,
    required this.scope,
    required this.conversationId,
    required this.links,
    this.launcher,
  });

  final WorkspaceController scope;
  final String conversationId;
  final Iterable<LibraryLink> links;
  final Future<bool> Function(Uri)? launcher;

  @override
  State<ChatLibraryLinks> createState() => _ChatLibraryLinksState();
}

class _ChatLibraryLinksState extends State<ChatLibraryLinks> {
  int visible = 12;

  @override
  Widget build(BuildContext context) {
    final links = widget.links.take(visible + 1).toList();
    if (links.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(
            context.tr('mobileSearchLinks'),
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
        ),
        for (final item in links.take(visible))
          ChatLibraryLinkTile(
            key: ValueKey(item.link.uri),
            scope: widget.scope,
            conversationId: widget.conversationId,
            item: item,
            launcher: widget.launcher,
          ),
        if (visible < links.length)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              onPressed: () => setState(() => visible += 12),
              child: Text(context.tr('mobileChatLibraryMoreLinks')),
            ),
          ),
      ],
    );
  }
}

class ChatLibraryLinkTile extends StatelessWidget {
  const ChatLibraryLinkTile({
    super.key,
    required this.scope,
    required this.conversationId,
    required this.item,
    this.launcher,
  });

  final WorkspaceController scope;
  final String conversationId;
  final LibraryLink item;
  final Future<bool> Function(Uri)? launcher;

  Json? _currentMessage() {
    if (!scope.active || scope.find('conversations', conversationId) == null) {
      return null;
    }
    final message = scope.find('messages', item.messageId);
    if (message == null ||
        message['conversationId'] != conversationId ||
        !messageLinks(message).any((link) => link.uri == item.link.uri)) {
      return null;
    }
    return message;
  }

  void _openSource(BuildContext context) {
    final message = _currentMessage();
    if (message == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChatScreen(
          scope: scope,
          conversationId: conversationId,
          initialMessageId: item.messageId,
          threadRootId: chatThreadRoot(message),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Semantics(
    hint: context.tr('mobileChatLibrarySourceHint'),
    child: ListTile(
      leading: const Icon(Icons.link_outlined),
      title: Text(
        item.link.label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        item.link.uri.toString(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      onTap: () => _openSource(context),
      trailing: IconButton(
        icon: const Icon(Icons.open_in_new),
        tooltip: context.tr('mobileChatLibraryOpenLink'),
        onPressed: () => openChatLink(
          context,
          item.link.uri.toString(),
          isCurrent: () => _currentMessage() != null,
          launcher: launcher,
        ),
      ),
    ),
  );
}
