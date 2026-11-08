import 'package:flutter/material.dart';
import '../../l10n/strings.dart';
import 'computer_controller.dart';
import 'computer_data.dart';

class ComputerPicture extends StatefulWidget {
  const ComputerPicture({super.key, required this.controller});
  final ComputerController controller;
  @override
  State<ComputerPicture> createState() => _ComputerPictureState();
}

class _ComputerPictureState extends State<ComputerPicture> {
  final transform = TransformationController();
  String? binding;
  @override
  void dispose() {
    transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, frame = c.frame;
    final identity = frame == null
        ? null
        : '${frame.binding}:${frame.isPrivate}:${frame.source.width}:${frame.source.height}';
    if (identity != null && identity != binding) {
      binding = identity;
      transform.value = Matrix4.identity();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            final height = frame == null
                ? 220.0
                : (constraints.maxWidth *
                          frame.source.height /
                          frame.source.width)
                      .clamp(200.0, 420.0);
            return SizedBox(
              height: height,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: ColoredBox(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  child: frame == null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Text(
                              context.tr('mobileComputerNoFrame'),
                              textAlign: TextAlign.center,
                            ),
                          ),
                        )
                      : LayoutBuilder(
                          builder: (context, viewport) => InteractiveViewer(
                            transformationController: transform,
                            minScale: 1,
                            maxScale: 6,
                            child: GestureDetector(
                              key: const ValueKey('computer-frame'),
                              behavior: HitTestBehavior.opaque,
                              onTapUp: !c.canInput
                                  ? null
                                  : (event) {
                                      final point = computerPoint(
                                        event.localPosition,
                                        viewport.biggest,
                                        frame.source.width,
                                        frame.source.height,
                                      );
                                      if (point != null) {
                                        c.input({
                                          'type': 'click',
                                          'x': point.dx,
                                          'y': point.dy,
                                        }, frameSerial: frame.serial);
                                      }
                                    },
                              child: Semantics(
                                label: context.tr('mobileComputerFrame'),
                                image: true,
                                child: RawImage(
                                  image: frame.image,
                                  fit: BoxFit.contain,
                                  width: viewport.maxWidth,
                                  height: viewport.maxHeight,
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
              ),
            );
          },
        ),
        if (frame != null) ...[
          Text(context.tr('mobileComputerZoomHint')),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => transform.value = Matrix4.identity(),
              icon: const Icon(Icons.fit_screen),
              label: Text(context.tr('mobileComputerFit')),
            ),
          ),
          Text(
            '${context.tr('mobileComputerCaptured')} ${frame.source.capturedAt == null ? context.tr('mobileComputerTimeUnknown') : DateTime.parse(frame.source.capturedAt!).toLocal()}',
          ),
        ],
      ],
    );
  }
}
