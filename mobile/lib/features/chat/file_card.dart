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
  });
  final WorkspaceController scope;
  final Json message;
  final FileExportDestination? exportDestination;
  @override
  Widget build(BuildContext context) {
    final file = ChatFile.fromMessage(scope, message);
    if (file == null) return const Notice('mobileChatFileUnavailable');
    final conversationId = message['conversationId'];
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
        trailing: conversationId is String
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
                if (!scope.active ||
                    ChatFile.fromMessage(scope, message)?.id != file.id) {
                  return;
                }
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => FilePreviewScreen(
                      scope: scope,
                      file: file,
                      conversationId: conversationId is String
                          ? conversationId
                          : null,
                      exportDestination: exportDestination,
                    ),
                  ),
                );
              },
      ),
    );
  }
}
