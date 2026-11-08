import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/features/chat/file_preview_data.dart';

Future<Uint8List> syntheticPng() async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    const ui.Rect.fromLTWH(0, 0, 1, 1),
    ui.Paint()..color = const ui.Color(0xff76568d),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(1, 1);
  try {
    return (await image.toByteData(
      format: ui.ImageByteFormat.png,
    ))!.buffer.asUint8List();
  } finally {
    image.dispose();
    picture.dispose();
  }
}

Uint8List oversizedPng(Uint8List png) {
  final copy = Uint8List.fromList(png);
  final bytes = ByteData.sublistView(copy);
  bytes.setUint32(16, 32768);
  bytes.setUint32(20, 32768);
  var crc = 0xffffffff;
  for (final byte in copy.sublist(12, 29)) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) == 1 ? 0xedb88320 ^ (crc >> 1) : crc >> 1;
    }
  }
  bytes.setUint32(29, crc ^ 0xffffffff);
  return copy;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'static image header is verified and real decoder returns a bounded image',
    () async {
      final png = await syntheticPng();
      final image = await previewImage(FileBytes(png, 'image/png'), () {});
      expect(image.width, 1);
      expect(image.height, 1);
      image.dispose();
      await expectLater(
        previewImage(FileBytes(oversizedPng(png), 'image/png'), () {}),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'IMAGE_TOO_LARGE'),
        ),
      );
    },
  );
  test(
    'image MIME spoofing and cancellation are rejected before publishing pixels',
    () async {
      final png = await syntheticPng();
      await expectLater(
        previewImage(
          FileBytes(Uint8List.fromList(utf8.encode('<svg/>')), 'image/png'),
          () {},
        ),
        throwsA(isA<ApiException>()),
      );
      var checks = 0;
      await expectLater(
        previewImage(FileBytes(png, 'image/png'), () {
          if (++checks > 1) {
            throw const ApiException('STALE_SCOPE', 'scopeChanged');
          }
        }),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SCOPE'),
        ),
      );
    },
  );
  test(
    'text and HTML remain literal while binary and invalid UTF-8 are rejected',
    () {
      const source =
          '<script>window.location="https://outside.example.test"</script>';
      expect(
        previewText(
          FileBytes(Uint8List.fromList(utf8.encode(source)), 'text/html'),
          const ChatFile('file-a', 'report.html', 100),
        ),
        source,
      );
      for (final bytes in [
        Uint8List.fromList([0]),
        Uint8List.fromList([255]),
      ]) {
        expect(
          () => previewText(
            FileBytes(bytes, 'text/plain'),
            const ChatFile('file-a', 'report.txt', 1),
          ),
          throwsA(isA<ApiException>()),
        );
      }
    },
  );
}
