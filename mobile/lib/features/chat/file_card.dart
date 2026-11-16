import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../files/file_export_button.dart';
import '../files/file_export_controller.dart';
import 'file_preview_data.dart';
import 'file_preview_screen.dart';

class ChatFileCard extends StatelessWidget {
  const ChatFileCard({
    super.key,
    required this.scope,
    required this.message,
    this.exportDestination,
  }) : _fileId = null,
       _libraryConversation = null;

  const ChatFileCard.registered({
    super.key,
    required this.scope,
    required String fileId,
    required String conversationId,
    this.exportDestination,
  }) : _fileId = fileId,
       _libraryConversation = conversationId,
       message = const {};

  final WorkspaceController scope;
  final Json message;
  final FileExportDestination? exportDestination;
  final String? _fileId, _libraryConversation;

  ({ChatFile file, String? conversationId})? _current() {
    if (!scope.active) return null;
    if (_fileId case final String id) {
      final conversation = _libraryConversation!;
      final record = scope.find('files', id);
      if (record == null ||
          scope.find('conversations', conversation) == null ||
          (!isWorkspaceScopedFile(record) &&
              record['conversationId'] != conversation)) {
        return null;
      }
      final file = ChatFile.fromWorkspace(record);
      return file == null
          ? null
          : (
              file: file,
              conversationId: isWorkspaceScopedFile(record)
                  ? null
                  : conversation,
            );
    }
    final file = ChatFile.fromMessage(scope, message);
    final conversation = message['conversationId'];
    return file == null
        ? null
        : (
            file: file,
            conversationId: conversation is String ? conversation : null,
          );
  }

  @override
  Widget build(BuildContext context) {
    final current = _current();
    if (current == null) return const Notice('mobileChatFileUnavailable');
    final (:file, :conversationId) = current;
    return Card(
      child: ListTile(
        leading: Icon(
          file.image ? Icons.image_outlined : Icons.description_outlined,
        ),
        title: Text(file.name, style: const TextStyle(fontSize: 14)),
        subtitle: Text(
          '${(file.size / 1024).toStringAsFixed(1)} KB · ${context.tr(file.supported ? 'mobileChatViewFile' : 'mobileFilesDownloadOnly')}',
          style: const TextStyle(fontSize: 12),
        ),
        trailing: conversationId != null || _fileId != null
            ? FileExportButton(
                scope: scope,
                conversationId: conversationId,
                file: file,
                destination: exportDestination,
              )
            : null,
        onTap: !file.supported
            ? null
            : () {
                final latest = _current();
                if (latest == null ||
                    latest.conversationId != conversationId ||
                    latest.file.id != file.id ||
                    latest.file.name != file.name ||
                    latest.file.size != file.size) {
                  return;
                }
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => FilePreviewScreen(
                      scope: scope,
                      file: file,
                      conversationId: conversationId,
                      exportDestination: exportDestination,
                    ),
                  ),
                );
              },
      ),
    );
  }
}
