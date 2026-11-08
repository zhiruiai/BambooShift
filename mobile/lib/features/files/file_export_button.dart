import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../chat/file_preview_data.dart';
import 'file_export_controller.dart';
import 'file_export_platform.dart';

class FileExportButton extends StatefulWidget {
  const FileExportButton({
    super.key,
    required this.scope,
    required this.conversationId,
    required this.file,
    this.destination,
  });
  final WorkspaceController scope;
  final String? conversationId;
  final ChatFile file;
  final FileExportDestination? destination;

  @override
  State<FileExportButton> createState() => _FileExportButtonState();
}

class _FileExportButtonState extends State<FileExportButton> {
  late FileExportController controller;

  @override
  void initState() {
    super.initState();
    _create();
  }

  void _create() {
    controller = FileExportController(
      widget.scope,
      widget.conversationId,
      widget.file,
      widget.destination ?? NativeFileExport(),
    );
  }

  @override
  void didUpdateWidget(covariant FileExportButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scope != widget.scope ||
        oldWidget.conversationId != widget.conversationId ||
        oldWidget.file.id != widget.file.id ||
        oldWidget.file.name != widget.file.name ||
        oldWidget.file.size != widget.file.size ||
        oldWidget.destination != widget.destination) {
      controller.dispose();
      _create();
    }
  }

  Future<void> _export(BuildContext buttonContext) async {
    final current = controller;
    final box = buttonContext.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return;
    final origin = box.localToGlobal(Offset.zero) & box.size;
    await current.export(origin);
    if (!mounted || current != controller || !current.active) return;
    final message = current.error ?? current.notice;
    if (message == null) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          context.tr(message),
          style: const TextStyle(fontSize: 14),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => Builder(
      builder: (buttonContext) => IconButton(
        tooltip: context.tr(
          !controller.destination.supported
              ? 'mobileFilesExportUnavailable'
              : widget.file.size > fileExportLimit
              ? 'mobileFilesLimit'
              : 'mobileFilesExport',
        ),
        onPressed: controller.canExport
            ? () => unawaited(_export(buttonContext))
            : null,
        icon: controller.busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.save_alt),
      ),
    ),
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }
}
