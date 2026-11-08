import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import '../../core/api.dart';
import '../../core/app_session.dart';
import '../../core/selected_attachment.dart';
import 'inbound_share_bridge.dart';
import 'inbound_share_data.dart';

typedef _Actor = ({String origin, String user, int generation});

class InboundShareInbox extends ChangeNotifier with WidgetsBindingObserver {
  InboundShareInbox(this.session, this.bridge);
  final AppSession session;
  final InboundShareBridge bridge;
  static const _operationTimeout = Duration(seconds: 4);
  _Actor? _actor;
  InboundSharePacket? _packet;
  String? _handled;
  bool _closed = false, _queued = false, _drainRequired = false;
  Future<void> _tasks = Future.value();

  InboundSharePacket? get packet =>
      _actor != null && _actor == _currentActor ? _packet : null;

  _Actor? get _currentActor {
    final origin = session.api.server?.origin, user = session.userId;
    return session.ready && origin != null && user != null
        ? (origin: origin, user: user, generation: session.api.generation)
        : null;
  }

  void start() {
    session.addListener(_sessionChanged);
    WidgetsBinding.instance.addObserver(this);
    bridge.listen(refresh);
    _sessionChanged();
  }

  void _sessionChanged() {
    if (_closed || _actor == _currentActor) return;
    if (_actor != null) _drainRequired = true;
    _actor = _currentActor;
    _packet = null;
    notifyListeners();
    refresh();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _sessionChanged();
      refresh();
    }
  }

  void refresh() {
    if (_closed || _queued) return;
    _queued = true;
    _tasks = _tasks
        .then((_) async {
          _queued = false;
          if (!_closed) await _poll();
        })
        .catchError((Object _) {});
  }

  Future<Object?> _peek() => bridge.peek().timeout(_operationTimeout);

  Future<bool> _remove(String id) =>
      bridge.discard(id).timeout(_operationTimeout);

  Future<void> _poll() async {
    if (_drainRequired) {
      // Remove old account items before exposing a queue to another account.
      for (var index = 0; index <= inboundShareQueueLimit; index++) {
        final raw = await _peek();
        if (raw == null) {
          _drainRequired = false;
          _handled = null;
          break;
        }
        if (_closed ||
            raw is! Map ||
            !inboundShareId(raw['id']) ||
            !await _remove(raw['id'] as String)) {
          return;
        }
      }
      if (_drainRequired) return;
    }
    final actor = _actor;
    if (actor == null || actor != _currentActor || _packet != null || _closed) {
      return;
    }
    final next = InboundSharePacket.parse(await _peek());
    if (_closed || actor != _actor || actor != _currentActor || next == null) {
      return;
    }
    if (_handled == next.id) {
      if (await _remove(next.id)) {
        _handled = null;
        refresh();
      }
      return;
    }
    _packet = next;
    notifyListeners();
  }

  bool contains(InboundSharePacket expected) =>
      !_closed && identical(packet, expected);

  void finish(InboundSharePacket expected, VoidCallback commit) {
    if (!contains(expected)) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
    commit();
    _handled = expected.id;
    _packet = null;
    notifyListeners();
    refresh();
  }

  Future<List<SelectedAttachment>> readFiles(
    InboundSharePacket expected,
    Set<String> ids,
    bool Function() isCurrent,
  ) async {
    void guard() {
      if (!contains(expected) || !isCurrent()) {
        throw const ApiException('STALE_SCOPE', 'scopeChanged');
      }
    }

    guard();
    final pending = InboundSharePacket.parse(await _peek());
    guard();
    if (pending?.id != expected.id) {
      _packet = null;
      notifyListeners();
      refresh();
      throw const ApiException('EXPIRED_SHARE', 'mobileInboundReadFailed');
    }
    final selected = expected.files.where((file) => ids.contains(file.id));
    if (selected.length != ids.length) {
      throw const ApiException('INVALID_FILE', 'mobileInboundReadFailed');
    }
    final result = <SelectedAttachment>[];
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    for (final file in selected) {
      final bytes = Uint8List(file.size);
      for (var offset = 0; offset < file.size; offset += inboundShareChunk) {
        guard();
        final length = min(inboundShareChunk, file.size - offset);
        final remaining = deadline.difference(DateTime.now());
        if (remaining <= Duration.zero) {
          throw const ApiException('READ_TIMEOUT', 'mobileInboundReadFailed');
        }
        final chunk = await bridge
            .read(expected.id, file.id, offset, length)
            .timeout(remaining);
        guard();
        if (chunk == null || chunk.length != length) {
          throw const ApiException('INVALID_FILE', 'mobileInboundReadFailed');
        }
        bytes.setRange(offset, offset + length, chunk);
      }
      result.add(
        SelectedAttachment(
          name: file.name,
          size: file.size,
          type: file.type,
          openRead: () => Stream.value(bytes),
          receivedFromShare: true,
        ),
      );
    }
    guard();
    return result;
  }

  @override
  void dispose() {
    _closed = true;
    _packet = null;
    bridge.listen(null);
    WidgetsBinding.instance.removeObserver(this);
    session.removeListener(_sessionChanged);
    super.dispose();
  }
}
