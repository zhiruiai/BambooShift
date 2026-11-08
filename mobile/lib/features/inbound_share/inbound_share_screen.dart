import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/common.dart';
import 'inbound_share_data.dart';
import 'inbound_share_draft.dart';
import 'inbound_share_inbox.dart';

class InboundShareScreen extends StatefulWidget {
  const InboundShareScreen({
    super.key,
    required this.scope,
    required this.inbox,
    required this.packet,
  });
  final WorkspaceController scope;
  final InboundShareInbox inbox;
  final InboundSharePacket packet;

  @override
  State<InboundShareScreen> createState() => _InboundShareScreenState();
}

class _InboundShareScreenState extends State<InboundShareScreen> {
  late final fileIds = widget.packet.files.map((file) => file.id).toSet();
  late bool includeText = widget.packet.text != null;
  String query = '';
  String? conversationId, error;
  bool busy = false;
  bool get active =>
      widget.scope.active && widget.inbox.contains(widget.packet);

  Future<void> attach() async {
    final id = conversationId;
    if (!active || busy || id == null || (!includeText && fileIds.isEmpty)) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await attachInboundShare(
        scope: widget.scope,
        inbox: widget.inbox,
        packet: widget.packet,
        conversationId: id,
        includeText: includeText,
        fileIds: Set.of(fileIds),
        isCurrent: () => mounted,
      );
      if (mounted && widget.scope.active) Navigator.of(context).pop(id);
    } catch (cause) {
      if (mounted) {
        setState(
          () => error = cause is ApiException
              ? cause.message
              : 'mobileInboundReadFailed',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void discard() {
    if (!active || busy) return;
    widget.inbox.finish(widget.packet, () {});
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.scope,
      widget.scope.session,
      widget.inbox,
    ]),
    builder: (context, _) {
      final packet = widget.packet;
      final chats = widget.scope
          .items('conversations')
          .where(
            (chat) =>
                isChatReference(chat['id']) &&
                chat['title'] is String &&
                (chat['title'] as String).toLowerCase().contains(query),
          )
          .toList();
      final selected = widget.scope.find('conversations', conversationId ?? '');
      return PopScope(
        canPop: !busy,
        child: Scaffold(
          appBar: AppBar(title: Text(context.tr('mobileInboundTitle'))),
          bottomNavigationBar: active
              ? SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                    child: FilledButton.icon(
                      onPressed:
                          !busy &&
                              selected != null &&
                              (includeText || fileIds.isNotEmpty)
                          ? attach
                          : null,
                      icon: busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.attach_file),
                      label: Text(context.tr('mobileInboundAttach')),
                    ),
                  ),
                )
              : null,
          body: SafeArea(
            top: false,
            child: !active
                ? const Notice('scopeChanged')
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(
                        context.tr('mobileInboundHelp'),
                        style: const TextStyle(fontSize: 14),
                      ),
                      if (packet.warning case final warning?) Notice(warning),
                      if (error case final failure?) Notice(failure),
                      if (packet.text case final text?)
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          value: includeText,
                          title: Text(context.tr('mobileInboundText')),
                          subtitle: Text(
                            text,
                            maxLines: 5,
                            overflow: TextOverflow.ellipsis,
                          ),
                          onChanged: busy
                              ? null
                              : (checked) => setState(
                                  () => includeText = checked == true,
                                ),
                        ),
                      for (final file in packet.files)
                        CheckboxListTile(
                          key: ValueKey(file.id),
                          contentPadding: EdgeInsets.zero,
                          value: fileIds.contains(file.id),
                          title: Text(
                            file.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            '${(file.size / 1024).toStringAsFixed(1)} KB',
                          ),
                          onChanged: busy
                              ? null
                              : (checked) => setState(() {
                                  if (checked == true) {
                                    fileIds.add(file.id);
                                  } else {
                                    fileIds.remove(file.id);
                                  }
                                }),
                        ),
                      const Divider(),
                      TextField(
                        enabled: !busy,
                        maxLength: 100,
                        decoration: InputDecoration(
                          counterText: '',
                          prefixIcon: const Icon(Icons.search),
                          labelText: context.tr('mobileInboundChooseChat'),
                        ),
                        onChanged: (value) =>
                            setState(() => query = value.trim().toLowerCase()),
                      ),
                      if (chats.isEmpty) const Notice('mobileInboundNoChat'),
                      RadioGroup<String>(
                        groupValue: conversationId,
                        onChanged: (id) {
                          if (!busy) {
                            setState(() {
                              conversationId = id;
                              error = null;
                            });
                          }
                        },
                        child: Column(
                          children: [
                            for (final chat in chats)
                              RadioListTile<String>(
                                value: chat['id'] as String,
                                enabled: !busy,
                                contentPadding: EdgeInsets.zero,
                                title: Text(
                                  chat['title'] as String,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                        ),
                      ),
                      TextButton(
                        onPressed: busy ? null : discard,
                        child: Text(context.tr('mobileInboundDiscard')),
                      ),
                    ],
                  ),
          ),
        ),
      );
    },
  );
}
