import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class VoiceTransport {
  const VoiceTransport();
  static const _channel = MethodChannel('com.openbot.client/voice');

  bool get supported => !kIsWeb && (Platform.isIOS || Platform.isAndroid);

  Future<void> prepare({required bool playback}) =>
      _channel.invokeMethod<void>('prepare', {'playback': playback});

  Future<Uint8List?> record({required bool automatic, required int seconds}) =>
      _channel.invokeMethod<Uint8List>('record', {
        'automatic': automatic,
        'seconds': seconds,
      });

  Future<void> finish() => _channel.invokeMethod<void>('finish');

  Future<void> speak(String text, String language) => _channel
      .invokeMethod<void>('speak', {'text': text, 'language': language});

  Future<void> stop() => _channel.invokeMethod<void>('stop');
}
