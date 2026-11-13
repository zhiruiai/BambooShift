import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// TickerMode alone does not exclude cached sliver children outside the viewport.
bool avatarFaceVisible(BuildContext context) {
  final object = context.findRenderObject();
  if (object is! RenderBox || !object.attached || !object.hasSize) return false;
  if (object.size.isEmpty) return false;
  RenderObject? ancestor = object.parent;
  while (ancestor != null) {
    if (ancestor is RenderOffstage && ancestor.offstage) return false;
    if (ancestor is RenderAbstractViewport) {
      final bounds = MatrixUtils.transformRect(
        object.getTransformTo(ancestor),
        object.paintBounds,
      );
      if (!bounds.overlaps(ancestor.paintBounds)) return false;
    }
    ancestor = ancestor.parent;
  }
  final media = MediaQuery.maybeSizeOf(context);
  final view = View.maybeOf(context);
  final screen = media != null && !media.isEmpty
      ? media
      : view == null
      ? null
      : view.physicalSize / view.devicePixelRatio;
  return screen == null ||
      MatrixUtils.transformRect(
        object.getTransformTo(null),
        object.paintBounds,
      ).overlaps(Offset.zero & screen);
}

/// A cached child can re-enter by an outer scroll. Its next paint wakes the stopped clock.
class AvatarFaceVisibility extends SingleChildRenderObjectWidget {
  const AvatarFaceVisibility({
    super.key,
    required this.onPaint,
    required super.child,
  });
  final VoidCallback onPaint;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      AvatarFaceVisibilityRenderObject(onPaint);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant AvatarFaceVisibilityRenderObject renderObject,
  ) => renderObject.onPaint = onPaint;
}

class AvatarFaceVisibilityRenderObject extends RenderProxyBox {
  AvatarFaceVisibilityRenderObject(this.onPaint);
  VoidCallback onPaint;
  @override
  void paint(PaintingContext context, Offset offset) {
    onPaint();
    super.paint(context, offset);
  }
}
