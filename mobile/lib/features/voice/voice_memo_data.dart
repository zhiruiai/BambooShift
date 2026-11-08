import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/byte_read.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import 'voice_api.dart';

bool canRequestVoiceMemo(
  WorkspaceController scope,
  String conversationId,
  String? threadRootId,
  ChatDraftOptions options,
) {
  final capability = scope.data?['voiceMemo'];
  if (!scope.active ||
      capability is! Map ||
      capability['available'] != true ||
      scope.session.workspace?['kind'] != 'personal' ||
      !scope.owner ||
      threadRootId != null ||
      options != emptyChatOptions ||
      scope.data?['settings']?['configured'] != true) {
    return false;
  }
  final chat = scope.find('conversations', conversationId);
  final members = chat?['agentIds'];
  if (chat?['isGroup'] == true ||
      members is! List ||
      members.length != 1 ||
      members.single is! String) {
    return false;
  }
  final bot = scope.find('agents', members.single as String);
  return bot != null && !isManagedBot(bot);
}

@immutable
class VoiceMemo {
  const VoiceMemo({
    required this.messageId,
    required this.conversationId,
    required this.fileId,
    required this.name,
    required this.size,
    required this.sha,
    required this.transcript,
    required this.durationMs,
    required this.available,
  });

  final String messageId, conversationId, fileId, name, sha, transcript;
  final int size, durationMs;
  final bool available;

  static VoiceMemo? fromMessage(WorkspaceController scope, Json message) {
    final metadata = message['metadata'];
    if (!scope.active ||
        message['kind'] != 'file' ||
        message['role'] != 'assistant' ||
        metadata is! Map ||
        !isChatReference(message['id']) ||
        !isChatReference(message['conversationId']) ||
        !isChatReference(metadata['fileId'])) {
      return null;
    }
    final memo = metadata['voiceMemo'];
    if (memo is! Map) return null;
    final duration = memo['durationMs'], transcript = memo['transcript'];
    final digest = metadata['sha256'], size = metadata['size'];
    final name = metadata['name'];
    final conversation = message['conversationId'] as String;
    final fileId = metadata['fileId'] as String;
    final file = scope.find('files', fileId);
    if (duration is! int ||
        duration < 1 ||
        duration > 60000 ||
        transcript is! String ||
        transcript.trim().isEmpty ||
        transcript.length > 500 ||
        digest is! String ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(digest) ||
        name is! String ||
        name.trim().isEmpty ||
        name.length > 160 ||
        size is! int ||
        size < 46 ||
        size > 2 * 1024 * 1024) {
      return null;
    }
    return VoiceMemo(
      messageId: message['id'] as String,
      conversationId: conversation,
      fileId: fileId,
      name: name,
      size: size,
      sha: digest,
      transcript: transcript,
      durationMs: duration,
      available:
          file?['type'] == 'audio/wav' &&
          file?['name'] == name &&
          file?['sha256'] == digest &&
          file?['size'] == size &&
          file?['conversationId'] == conversation,
    );
  }

  bool stillAvailable(WorkspaceController scope) {
    final row = scope.find('messages', messageId);
    final current = row == null ? null : VoiceMemo.fromMessage(scope, row);
    return current?.available == true &&
        current?.fileId == fileId &&
        current?.conversationId == conversationId &&
        current?.sha == sha &&
        current?.durationMs == durationMs &&
        current?.size == size;
  }

  bool validAudio(FileBytes file) =>
      file.mimeType == 'audio/wav' &&
      file.bytes.length == size &&
      validVoiceWave(file.bytes, 60) &&
      (file.bytes.length - 44) ~/ 32 == durationMs &&
      sha256.convert(file.bytes).toString() == sha;
}
