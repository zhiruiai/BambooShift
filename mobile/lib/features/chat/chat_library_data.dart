import '../../core/api.dart';
import '../../core/message_links.dart';
import '../../core/workspace_controller.dart';
import '../files/website_project_data.dart';
import 'chat_library_links.dart';
import 'file_preview_data.dart';

enum LibraryItemKind { website, file, link }

typedef LibraryItemKey = ({LibraryItemKind kind, String target});

class LibraryItem {
  const LibraryItem(this.key, this.message, {this.link, this.media = false});

  final LibraryItemKey key;
  final Json? message;
  final LibraryLink? link;
  final bool media;

  Json pinRequest(bool pinned) => {
    'kind': key.kind.name,
    'target': key.target,
    'pinned': pinned,
    if (link != null) 'messageId': link!.messageId,
  };
}

List<LibraryItem> conversationLibraryItems(
  WorkspaceController scope,
  String conversationId,
) {
  final files = {
    for (final file in scope.items('files'))
      if (isWorkspaceScopedFile(file) ||
          file['conversationId'] == conversationId)
        file['id']: file,
  };
  final seen = <LibraryItemKey>{};
  final items = <LibraryItem>[];
  void include(LibraryItem item) {
    if (seen.add(item.key)) items.add(item);
  }

  void includeFile(Json? record, [Json? message]) {
    if (record == null) return;
    final file = ChatFile.fromWorkspace(record);
    if (file == null) return;
    include(
      LibraryItem(
        (kind: LibraryItemKind.file, target: file.id),
        message,
        media: _mediaFile(record['type'], file.extension),
      ),
    );
  }

  for (final message in scope.items('messages').reversed) {
    final messageId = message['id'];
    if (message['conversationId'] != conversationId || messageId is! String) {
      continue;
    }
    final project = websiteProjectFor(message);
    if (project != null) {
      include(
        LibraryItem((
          kind: LibraryItemKind.website,
          target: project.projectKey,
        ), message),
      );
    } else if (message case {
      'kind': 'file',
      'metadata': {'fileId': final String id},
    }) {
      includeFile(files[id], message);
    } else {
      for (final link in messageLinks(message)) {
        final uri = link.uri.normalizePath();
        final target = (uri.path.isEmpty ? uri.replace(path: '/') : uri)
            .toString();
        include(
          LibraryItem(
            (kind: LibraryItemKind.link, target: target),
            message,
            link: (messageId: messageId, link: link),
          ),
        );
      }
    }
  }
  for (final record in files.values.toList().reversed) {
    includeFile(record);
  }
  return items;
}

bool _mediaFile(Object? type, String extension) {
  final mime = type is String ? type.split(';').first.trim().toLowerCase() : '';
  if (mime.isNotEmpty && mime != 'application/octet-stream') {
    return const ['image/', 'audio/', 'video/'].any(mime.startsWith);
  }
  return const {
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'avif',
    'heic',
    'ico',
    'mp4',
    'webm',
    'mov',
    'm4v',
    'mp3',
    'wav',
    'ogg',
    'm4a',
    'aac',
    'flac',
  }.contains(extension);
}

List<LibraryItemKey> conversationLibraryPins(Json response) {
  final rows = response['pins'];
  if (rows is! List) throw const FormatException('Invalid library pins');
  final pins = <LibraryItemKey>{};
  for (final row in rows) {
    if (row case {
      'kind': final String kind,
      'target': final String target,
      'pinnedAt': final String time,
    } when target.isNotEmpty && DateTime.tryParse(time) != null) {
      final match = switch (kind) {
        'website' => LibraryItemKind.website,
        'file' => LibraryItemKind.file,
        'link' => LibraryItemKind.link,
        _ => null,
      };
      if (match != null) pins.add((kind: match, target: target));
    } else {
      throw const FormatException('Invalid library pin');
    }
  }
  return pins.toList(growable: false);
}
