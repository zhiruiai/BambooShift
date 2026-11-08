import 'dart:io' show Platform;

import 'package:flutter/services.dart';

class VoiceMemoTransport {
  const VoiceMemoTransport();
  static const _channel = MethodChannel('com.openbot.client/voice');

  bool get supported => Platform.isIOS || Platform.isAndroid;

  Future<void> play(String id, Uint8List wav) =>
      _channel.invokeMethod<void>('memoPlay', {'id': id, 'wav': wav});

  Future<void> pause(String id) =>
      _channel.invokeMethod<void>('memoPause', {'id': id});

  Future<void> resume(String id) =>
      _channel.invokeMethod<void>('memoResume', {'id': id});

  Future<void> stop(String id) =>
      _channel.invokeMethod<void>('memoStop', {'id': id});

  Future<({bool playing, int positionMs})?> status(String id) async {
    final result = await _channel.invokeMapMethod<String, Object?>(
      'memoStatus',
      {'id': id},
    );
    final playing = result?['playing'], position = result?['positionMs'];
    return playing is bool && position is int && position >= 0
        ? (playing: playing, positionMs: position)
        : null;
  }
}
