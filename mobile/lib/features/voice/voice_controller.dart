import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../chat/chat_controller.dart';
import 'voice_api.dart';
import 'voice_transport.dart';
import 'voice_turn.dart';

enum VoicePhase {
  idle,
  connecting,
  listening,
  dictating,
  transcribing,
  waiting,
  speaking,
  muted,
  recovery,
}

class VoiceController extends ChangeNotifier with WidgetsBindingObserver {
  VoiceController(
    this.chat, {
    VoiceTransport transport = const VoiceTransport(),
  }) : _transport = transport {
    WidgetsBinding.instance.addObserver(this);
    chat.scope.addListener(_observe);
    chat.addListener(_observe);
  }

  final ChatController chat;
  final VoiceTransport _transport;
  VoicePhase phase = VoicePhase.idle;
  String? error;
  bool muted = false, _closed = false, _permissionPrompt = false;
  String? _id;
  VoiceApi? _api;
  VoiceCall? call;
  Json? _receipt;
  ByteReadCancellation? _transcription;
  Timer? _heartbeat;
  bool _checkingCall = false;
  int _generation = 0;
  int _limit = 60;
  String _locale = 'en';
  bool get supported => _transport.supported;
  bool get active => phase != VoicePhase.idle;
  bool get calling => _id != null;

  void _publish(VoicePhase next) {
    phase = next;
    if (!_closed) notifyListeners();
  }

  bool _current(int generation) =>
      !_closed && chat.active && generation == _generation;

  VoiceApi? _voiceApi() {
    final row = chat.scope.find('conversations', chat.conversationId);
    final ids = row?['agentIds'];
    if (ids is! List || ids.isEmpty || ids.first is! String) return null;
    return VoiceApi(chat.scope, chat.conversationId, ids.first as String);
  }

  Future<void> startCall(
    String locale, {
    required Future<bool> Function() confirmSwitch,
  }) async {
    final api = _voiceApi();
    if (!supported ||
        active ||
        !chat.active ||
        chat.threadRootId != null ||
        api == null ||
        chat.scope.find('conversations', chat.conversationId)?['isGroup'] ==
            true) {
      return;
    }
    final generation = ++_generation;
    final id = requestId();
    _id = id;
    _api = api;
    _locale = locale;
    error = null;
    _publish(VoicePhase.connecting);
    var admitted = false;
    try {
      _limit = await api.recordingLimit();
      if (!_current(generation)) return;
      final replaceId = await api.activeId();
      if (!_current(generation)) return;
      if (replaceId != null) {
        final confirmed = await confirmSwitch();
        if (!_current(generation)) return;
        if (!confirmed) {
          await _reset(end: false, report: false);
          return;
        }
      }
      await _prepare(playback: true);
      if (!_current(generation)) return;
      admitted = true;
      final result = await _begin(api, id, replaceId);
      if (!_current(generation)) {
        unawaited(_end(api, id, report: false));
        return;
      }
      if (result.ended != null || !result.expires.isAfter(DateTime.now())) {
        throw const ApiException('VOICE_CALL_ENDED', 'voiceEnded');
      }
      call = result;
      _heartbeat = Timer.periodic(const Duration(seconds: 10), (_) {
        unawaited(_checkCall(api, id));
      });
      unawaited(_listen(generation));
    } catch (failure) {
      if (!_current(generation)) {
        if (admitted) unawaited(_end(api, id, report: false));
        return;
      }
      error = _failure(failure);
      await _reset(end: admitted, report: false);
    }
  }

  Future<VoiceCall> _begin(VoiceApi api, String id, String? replaceId) async {
    try {
      return await api.begin(id, replaceId: replaceId);
    } on ApiException catch (failure) {
      if (![
        'NETWORK_UNKNOWN',
        'VOICE_INVALID',
        'INVALID_RESPONSE',
      ].contains(failure.code)) {
        rethrow;
      }
      try {
        return await api.inspect(id);
      } catch (_) {
        throw const ApiException('VOICE_UNKNOWN', 'voiceUnknown');
      }
    }
  }

  Future<void> _checkCall(VoiceApi api, String id) async {
    if (_checkingCall || _closed || _id != id) return;
    _checkingCall = true;
    try {
      final status = await api.inspect(id);
      if (_closed || _id != id) return;
      call = status;
      if (status.ended != null || !status.expires.isAfter(DateTime.now())) {
        error = 'voiceEnded';
        await _reset(end: true, report: false);
      } else if (phase == VoicePhase.waiting && chat.scope.disconnected) {
        await chat.scope.refresh();
      }
    } on ApiException catch (failure) {
      if (_closed || _id != id) return;
      final expires = call?.expires;
      if (failure.code == 'VOICE_CALL_NOT_FOUND' ||
          failure.code == 'VOICE_INVALID' ||
          (expires != null && !expires.isAfter(DateTime.now()))) {
        error = 'voiceEnded';
        await _reset(end: true, report: false);
      }
    } finally {
      _checkingCall = false;
    }
  }

  Future<void> _prepare({required bool playback}) async {
    _permissionPrompt = true;
    try {
      await _transport.prepare(playback: playback);
    } finally {
      _permissionPrompt = false;
    }
  }

  Future<void> dictation(ValueChanged<String> insert) async {
    final api = _voiceApi();
    if (!supported || active || !chat.active || api == null) return;
    final generation = ++_generation;
    error = null;
    _publish(VoicePhase.connecting);
    try {
      _limit = await api.recordingLimit();
      if (!_current(generation)) return;
      await _prepare(playback: false);
      if (!_current(generation)) return;
      _publish(VoicePhase.dictating);
      final audio = await _transport.record(automatic: false, seconds: _limit);
      if (!_current(generation)) return;
      if (audio == null) {
        error = 'voiceNoSpeech';
        _publish(VoicePhase.idle);
        return;
      }
      final transcript = await _transcribe(api, audio);
      if (!_current(generation)) return;
      if (transcript.isNotEmpty) {
        insert(transcript);
      } else {
        error = 'voiceNoSpeech';
      }
      _publish(VoicePhase.idle);
    } catch (failure) {
      if (!_current(generation)) return;
      error = _failure(failure);
      await _reset(end: false, report: false);
    }
  }

  Future<void> finishDictation() async {
    if (phase != VoicePhase.dictating) return;
    try {
      await _transport.finish();
    } on PlatformException catch (failure) {
      error = _failure(failure);
      await _reset(end: false, report: false);
    }
  }

  Future<String> _transcribe(VoiceApi api, Uint8List audio) async {
    final cancellation = ByteReadCancellation();
    _transcription = cancellation;
    _publish(VoicePhase.transcribing);
    try {
      return await api.transcribe(
        audio,
        _limit,
        cancellation,
        voiceCallId: _id,
      );
    } finally {
      if (identical(_transcription, cancellation)) _transcription = null;
    }
  }

  Future<void> _listen(int generation) async {
    final id = _id, api = _api;
    if (!_current(generation) || id == null || api == null) return;
    try {
      while (_current(generation) && !muted) {
        _publish(VoicePhase.listening);
        final audio = await _transport.record(automatic: true, seconds: _limit);
        if (!_current(generation)) return;
        if (muted) break;
        if (audio == null) continue;
        final text = await _transcribe(api, audio);
        if (!_current(generation)) return;
        if (text.isEmpty) continue;
        _receipt = null;
        _publish(VoicePhase.waiting);
        final accepted = await chat.send(text, voiceCallId: id);
        if (!_current(generation)) return;
        if (!accepted && _receipt == null) {
          if (chat.pending?['voiceCallId'] == id) {
            _publish(VoicePhase.recovery);
          } else {
            error = chat.error ?? 'voiceBusy';
            await _reset(end: true, report: false);
          }
        }
        return;
      }
      if (_current(generation)) _publish(VoicePhase.muted);
    } catch (failure) {
      if (!_current(generation)) return;
      error = _failure(failure);
      await _reset(end: true, report: false);
    }
  }

  void _observe() {
    if (_closed || !active) return;
    if (!chat.active) {
      unawaited(_reset(end: false, report: false));
      return;
    }
    final id = _id, api = _api;
    if (id == null || api == null) return;
    if (chat.busy ||
        (phase != VoicePhase.waiting && phase != VoicePhase.recovery)) {
      return;
    }
    final last = chat.lastReceipt, metadata = last?['metadata'];
    if (_receipt == null && metadata is Map && metadata['voiceCallId'] == id) {
      _receipt = last;
      _publish(VoicePhase.waiting);
    }
    final receipt = _receipt;
    if (receipt == null) {
      if (phase == VoicePhase.recovery && !chat.busy && chat.pending == null) {
        error = chat.error ?? 'voiceUnknown';
        unawaited(_reset(end: true, report: false));
      }
      return;
    }
    final reply = terminalVoiceReply(
      chat.messages,
      callId: id,
      conversationId: api.conversationId,
      agentId: api.agentId,
      receipt: receipt,
    );
    if (reply == null) return;
    if (reply['status'] != 'done') {
      error = 'voiceTurnFailed';
      unawaited(_reset(end: true, report: false));
      return;
    }
    final speech = voiceSpeakable(reply['content']);
    unawaited(_answer(_generation, speech));
  }

  Future<void> _answer(int generation, String text) async {
    _publish(VoicePhase.speaking);
    try {
      if (text.isNotEmpty) {
        final locale = RegExp(r'[\u3400-\u9fff]').hasMatch(text)
            ? 'zh'
            : _locale;
        await _transport.speak(text, locale);
      }
    } catch (failure) {
      if (_current(generation)) {
        error = _failure(failure);
        await _reset(end: true, report: false);
      }
      return;
    }
    if (_current(generation)) unawaited(_listen(generation));
  }

  Future<void> toggleMute() async {
    if (!calling || call == null) return;
    muted = !muted;
    if (muted && phase == VoicePhase.listening) {
      ++_generation;
      final generation = _generation;
      await _stop();
      if (!_current(generation) || !calling) return;
      if (muted) {
        _publish(VoicePhase.muted);
      } else {
        unawaited(_listen(generation));
      }
    } else if (!muted && phase == VoicePhase.muted) {
      unawaited(_listen(_generation));
    } else {
      _publish(phase);
    }
  }

  Future<void> interrupt() async {
    if (phase != VoicePhase.speaking) return;
    final generation = ++_generation;
    await _stop();
    if (_current(generation)) unawaited(_listen(generation));
  }

  Future<void> hangUp() => _reset(end: true, report: true);

  Future<void> _reset({required bool end, required bool report}) async {
    final id = _id, api = _api;
    final generation = ++_generation;
    _id = null;
    _api = null;
    _receipt = null;
    call = null;
    muted = false;
    _heartbeat?.cancel();
    _transcription?.cancel();
    final stopped = _stop();
    _publish(VoicePhase.idle);
    await stopped;
    if (end && id != null && api != null) {
      await _end(api, id, report: report && _current(generation));
    }
  }

  Future<void> _stop() async {
    try {
      await _transport.stop();
    } on PlatformException {
      // Native lifecycle handlers also release the audio device.
    } on MissingPluginException {
      // Widget and web environments have no native voice bridge.
    }
  }

  Future<void> _end(VoiceApi api, String id, {required bool report}) async {
    if (!api.scope.active) return;
    final generation = _generation;
    try {
      await api.end(id);
      await api.scope.refresh();
    } on ApiException catch (failure) {
      if (report &&
          _current(generation) &&
          failure.code != 'VOICE_CALL_NOT_FOUND') {
        error = _failure(failure);
        notifyListeners();
      }
    }
  }

  String _failure(Object failure) => switch (failure) {
    PlatformException(code: 'voice_permission') => 'voiceMicDenied',
    PlatformException(code: 'voice_output') => 'voiceOutputUnavailable',
    PlatformException(code: 'voice_record') => 'voiceRecordingFailed',
    ApiException(code: 'VOICE_CALL_BUSY' || 'VOICE_CALL_ACTIVE') => 'voiceBusy',
    ApiException(code: 'VOICE_CALL_ENDED' || 'VOICE_CALL_NOT_FOUND') =>
      'voiceEnded',
    ApiException(code: 'VOICE_CALL_UNAVAILABLE' || 'SPEECH_UNAVAILABLE') =>
      'voiceUnavailable',
    ApiException(code: 'SPEECH_EMPTY' || 'SPEECH_SILENT') => 'voiceNoSpeech',
    ApiException(code: 'SPEECH_ALREADY_PENDING' || 'SPEECH_BUSY') =>
      'voiceBusy',
    ApiException(code: final code) when code.startsWith('SPEECH_') =>
      'voiceRecordingFailed',
    ApiException(message: final message) => message,
    _ => 'voiceUnavailable',
  };

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (active &&
        state != AppLifecycleState.resumed &&
        (state != AppLifecycleState.inactive || !_permissionPrompt)) {
      unawaited(hangUp());
    }
  }

  @override
  void dispose() {
    _closed = true;
    WidgetsBinding.instance.removeObserver(this);
    chat.scope.removeListener(_observe);
    chat.removeListener(_observe);
    if (active) unawaited(_reset(end: true, report: false));
    super.dispose();
  }
}
