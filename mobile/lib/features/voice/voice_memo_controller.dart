import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'voice_memo_data.dart';
import 'voice_memo_transport.dart';

class VoiceMemoController extends ChangeNotifier with WidgetsBindingObserver {
  VoiceMemoController(this.scope, {VoiceMemoTransport? transport})
    : _transport = transport ?? VoiceMemoTransport() {
    WidgetsBinding.instance.addObserver(this);
    scope.addListener(_observe);
  }

  final WorkspaceController scope;
  final VoiceMemoTransport _transport;
  VoiceMemo? _memo;
  String? _session;
  ByteReadCancellation? _read;
  Timer? _poll;
  bool _closed = false, _checking = false;
  bool busy = false, playing = false;
  int positionMs = 0;
  String? failedId;
  String? get selectedId => _memo?.messageId;
  bool get supported => _transport.supported;

  bool _current(String session) =>
      !_closed &&
      scope.active &&
      _session == session &&
      _memo?.stillAvailable(scope) == true;

  Future<void> toggle(VoiceMemo memo) async {
    if (_closed || !supported || !memo.stillAvailable(scope)) return;
    final previous = _session;
    if (previous != null && selectedId == memo.messageId) {
      if (busy) return;
      try {
        if (playing) {
          await _transport.pause(previous);
        } else {
          await _transport.resume(previous);
        }
        await _update(previous);
      } catch (_) {
        await _fail(previous, memo.messageId);
      }
      return;
    }
    final stopped = stop();
    final session = requestId();
    final read = ByteReadCancellation();
    _session = session;
    _memo = memo;
    _read = read;
    busy = true;
    failedId = null;
    notifyListeners();
    try {
      await stopped;
      if (!_current(session)) return;
      final audio = await scope.session.api.readWorkspaceFile(
        scope.workspaceId,
        memo.fileId,
        expectedUser: scope.userId,
        isCurrent: () => _current(session),
        cancellation: read,
        maximum: memo.size,
      );
      if (!_current(session)) return;
      if (!memo.validAudio(audio)) {
        throw const ApiException(
          'MEMO_AUDIO_INVALID',
          'voiceMemoPlaybackFailed',
        );
      }
      await _transport.play(session, audio.bytes);
      if (!_current(session)) {
        await _release(session);
        return;
      }
      busy = false;
      playing = true;
      _poll = Timer.periodic(const Duration(milliseconds: 350), (_) {
        if (!_checking) unawaited(_update(session));
      });
      notifyListeners();
    } catch (_) {
      await _fail(session, memo.messageId);
    }
  }

  Future<void> _update(String session) async {
    if (!_current(session) || _checking) return;
    _checking = true;
    try {
      final status = await _transport.status(session);
      if (!_current(session)) return;
      if (status == null) {
        await stop();
      } else if (playing != status.playing || positionMs != status.positionMs) {
        playing = status.playing;
        positionMs = status.positionMs;
        notifyListeners();
      }
    } catch (_) {
      final memo = _memo;
      if (memo != null) await _fail(session, memo.messageId);
    } finally {
      _checking = false;
    }
  }

  Future<void> _fail(String session, String memoId) async {
    if (!_current(session)) return;
    failedId = memoId;
    await stop();
  }

  void _observe() {
    final memo = _memo;
    if (memo != null && !memo.stillAvailable(scope)) unawaited(stop());
  }

  Future<void> _release(String session) async {
    try {
      await _transport.stop(session);
    } catch (_) {
      // Native background handlers independently release the audio session.
    }
  }

  Future<void> stop() async {
    final session = _session;
    if (session == null) return;
    _session = null;
    _memo = null;
    _read?.cancel();
    _read = null;
    _poll?.cancel();
    _poll = null;
    busy = false;
    playing = false;
    positionMs = 0;
    if (!_closed) notifyListeners();
    await _release(session);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(stop());
  }

  @override
  void dispose() {
    _closed = true;
    scope.removeListener(_observe);
    WidgetsBinding.instance.removeObserver(this);
    unawaited(stop());
    super.dispose();
  }
}
