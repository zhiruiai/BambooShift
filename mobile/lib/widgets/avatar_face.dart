import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'avatar_face_art.dart';
import 'avatar_face_geometry.dart';
import 'avatar_face_visibility.dart';

/// The original vector character stays still while the shared eye pose changes.
class AvatarFace extends StatefulWidget {
  const AvatarFace({
    super.key,
    required this.asset,
    required this.theme,
    required this.shape,
    required this.colorMapper,
    required this.fallback,
    this.state = 'idle',
    this.sustain = false,
    this.blinkWhenIdle = false,
    this.label,
  });
  final String asset, theme, shape, state;
  final ColorMapper colorMapper;
  final Widget fallback;
  final bool sustain, blinkWhenIdle;
  final String? label;
  @override
  State<AvatarFace> createState() => AvatarFaceState();
}

class AvatarFaceState extends State<AvatarFace>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final Ticker _ticker = createTicker(_tick);
  final _layers = <PictureInfo>[];
  AvatarFaceRules? _rules;
  AvatarEyePose? _from, _pose;
  Offset _gaze = Offset.zero;
  double _transition = 0, _elapsed = 0, _blink = 0;
  Duration? _previous;
  AssetBundle? _bundle;
  ScrollPosition? _position;
  bool _queued = false, _visible = false, _blinkDone = false;
  int _generation = 0;

  bool get clockRunning => _ticker.isActive;
  String get _state => widget.state == 'preview' ? 'attention' : widget.state;
  bool get _foreground => switch (WidgetsBinding.instance.lifecycleState) {
    null || AppLifecycleState.resumed => true,
    _ => false,
  };
  bool get _reduced => MediaQuery.maybeDisableAnimationsOf(context) == true;
  bool get _enabled =>
      _foreground &&
      !_reduced &&
      TickerMode.valuesOf(context).enabled &&
      _visible;
  bool get _working => widget.sustain && _state == 'working';
  bool get _idleBlink =>
      widget.blinkWhenIdle && _state == 'idle' && !_blinkDone;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final position = Scrollable.maybeOf(context)?.position;
    if (position != _position) {
      _position?.removeListener(_scheduleVisibility);
      _position = position;
      position?.addListener(_scheduleVisibility);
    }
    final bundle = DefaultAssetBundle.of(context);
    if (_bundle != bundle) {
      _bundle = bundle;
      unawaited(_prepare(bundle));
    }
    _syncClock();
    _scheduleVisibility();
  }

  @override
  void didUpdateWidget(AvatarFace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.asset != widget.asset ||
        oldWidget.colorMapper != widget.colorMapper) {
      unawaited(_prepare(_bundle!));
    } else if (oldWidget.state != widget.state) {
      _from = _pose;
      _transition = 0;
      _elapsed = 0;
      _blinkDone = false;
      _blink = 0;
    }
    _syncClock();
  }

  Future<void> _prepare(AssetBundle bundle) async {
    final generation = ++_generation;
    final asset = widget.asset, mapper = widget.colorMapper;
    _stop();
    final previous = List<PictureInfo>.of(_layers);
    _layers.clear();
    _rules = null;
    _pose = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final layer in previous) {
        layer.picture.dispose();
      }
    });
    final decoded = <PictureInfo>[];
    try {
      final rules = await AvatarFaceRules.load(bundle);
      if (!mounted || generation != _generation) return;
      final source = await bundle.loadString(asset);
      if (!mounted || generation != _generation) return;
      final layers = splitAvatarFace(source);
      if (layers == null) return;
      for (final svg in layers) {
        decoded.add(
          await vg.loadPicture(SvgStringLoader(svg, colorMapper: mapper), null),
        );
        if (!mounted || generation != _generation) return;
      }
      _releaseLayers();
      _layers.addAll(decoded);
      decoded.clear();
      final terminal = _state == 'done' || _state == 'error';
      setState(() {
        _rules = rules;
        _pose = rules.pose(terminal || _reduced ? _state : 'idle');
        _from = _pose;
        _transition = terminal ? rules.pose(_state)['duration'] : 0;
        _gaze = Offset(_pose!['gazeX'], _pose!['gazeY']);
      });
      _scheduleVisibility();
    } catch (_) {
      // A missing or incompatible bundled asset retains its existing static illustration.
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
    final rules = _rules;
    if (rules == null) return;
    if (_reduced) {
      final pose = rules.pose(_state);
      _pose = pose;
      _from = pose;
      _transition = pose['duration'];
      _gaze = Offset(pose['gazeX'], pose['gazeY']);
      _blink = 0;
      _blinkDone = true;
    }
    if (!_enabled) {
      _stop();
      return;
    }
    final target = rules.pose(_state);
    final gazeSettled =
        (_gaze - Offset(target['gazeX'], target['gazeY'])).distance < .025;
    final moving =
        _transition < target['duration'] ||
        !gazeSettled ||
        _working ||
        _idleBlink;
    if (moving && !_ticker.isActive) {
      _previous = null;
      _ticker.start();
    }
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
    final dt = ((elapsed - previous).inMicroseconds / 1000).clamp(
      0.0,
      _rules!.motion('maxFrameDeltaMs'),
    );
    final rules = _rules!;
    final target = rules.pose(_state);
    _transition += dt;
    _elapsed += dt;
    final amount = rules.ease(_transition / target['duration']);
    final pose = amount == 1 ? target : _from!.blend(target, amount);
    final sway = _working
        ? math.sin(_elapsed / rules.motion('workingPeriodMs') * math.pi * 2) *
              rules.motion('workingGazeAmplitude')
        : 0;
    final gaze = Offset(
      rules.gaze(_gaze.dx, target['gazeX'] + sway, dt),
      rules.gaze(_gaze.dy, target['gazeY'], dt),
    );
    var blink = 0.0;
    if (_idleBlink) {
      final phase =
          (_elapsed - rules.motion('blinkDelayMs')) /
          rules.motion('blinkDurationMs');
      if (phase >= 1) {
        _blinkDone = true;
      } else if (phase > 0) {
        blink = math.sin(phase * math.pi);
      }
    }
    setState(() {
      _pose = pose;
      _gaze = gaze;
      _blink = blink;
    });
    _syncClock();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (mounted) {
      _syncClock();
      _scheduleVisibility();
    }
  }

  @override
  void dispose() {
    _generation++;
    WidgetsBinding.instance.removeObserver(this);
    _position?.removeListener(_scheduleVisibility);
    _ticker.dispose();
    _releaseLayers();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AvatarFaceVisibility(
    onPaint: _scheduleVisibility,
    child: _layers.isEmpty || _pose == null
        ? widget.fallback
        : Semantics(
            label: widget.label,
            image: true,
            child: CustomPaint(
              key: const ValueKey('avatar-face'),
              painter: AvatarFacePainter(
                layers: _layers,
                theme: _rules!.theme(widget.theme),
                shape: widget.shape,
                pose: _pose!,
                gaze: _gaze,
                blink: _blink,
              ),
            ),
          ),
  );
}
