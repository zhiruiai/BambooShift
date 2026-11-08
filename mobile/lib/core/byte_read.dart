import 'dart:async';
import 'dart:typed_data';

class ByteReadCancellation {
  final _done = Completer<void>();
  bool get cancelled => _done.isCompleted;
  Future<void> get whenCancelled => _done.future;
  void cancel() {
    if (!_done.isCompleted) _done.complete();
  }
}

class FileBytes {
  const FileBytes(this.bytes, this.mimeType);
  final Uint8List bytes;
  final String mimeType;
}

class ComputerScreenshotBytes extends FileBytes {
  const ComputerScreenshotBytes(
    Uint8List bytes,
    this.width,
    this.height, {
    this.capturedAt,
    this.surface,
    this.isPrivate = false,
  }) : super(bytes, 'image/png');
  final int width, height;
  final bool isPrivate;
  final String? capturedAt, surface;
}
