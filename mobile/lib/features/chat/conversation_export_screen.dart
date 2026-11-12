import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/file_export_platform.dart';
import 'conversation_export_controller.dart';

class ConversationExportScreen extends StatefulWidget {
  const ConversationExportScreen({
    super.key,
    required this.scope,
    required this.conversationId,
  });
  final WorkspaceController scope;
  final String conversationId;
  @override
  State<ConversationExportScreen> createState() =>
      _ConversationExportScreenState();
}

class _ConversationExportScreenState extends State<ConversationExportScreen> {
  late final controller = ConversationExportController(
    widget.scope,
    widget.conversationId,
    NativeFileExport(),
  );
  bool started = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!started) {
      started = true;
      prepare();
    }
  }

  void prepare() => controller.prepare(
    Localizations.localeOf(context).languageCode == 'zh' ? 'zh-CN' : 'en',
  );
  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: Text(context.tr('exportTitle'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(context.tr('exportDescription')),
          const SizedBox(height: 20),
          if (controller.busy) ...[
            const LinearProgressIndicator(),
            const SizedBox(height: 12),
            Text(context.tr('exportPreparing')),
          ],
          if (controller.messageCount != null)
            Text(
              context
                  .tr('exportCount')
                  .replaceAll('{count}', '${controller.messageCount}'),
            ),
          if (controller.error != null)
            Text(
              context.tr(controller.error!),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          if (controller.notice != null) Text(context.tr(controller.notice!)),
          const SizedBox(height: 20),
          Builder(
            builder: (buttonContext) => FilledButton.icon(
              onPressed: controller.canExport
                  ? () {
                      final box =
                          buttonContext.findRenderObject() as RenderBox?;
                      final origin = box == null
                          ? const Rect.fromLTWH(0, 0, 1, 1)
                          : box.localToGlobal(Offset.zero) & box.size;
                      controller.export(origin);
                    }
                  : null,
              icon: const Icon(Icons.ios_share),
              label: Text(context.tr('exportShare')),
            ),
          ),
          if (!controller.busy && controller.messageCount == null)
            TextButton(
              onPressed: controller.active ? prepare : null,
              child: Text(context.tr('refresh')),
            ),
          TextButton(
            onPressed: () {
              controller.cancel();
              Navigator.pop(context);
            },
            child: Text(context.tr('exportClose')),
          ),
        ],
      ),
    ),
  );
}
