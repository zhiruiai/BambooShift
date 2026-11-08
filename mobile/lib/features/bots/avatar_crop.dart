import 'dart:math' as math;

import '../../core/api.dart';
import '../../core/request_ids.dart';

class AvatarSource {
  const AvatarSource(this.id, this.width, this.height);

  static AvatarSource? parse(Object? value) {
    if (value is! Json) return null;
    final id = value['id'];
    final width = value['width'], height = value['height'];
    if (!isRequestId(id) ||
        width is! int ||
        height is! int ||
        width < 1 ||
        height < 1 ||
        width * height > 40000000) {
      return null;
    }
    return AvatarSource(id as String, width, height);
  }

  final String id;
  final int width, height;

  ({int left, int top, int size}) crop(double zoom, double x, double y) {
    final size = math.max(1, (math.min(width, height) / zoom).floor());
    return (
      left: ((width - size) * x).round(),
      top: ((height - size) * y).round(),
      size: size,
    );
  }
}
