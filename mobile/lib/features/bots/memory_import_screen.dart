import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import '../chat/chat_screen.dart';
import 'memory_import_controller.dart';

class MemoryImportScreen extends StatefulWidget {
  const MemoryImportScreen({super.key, required this.scope});
  final WorkspaceController scope;
  @override
  State<MemoryImportScreen> createState() => _MemoryImportScreenState();
}

class _MemoryImportScreenState extends State<MemoryImportScreen> {
  late final model = MemoryImportController(widget.scope);
  final content = TextEditingController();
  @override
  void initState() {
    super.initState();
    unawaited(model.initialize());
  }

  @override
  void dispose() {
    content.clear();
    content.dispose();
    model.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (!model.canSubmit ||
        content.text.trim().isEmpty ||
        !await confirm(context, 'mobileKnowledgeImportConfirm')) {
      return;
    }
    if (!mounted || !widget.scope.active) return;
    if (await model.submit(content.text) && mounted) content.clear();
  }

  Future<void> acknowledge() async {
    if (!await confirm(context, 'mobileKnowledgeImportAcknowledgeConfirm')) {
      return;
    }
    if (!mounted || !widget.scope.active) return;
    if (await model.acknowledge() && mounted) Navigator.pop(context);
  }

  Future<void> abandon() async {
    if (!await confirm(context, 'mobileKnowledgeImportAbandonConfirm')) return;
    if (!mounted || !widget.scope.active) return;
    if (await model.acknowledge(abandon: true) && mounted) {
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([model, widget.scope]),
    builder: (context, _) {
      final primary = model.readiness?['primary'];
      final agentId = model.pending?['agentId'] ?? primary?['agentId'];
      final bot = agentId is String
          ? widget.scope.find('agents', agentId)
          : null;
      final chatId = model.receipt?['conversationId'];
      final chat = chatId is String
          ? widget.scope.find('conversations', chatId)
          : null;
      return Scaffold(
        appBar: AppBar(title: Text(context.tr('mobileKnowledgeImport'))),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Notice('mobileKnowledgeImportExplanation'),
            if (model.error != null) Notice(model.error!),
            if (!model.allowed) const Notice('mobileKnowledgeImportPersonal'),
            if (bot != null)
              ListTile(
                title: Text(context.tr('primaryBot')),
                subtitle: Text(bot['name'] as String? ?? ''),
              ),
            if (model.pending != null) ...[
              const Notice('mobileKnowledgeImportPending'),
              if (model.receipt != null)
                Text(
                  context.tr(
                    'mobileKnowledgeImport_${model.receipt!['status']}',
                  ),
                  style: const TextStyle(fontSize: 16),
                ),
              TextButton(
                onPressed: model.busy ? null : model.refresh,
                child: Text(context.tr('checkResult')),
              ),
              if (chat != null)
                TextButton(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => ChatScreen(
                        scope: widget.scope,
                        conversationId: chatId,
                      ),
                    ),
                  ),
                  child: Text(context.tr('mobileKnowledgeOpenImportChat')),
                ),
              if (model.receipt != null)
                TextButton(
                  onPressed: model.busy ? null : acknowledge,
                  child: Text(context.tr('mobileKnowledgeImportAcknowledge')),
                ),
              if (model.checked && model.receipt == null)
                TextButton(
                  onPressed: model.busy ? null : abandon,
                  child: Text(context.tr('mobileKnowledgeImportAbandon')),
                ),
            ] else ...[
              if (model.readiness?['available'] == false)
                const Notice('mobileKnowledgeImportNotReady'),
              TextField(
                controller: content,
                enabled: model.canSubmit,
                minLines: 7,
                maxLines: 20,
                maxLength: 16000,
                style: const TextStyle(fontSize: 16),
                decoration: InputDecoration(
                  labelText: context.tr('mobileKnowledgeImportSource'),
                ),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: model.canSubmit ? submit : null,
                child: Text(context.tr('mobileKnowledgeImportSubmit')),
              ),
              TextButton(
                onPressed: model.busy ? null : model.refresh,
                child: Text(context.tr('refresh')),
              ),
            ],
          ],
        ),
      );
    },
  );
}
