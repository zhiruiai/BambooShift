import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The bundled illustrations put the eyes in a shared SVG group. Decode the
/// three paint layers once and keep the rest of the character still.
class IdleAvatarBlink extends StatefulWidget {
  const IdleAvatarBlink({
    super.key,
    required this.asset,
    required this.colorMapper,
    required this.fallback,
  });

  final String asset;
  final ColorMapper colorMapper;
  final Widget fallback;

  @override
  State<IdleAvatarBlink> createState() => _IdleAvatarBlinkState();
}

class _IdleAvatarBlinkState extends State<IdleAvatarBlink> {
  final _layers = <PictureInfo>[];
  Timer? _delay;
  bool _started = false;
  bool _showBlink = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    unawaited(_prepare(DefaultAssetBundle.of(context)));
  }

  Future<void> _prepare(AssetBundle bundle) async {
    final decoded = <PictureInfo>[];
    try {
      final source = await bundle.loadString(widget.asset);
      final layers = _splitEyes(source);
      if (!mounted || layers == null) return;
      for (final svg in layers) {
        final layer = await vg.loadPicture(
          SvgStringLoader(svg, colorMapper: widget.colorMapper),
          null,
        );
        decoded.add(layer);
        if (!mounted) return;
      }
      _layers.addAll(decoded);
      decoded.clear();
      _delay = Timer(const Duration(milliseconds: 360), () {
        if (mounted) setState(() => _showBlink = true);
      });
    } catch (_) {
      // The static illustration remains usable if an asset has no eye layer.
    } finally {
      for (final layer in decoded) {
        layer.picture.dispose();
      }
    }
  }

  void _releaseLayers() {
    for (final layer in _layers) {
      layer.picture.dispose();
    }
    _layers.clear();
  }

  void _finish() {
    setState(() => _showBlink = false);
    // Release the paint layers after the static avatar replaces the painter.
    WidgetsBinding.instance.addPostFrameCallback((_) => _releaseLayers());
  }

  @override
  void dispose() {
    _delay?.cancel();
    _releaseLayers();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_showBlink) return widget.fallback;
    return TweenAnimationBuilder<double>(
      duration: const Duration(milliseconds: 260),
      tween: Tween(begin: 0, end: 1),
      onEnd: _finish,
      builder: (context, phase, _) => CustomPaint(
        key: const ValueKey('idle-avatar-blink'),
        painter: _BlinkPainter(_layers, phase),
      ),
    );
  }
}

List<String>? _splitEyes(String svg) {
  final eye = RegExp(r'<g class="avatar-eyes"[^>]*>').firstMatch(svg);
  final open = svg.indexOf('>');
  final close = svg.lastIndexOf('</svg>');
  if (eye == null || open < 0 || close <= eye.end) return null;
  var depth = 1;
  for (final tag in RegExp(r'</?g(?:\s[^>]*)?>').allMatches(svg, eye.end)) {
    depth += tag[0] == '</g>' ? -1 : 1;
    if (depth == 0) {
      final head = svg.substring(0, open + 1);
      return [
        '$head${svg.substring(open + 1, eye.start)}</svg>',
        '$head${svg.substring(eye.start, tag.end)}</svg>',
        '$head${svg.substring(tag.end, close)}</svg>',
      ];
    }
  }
  return null;
}

class _BlinkPainter extends CustomPainter {
  const _BlinkPainter(this.layers, this.phase);
  final List<PictureInfo> layers;
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = layers.first.size;
    final squeeze = Curves.easeInOut.transform(1 - (2 * phase - 1).abs());
    final eyeCenter = bounds.height * 31.5 / 64;
    canvas
      ..save()
      ..scale(size.width / bounds.width, size.height / bounds.height)
      ..drawPicture(layers[0].picture)
      ..save()
      ..translate(0, eyeCenter)
      ..scale(1, 1 - .88 * squeeze)
      ..translate(0, -eyeCenter)
      ..drawPicture(layers[1].picture)
      ..restore()
      ..drawPicture(layers[2].picture)
      ..restore();
  }

  @override
  bool shouldRepaint(_BlinkPainter oldDelegate) =>
      oldDelegate.phase != phase || oldDelegate.layers != layers;
}
