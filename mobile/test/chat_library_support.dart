import 'package:flutter/material.dart';
import 'package:openbot_mobile/core/workspace_controller.dart';
import 'package:openbot_mobile/features/chat/chat_project_library.dart';
import 'package:openbot_mobile/l10n/strings.dart';

Widget libraryActionButton(WorkspaceController scope, String conversationId) =>
    Builder(
      builder: (context) => IconButton(
        onPressed: chatProjectLibraryAction(context, scope, conversationId),
        tooltip: context.tr('mobileChatLibraryTitle'),
        icon: const Icon(Icons.folder_outlined),
      ),
    );
