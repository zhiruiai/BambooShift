import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

class VoiceMemoTransport {
  String? _id;
  String? _url;
  web.HTMLAudioElement? _audio;

  bool get supported => true;

  Future<void> play(String id, Uint8List wav) async {
    final previous = _id;
    if (previous != null) await stop(previous);
    final url = web.URL.createObjectURL(
      web.Blob([wav.toJS].toJS, web.BlobPropertyBag(type: 'audio/wav')),
    );
    final audio = web.HTMLAudioElement()..src = url;
    _id = id;
    _url = url;
    _audio = audio;
    try {
      await audio.play().toDart;
    } catch (_) {
      await stop(id);
      rethrow;
    }
  }

  Future<void> pause(String id) async {
    if (_id == id) _audio?.pause();
  }

  Future<void> resume(String id) async {
    final audio = _audio;
    if (_id == id && audio != null) await audio.play().toDart;
  }

  Future<void> stop(String id) async {
    if (_id != id) return;
    _id = null;
    final url = _url;
    _url = null;
    final audio = _audio;
    _audio = null;
    audio?.pause();
    audio?.removeAttribute('src');
    audio?.load();
    if (url != null) web.URL.revokeObjectURL(url);
  }

  Future<({bool playing, int positionMs})?> status(String id) async {
    final audio = _audio;
    if (_id != id || audio == null) return null;
    if (audio.ended || audio.error != null) {
      await stop(id);
      return null;
    }
    return (
      playing: !audio.paused,
      positionMs: (audio.currentTime * 1000).round(),
    );
  }
}
