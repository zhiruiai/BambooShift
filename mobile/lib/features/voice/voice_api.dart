import 'dart:typed_data';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';

class VoiceCall {
  const VoiceCall({
    required this.id,
    required this.started,
    required this.expires,
    required this.ended,
  });

  final String id;
  final DateTime started, expires;
  final DateTime? ended;

  static VoiceCall verify(Object? value, VoiceApi api, String id) {
    if (value is Json &&
        value['id'] == id &&
        value['conversationId'] == api.conversationId &&
        value['agentId'] == api.agentId &&
        value['userId'] == api.scope.userId) {
      final started = _date(value['startedAt']);
      final expires = _date(value['expiresAt']);
      final ended = _date(value['endedAt']);
      if (started != null &&
          expires != null &&
          expires.isAfter(started) &&
          (value['endedAt'] == null ||
              (ended != null && !ended.isBefore(started)))) {
        return VoiceCall(
          id: id,
          started: started,
          expires: expires,
          ended: ended,
        );
      }
    }
    throw const ApiException('VOICE_INVALID', 'voiceUnknown');
  }
}

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;

class VoiceApi {
  const VoiceApi(this.scope, this.conversationId, this.agentId);
  final WorkspaceController scope;
  final String conversationId, agentId;
  String get _path => '/conversations/$conversationId/voice-calls';

  Future<String?> activeId() async {
    final result = await scope.request('GET', _path);
    final call = result['call'];
    if (result.containsKey('call') && call == null) return null;
    if (call is Json &&
        isRequestId(call['id']) &&
        call['userId'] == scope.userId &&
        call['endedAt'] == null &&
        _date(call['expiresAt']) != null) {
      return call['id'] as String;
    }
    throw const ApiException('VOICE_INVALID', 'voiceUnknown');
  }

  Future<VoiceCall> begin(String id, {String? replaceId}) async {
    final result = await scope.request(
      'POST',
      _path,
      body: {'id': id, 'replaceId': ?replaceId},
    );
    return VoiceCall.verify(result['call'], this, id);
  }

  Future<VoiceCall> inspect(String id) async {
    final result = await scope.request('GET', '$_path/$id');
    return VoiceCall.verify(result['call'], this, id);
  }

  Future<void> end(String id) async {
    final result = await scope.request('POST', '$_path/$id/end', body: {});
    final call = VoiceCall.verify(result['call'], this, id);
    if (call.ended == null) {
      throw const ApiException('VOICE_INVALID', 'voiceUnknown');
    }
  }

  Future<int> recordingLimit() async {
    final status = await scope.request('GET', '/speech/status');
    if (status['available'] != true ||
        status['format'] != 'wav-pcm16-mono-16000' ||
        status['processing'] != 'server-local' ||
        status['maxSeconds'] is! int ||
        status['maxBytes'] is! int) {
      throw const ApiException('VOICE_UNAVAILABLE', 'voiceUnavailable');
    }
    final bytes = status['maxBytes'] as int;
    final seconds = (status['maxSeconds'] as int).clamp(0, 60);
    final limit = ((bytes - 44) ~/ 32000).clamp(0, seconds);
    if (limit < 1) {
      throw const ApiException('VOICE_UNAVAILABLE', 'voiceUnavailable');
    }
    return limit;
  }

  Future<String> transcribe(
    Uint8List audio,
    int limit,
    ByteReadCancellation cancellation, {
    String? voiceCallId,
  }) async {
    if (!validVoiceWave(audio, limit)) {
      throw const ApiException('VOICE_RECORDING', 'voiceRecordingFailed');
    }
    final value = await scope.session.api.requestValue(
      'POST',
      scope.path('/speech/transcribe'),
      rawBody: audio,
      rawContentType: 'audio/wav',
      voiceCallId: voiceCallId,
      expectedUser: scope.userId,
      isCurrent: () => scope.active,
      cancellation: cancellation,
      timeout: const Duration(seconds: 170),
    );
    if (value is! Json ||
        value['userId'] != scope.userId ||
        value['durationMs'] is! int ||
        (value['durationMs'] as int) < 0 ||
        (value['durationMs'] as int) > limit * 1000 ||
        value['text'] is! String ||
        (value['text'] as String).length > 30000) {
      throw const ApiException('VOICE_INVALID', 'voiceRecordingFailed');
    }
    return (value['text'] as String).trim();
  }
}

bool validVoiceWave(Uint8List audio, int limit) {
  if (audio.length < 46 ||
      audio.length > limit * 32000 + 44 ||
      audio.length.isOdd) {
    return false;
  }
  final data = ByteData.sublistView(audio);
  bool word(int offset, String expected) =>
      data.getUint32(offset) ==
      expected.codeUnits.fold(0, (value, next) => (value << 8) | next);
  int int16(int offset) => data.getUint16(offset, Endian.little);
  int int32(int offset) => data.getUint32(offset, Endian.little);
  return word(0, 'RIFF') &&
      int32(4) == audio.length - 8 &&
      word(8, 'WAVE') &&
      word(12, 'fmt ') &&
      int32(16) == 16 &&
      int16(20) == 1 &&
      int16(22) == 1 &&
      int32(24) == 16000 &&
      int32(28) == 32000 &&
      int16(32) == 2 &&
      int16(34) == 16 &&
      word(36, 'data') &&
      int32(40) == audio.length - 44;
}
