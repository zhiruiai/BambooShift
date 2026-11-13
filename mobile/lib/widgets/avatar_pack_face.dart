import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'avatar_face_visibility.dart';
import 'avatar_pack_geometry.dart';
import 'avatar_pack_painter.dart';

/// A shared-geometry renderer using the app's lifecycle and visibility policy.
class AvatarPackFace extends StatefulWidget {
  const AvatarPackFace({
    super.key,
    required this.theme,
    required this.color,
    this.state = 'idle',
    this.sustain = false,
    this.blinkWhenIdle = false,
    this.label,
  });
  final String theme, state;
  final Color color;
  final bool sustain, blinkWhenIdle;
  final String? label;
  @override
  State<AvatarPackFace> createState() => AvatarPackFaceState();
}

class AvatarPackFaceState extends State<AvatarPackFace>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final Ticker _ticker = createTicker(_tick);
  AvatarPackShape? _shape;
  AvatarEyeRings? _rings, _from, _target;
  AssetBundle? _bundle;
  ScrollPosition? _scroll;
  Duration? _previous;
  double _elapsed = 0, _transition = 420, _blink = 0;
  int _generation = 0, _expression = 0;
  bool _visible = false, _queued = false, _blinkDone = false;
  Offset _gaze = Offset.zero;
  bool get clockRunning => _ticker.isActive;
  bool get _reduced => MediaQuery.maybeDisableAnimationsOf(context) == true;
  bool get _enabled =>
      !_reduced &&
      _visible &&
      TickerMode.valuesOf(context).enabled &&
      [
        null,
        AppLifecycleState.resumed,
      ].contains(WidgetsBinding.instance.lifecycleState);
  bool get _working =>
      widget.sustain && ['working', 'thinking'].contains(widget.state);
  bool get _idleBlink =>
      widget.blinkWhenIdle && widget.state == 'idle' && !_blinkDone;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scroll = Scrollable.maybeOf(context)?.position;
    if (scroll != _scroll) {
      _scroll?.removeListener(_scheduleVisibility);
      _scroll = scroll;
      scroll?.addListener(_scheduleVisibility);
    }
    final bundle = DefaultAssetBundle.of(context);
    if (bundle != _bundle) {
      _bundle = bundle;
      unawaited(_load(bundle));
    }
    _syncClock();
    _scheduleVisibility();
  }

  @override
  void didUpdateWidget(AvatarPackFace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.theme != widget.theme) {
      unawaited(_load(_bundle!));
    } else if (oldWidget.state != widget.state && _shape != null) {
      _elapsed = 0;
      _expression = 0;
      _blinkDone = false;
      _retarget();
    }
    _syncClock();
  }

  Future<void> _load(AssetBundle bundle) async {
    final generation = ++_generation;
    final theme = widget.theme;
    _stop();
    _shape = null;
    _rings = _from = _target = null;
    _gaze = Offset.zero;
    _elapsed = _blink = 0;
    _blinkDone = false;
    try {
      final family = theme.startsWith('open-avatar-')
          ? 'open-avatar'
          : 'grokbot';
      final pack = await AvatarPackGeometry.load(bundle, family);
      if (!mounted || generation != _generation) return;
      final shape = pack.shape(theme.substring(family.length + 1));
      setState(() {
        _shape = shape;
        _expression = 0;
        final still =
            _reduced || ['idle', 'done', 'error'].contains(widget.state);
        _target = shape.pose(shape.expressionIds(widget.state).first);
        _rings = still
            ? _target
            : shape.pose(shape.expressionIds('idle').first);
        _from = _rings;
        _transition = still ? 420 : 0;
      });
      _scheduleVisibility();
    } catch (_) {
      // Never retain artwork from a previous theme after a failed replacement.
    }
  }

  void _retarget() {
    final shape = _shape!;
    final ids = shape.expressionIds(widget.state);
    _from = displayEyeRings(_rings!, _gaze, _blink);
    _rings = _from;
    _gaze = Offset.zero;
    _blink = 0;
    _target = shape.pose(ids[_expression % ids.length]);
    _transition = 0;
  }

  void _scheduleVisibility() {
    if (_queued || !mounted) return;
    _queued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _queued = false;
      if (!mounted) return;
      _visible = avatarFaceVisible(context);
      _syncClock();
    });
  }

  void _stop() {
    _ticker.stop();
    _previous = null;
  }

  void _syncClock() {
    if (_shape == null) return;
    if (_reduced) {
      _rings = _from = _target;
      _transition = 420;
      _blink = 0;
      _gaze = Offset.zero;
      _blinkDone = true;
    }
    final moving = _enabled && (_transition < 420 || _working || _idleBlink);
    if (moving && !_ticker.isActive) _ticker.start();
    if (!moving) _stop();
  }

  void _tick(Duration elapsed) {
    _visible = avatarFaceVisible(context);
    if (!_enabled) {
      _stop();
      return;
    }
    final previous = _previous;
    _previous = elapsed;
    if (previous == null) return;
    final dt = ((elapsed - previous).inMicroseconds / 1000).clamp(0.0, 50.0);
    final shape = _shape!;
    final cadence = shape.cadence(widget.state);
    _elapsed += dt;
    if (_working && _elapsed >= (_expression + 1) * cadence) {
      _expression++;
      _retarget();
    }
    _transition += dt;
    final t = (_transition / 420).clamp(0.0, 1.0);
    final eased = 1 - math.pow(1 - t, 5).toDouble();
    final blinkDuration = shape.pack.motion('blinkDurationMs', 320);
    final blinkSlot = shape.blinkSlot(widget.state);
    final blinkTime = _working
        ? _elapsed % blinkSlot - blinkSlot + blinkDuration
        : _elapsed - 700;
    var blink = 0.0;
    if ((_working || _idleBlink) && blinkTime > 0) {
      if (blinkTime < blinkDuration) {
        blink = math.sin(blinkTime / blinkDuration * math.pi);
      } else if (!_working) {
        _blinkDone = true;
      }
    }
    setState(() {
      _rings = t == 1 ? _target : blendEyeRings(_from!, _target!, eased);
      _blink = blink;
      _gaze = _working
          ? Offset(math.sin(_elapsed / 650) * shape.pack.gazeX * .28, 0)
          : Offset.zero;
    });
    _syncClock();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _syncClock();
    _scheduleVisibility();
  }

  @override
  void dispose() {
    _generation++;
    WidgetsBinding.instance.removeObserver(this);
    _scroll?.removeListener(_scheduleVisibility);
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AvatarFaceVisibility(
    onPaint: _scheduleVisibility,
    child: Semantics(
      label: widget.label,
      image: true,
      child: _shape == null || _rings == null
          ? const SizedBox.expand()
          : CustomPaint(
              key: const ValueKey('community-avatar-face'),
              painter: AvatarPackPainter(
                shape: _shape!,
                rings: _rings!,
                color: widget.color,
                blink: _blink,
                gaze: _gaze,
              ),
            ),
    ),
  );
}
