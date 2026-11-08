import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/features/computer/computer_data.dart';
import 'package:openbot_mobile/features/computer/computer_frame.dart';

import 'computer_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'contain mapping rejects letterbox and maps only actual screen pixels',
    () {
      expect(
        computerPoint(const Offset(150, 10), const Size(300, 300), 800, 400),
        isNull,
      );
      expect(
        computerPoint(const Offset(150, 150), const Size(300, 300), 800, 400),
        const Offset(400, 200),
      );
      expect(
        computerPoint(const Offset(300, 150), const Size(300, 300), 800, 400),
        isNull,
      );
      expect(
        computerPoint(const Offset(299, 224), const Size(300, 300), 800, 400),
        const Offset(797, 397),
      );
      expect(computerPoint(const Offset(10, 10), Size.zero, 800, 400), isNull);
    },
  );
  test(
    'computer frame decoding is bounded and validates actual encoded dimensions',
    () async {
      final png = await computerPng(3000, 1500);
      final image = await decodeComputerFrame(
        ComputerScreenshotBytes(png, 3000, 1500),
        () {},
      );
      expect(image.width, 2048);
      expect(image.height, 1024);
      image.dispose();
      await expectLater(
        decodeComputerFrame(ComputerScreenshotBytes(png, 800, 400), () {}),
        throwsA(isA<ApiException>()),
      );
      var checks = 0;
      await expectLater(
        decodeComputerFrame(ComputerScreenshotBytes(png, 3000, 1500), () {
          if (++checks > 2) {
            throw const ApiException('STALE_SCOPE', 'scopeChanged');
          }
        }),
        throwsA(isA<ApiException>()),
      );
    },
  );
}
