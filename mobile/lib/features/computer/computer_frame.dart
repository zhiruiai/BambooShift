import 'dart:ui' as ui;

import '../../core/byte_read.dart';
import 'computer_data.dart';

class ComputerFrame {
  ComputerFrame(
    this.image,
    ComputerScreenshotBytes bytes,
    this.binding,
    this.serial,
  ) : source = (
        width: bytes.width,
        height: bytes.height,
        surface: bytes.surface,
        capturedAt: bytes.capturedAt,
      ),
      isPrivate = bytes.isPrivate;

  final ui.Image image;
  final ({int width, int height, String? surface, String? capturedAt}) source;
  final bool isPrivate;
  final String binding;
  final int serial;
  void dispose() => image.dispose();
}

Future<ui.Image> decodeComputerFrame(
  ComputerScreenshotBytes source,
  void Function() check,
) async {
  check();
  final buffer = await ui.ImmutableBuffer.fromUint8List(source.bytes);
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    check();
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    check();
    if (descriptor.width != source.width ||
        descriptor.height != source.height ||
        descriptor.width < 1 ||
        descriptor.height < 1 ||
        descriptor.width * descriptor.height > 40000000) {
      invalidComputer();
    }
    final longest = descriptor.width > descriptor.height
        ? descriptor.width
        : descriptor.height;
    final ratio = longest > 2048 ? 2048 / longest : 1.0;
    codec = await descriptor.instantiateCodec(
      targetWidth: (descriptor.width * ratio).round().clamp(1, 2048),
      targetHeight: (descriptor.height * ratio).round().clamp(1, 2048),
    );
    check();
    if (codec.frameCount != 1) invalidComputer();
    image = (await codec.getNextFrame()).image;
    check();
    final result = image;
    image = null;
    return result;
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer.dispose();
  }
}
