import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../chat/chat_markdown.dart';

class VoiceTranscriptCard extends StatefulWidget {
  const VoiceTranscriptCard({
    super.key,
    required this.scope,
    required this.message,
  });

  final WorkspaceController scope;
  final Json message;

  @override
  State<VoiceTranscriptCard> createState() => _VoiceTranscriptCardState();
}

class _VoiceTranscriptCardState extends State<VoiceTranscriptCard> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final scope = widget.scope, message = widget.message;
    final metadata = message['metadata'];
    final call = metadata is Map ? metadata['voiceCall'] : null;
    if (call is! Map ||
        !isRequestId(call['id']) ||
        call['durationMs'] is! int ||
        (call['durationMs'] as int) < 0 ||
        message['userId'] is! String ||
        !scope.active) {
      return const SizedBox.shrink();
    }
    final callId = call['id'];
    final rows = expanded
        ? _transcript(scope.items('messages'), message, callId)
        : const <Json>[];
    final duration = (call['durationMs'] as int) ~/ 1000;
    final time =
        '${duration ~/ 60}:${(duration % 60).toString().padLeft(2, '0')}';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: ExpansionTile(
        leading: const Icon(Icons.graphic_eq),
        title: Text(context.tr('voiceTranscript')),
        subtitle: Text(time),
        onExpansionChanged: (next) => setState(() => expanded = next),
        expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [
          if (expanded && rows.isEmpty)
            Text(context.tr('voiceTranscriptEmpty')),
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    row['role'] == 'user'
                        ? context.tr(
                            row['userId'] == scope.userId
                                ? 'voiceTranscriptYou'
                                : 'voiceTranscriptParticipant',
                          )
                        : scope.find(
                                    'agents',
                                    row['agentId'] as String? ?? '',
                                  )?['name']
                                  as String? ??
                              context.tr('voiceTranscriptBot'),
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                  ChatMarkdown(
                    text: row['content'] as String,
                    canOpenLink: () => scope.active,
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

List<Json> _transcript(Iterable<Json> messages, Json card, Object? callId) {
  final matching = messages.where((row) {
    final meta = row['metadata'];
    final content = row['content'];
    return row['conversationId'] == card['conversationId'] &&
        meta is Map &&
        meta['voiceCallId'] == callId &&
        row['kind'] == 'text' &&
        content is String &&
        content.trim().isNotEmpty;
  }).toList();
  final inputs = <String, Json>{
    for (final row in matching)
      if (row['role'] == 'user' &&
          row['id'] is String &&
          row['userId'] == card['userId'])
        row['id'] as String: row,
  };
  return matching.where((row) {
    if (row['role'] == 'user') return identical(inputs[row['id']], row);
    final meta = row['metadata'] as Map;
    final input = inputs[meta['inputMessageId']];
    final delivery = input?['delivery'];
    final run = delivery is Map ? delivery['runId'] : null;
    return input != null &&
        row['role'] == 'assistant' &&
        row['status'] == 'done' &&
        meta['delegation'] == null &&
        meta['voiceCallTerminal'] == true &&
        (run == null || run == meta['runId']);
  }).toList();
}
