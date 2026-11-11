import 'package:flutter/material.dart';

import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'attachment_controller.dart';
import 'file_preview_data.dart';
import 'file_preview_screen.dart';

class AttachmentPanel extends StatelessWidget {
  const AttachmentPanel({
    super.key,
    required this.controller,
    this.compact = false,
    this.skillAction,
  });
  final AttachmentController controller;
  final bool compact;
  final Widget? skillAction;
  String size(int bytes) =>
      bytes < 1024 ? '$bytes B' : '${(bytes / 1024).toStringAsFixed(1)} KB';
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final c = controller;
      if (!c.active) return const SizedBox();
      if (compact) {
        return Align(
          alignment: AlignmentDirectional.centerStart,
          child: Wrap(
            spacing: 8,
            children: [
              TextButton.icon(
                icon: const Icon(Icons.attach_file, size: 18),
                label: Text(
                  context.tr('mobileFilesReview'),
                  style: const TextStyle(fontSize: 12),
                ),
                onPressed: () {
                  FocusManager.instance.primaryFocus?.unfocus();
                  showModalBottomSheet<void>(
                    context: context,
                    builder: (_) =>
                        SafeArea(child: AttachmentPanel(controller: c)),
                  );
                },
              ),
              ?skillAction,
            ],
          ),
        );
      }
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 240),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    TextButton.icon(
                      onPressed: c.canPick ? c.choose : null,
                      icon: const Icon(Icons.attach_file),
                      label: Text(context.tr('mobileFilesChoose')),
                    ),
                    ?skillAction,
                    if (c.busy)
                      const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    if (c.files.isNotEmpty)
                      Text(
                        context.tr('mobileFilesReady'),
                        style: const TextStyle(fontSize: 12),
                      ),
                  ],
                ),
                if (c.error != null) Notice(c.error!),
                for (final selection in c.selections)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            selection.name,
                            style: const TextStyle(fontSize: 14),
                          ),
                          Text(
                            size(selection.size),
                            style: const TextStyle(fontSize: 12),
                          ),
                          Text(
                            context.tr('mobileFilesUploadHelp'),
                            style: const TextStyle(fontSize: 12),
                          ),
                          Wrap(
                            spacing: 8,
                            children: [
                              FilledButton(
                                onPressed: c.canUpload
                                    ? () => c.upload(selection)
                                    : null,
                                child: Text(context.tr('mobileFilesUpload')),
                              ),
                              TextButton(
                                onPressed: c.canEdit
                                    ? () => c.removeSelection(selection)
                                    : null,
                                child: Text(context.tr('mobileFilesRemove')),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                for (final file in c.files)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      file['name'],
                      style: const TextStyle(fontSize: 14),
                    ),
                    subtitle: Text(
                      size(file['size']),
                      style: const TextStyle(fontSize: 12),
                    ),
                    trailing: IconButton(
                      tooltip: context.tr('mobileFilesRemoveReference'),
                      onPressed: c.canEdit
                          ? () => c.removeFile(file['id'])
                          : null,
                      icon: const Icon(Icons.close),
                    ),
                  ),
                if (c.pending != null) ...[
                  Notice(
                    'mobileFilesUnknown',
                    action: 'checkResult',
                    onAction: c.busy ? null : c.check,
                  ),
                  for (final file in c.candidates.take(20))
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${file['name']} · ${size(file['size'])}',
                              style: const TextStyle(fontSize: 14),
                            ),
                            Wrap(
                              spacing: 8,
                              children: [
                                if (ChatFile(
                                  file['id'],
                                  file['name'],
                                  file['size'],
                                ).supported)
                                  TextButton(
                                    onPressed: () {
                                      if (!c.active) return;
                                      Navigator.push(
                                        context,
                                        MaterialPageRoute<void>(
                                          builder: (_) => FilePreviewScreen(
                                            scope: c.scope,
                                            file: ChatFile(
                                              file['id'],
                                              file['name'],
                                              file['size'],
                                            ),
                                          ),
                                        ),
                                      );
                                    },
                                    child: Text(
                                      context.tr('mobileFilesInspect'),
                                    ),
                                  ),
                                TextButton(
                                  onPressed: c.canEdit
                                      ? () async {
                                          if (await confirm(
                                            context,
                                            'mobileFilesUseConfirm',
                                          )) {
                                            await c.useCandidate(file['id']);
                                          }
                                        }
                                      : null,
                                  child: Text(context.tr('mobileFilesUse')),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  TextButton(
                    onPressed: c.canEdit
                        ? () async {
                            if (await confirm(
                              context,
                              'mobileFilesAbandonConfirm',
                            )) {
                              await c.abandon();
                            }
                          }
                        : null,
                    child: Text(context.tr('mobileFilesAbandon')),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    },
  );
}
