import '../../core/api.dart';

Json? terminalVoiceReply(
  Iterable<Json> messages, {
  required String callId,
  required String conversationId,
  required String agentId,
  required Json receipt,
}) {
  if (receipt['id'] is! String) return null;
  final delivery = receipt['delivery'];
  final runId = delivery is Map ? delivery['runId'] : null;
  for (final message in messages) {
    final meta = message['metadata'];
    if (message['conversationId'] == conversationId &&
        message['agentId'] == agentId &&
        message['role'] == 'assistant' &&
        message['kind'] == 'text' &&
        (message['status'] == 'done' || message['status'] == 'error') &&
        meta is Map &&
        meta['voiceCallId'] == callId &&
        meta['voiceCallTerminal'] == true &&
        meta['inputMessageId'] == receipt['id'] &&
        meta['delegation'] == null &&
        meta['runId'] is String &&
        (runId == null || meta['runId'] == runId)) {
      return message;
    }
  }
  return null;
}

String voiceSpeakable(Object? content) {
  if (content is! String) return '';
  final spoken = content
      .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
      .replaceAllMapped(
        RegExp(r'!?\[([^\]]+)\]\([^)]+\)'),
        (match) => match[1]!,
      )
      .replaceAll(RegExp(r'https?://\S+'), ' ')
      .replaceAll(RegExp(r'^[#>|\s]+', multiLine: true), '')
      .replaceAll(RegExp(r'[*_`]+'), '')
      .trim();
  if (spoken.length <= 3000) return spoken;
  final lastUnit = spoken.codeUnitAt(2999);
  return spoken.substring(
    0,
    lastUnit >= 0xd800 && lastUnit <= 0xdbff ? 2999 : 3000,
  );
}
