import 'dart:convert';
import 'dart:ui';

import '../../core/api.dart';

Never invalidComputer() =>
    throw const ApiException('INVALID_COMPUTER', 'mobileComputerInvalid');

String computerExecutionLocation(Object? value) {
  if (value is! Map) return 'unknown';
  final location = value['executionLocation'];
  if (['server', 'cloud', 'remote', 'none'].contains(location)) {
    return location as String;
  }
  return value['mode'] == 'local'
      ? 'server'
      : value['mode'] == 'remote'
      ? 'remote'
      : 'unknown';
}

String? computerWorkspaceTarget(Object? value) {
  if (value is! Map) return null;
  return jsonEncode([
    value['targetRevision'],
    value['mode'],
    value['connected'],
    value['surface'],
    computerExecutionLocation(value),
  ]);
}

class ComputerStatus {
  ComputerStatus(this.value, String agentId) {
    final b = value['botScreen'];
    if (b is! Json ||
        b['agentId'] != agentId ||
        !['ready', 'unassigned', 'unavailable'].contains(b['status']) ||
        value['connected'] is! bool ||
        !['browser', 'desktop'].contains(value['surface'])) {
      invalidComputer();
    }
    final shared = b['shared'] == true;
    if (b['status'] == 'ready' &&
        (shared
            ? value['targetRevision'] is! String ||
                  !RegExp(
                    r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$',
                  ).hasMatch(value['targetRevision'])
            : b['screenId'] is! String || b['assignmentRevision'] is! String)) {
      invalidComputer();
    }
  }
  final Json value;
  Json get binding => value['botScreen'] as Json;
  String get status => binding['status'] as String;
  String get surface => value['surface'] as String;
  String get executionLocation => computerExecutionLocation(value);
  String get fingerprint {
    final desktop = value['desktop'];
    final session = desktop is Map ? desktop['session'] : null;
    return jsonEncode([
      value['targetRevision'],
      binding['shared'] == true,
      binding['screenId'],
      binding['assignmentRevision'],
      surface,
      session is Map ? session['id'] : null,
      session is Map ? session['generation'] : null,
    ]);
  }

  bool get ready =>
      status == 'ready' &&
      value['connected'] == true &&
      binding['lifecycle']?['state'] == 'ready' &&
      ![
        'blocked',
        'maintenance',
        'waiting_cleanup',
      ].contains(binding['task']?['status']);
  bool get privateTakeover {
    final capabilities = value['capabilities'];
    return capabilities is List &&
        capabilities.contains('private-takeover-frames-v1');
  }

  bool get virtualDesktop =>
      surface == 'desktop' && value['desktop']?['kind'] == 'virtual';
}

class ComputerLease {
  const ComputerLease(
    this.id,
    this.expiresAt,
    this.width,
    this.height,
    this.surface,
  );
  factory ComputerLease.parse(Json value) {
    final id = value['leaseId'];
    final expiry = DateTime.tryParse(value['expiresAt'] as String? ?? '');
    final dimensions = checkedTakeover(value);
    if (value['active'] != true ||
        id is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,199}$').hasMatch(id) ||
        !['browser', 'desktop'].contains(value['surface']) ||
        expiry == null ||
        !expiry.isAfter(DateTime.now()) ||
        expiry.isAfter(DateTime.now().add(const Duration(minutes: 10)))) {
      invalidComputer();
    }
    return ComputerLease(
      id,
      expiry,
      dimensions.$1,
      dimensions.$2,
      value['surface'] as String?,
    );
  }
  final String id;
  final DateTime expiresAt;
  final int width, height;
  final String? surface;
  bool get expired => !expiresAt.isAfter(DateTime.now());
}

(int, int) checkedTakeover(Json value) {
  final width = value['width'], height = value['height'];
  if (value['active'] is! bool ||
      width is! int ||
      height is! int ||
      width < 1 ||
      height < 1 ||
      width * height > 40000000 ||
      (value['surface'] != null &&
          !['browser', 'desktop'].contains(value['surface']))) {
    invalidComputer();
  }
  return (width, height);
}

Offset? computerPoint(Offset point, Size viewport, int width, int height) {
  if (!viewport.isFinite || viewport.isEmpty || width < 1 || height < 1) {
    return null;
  }
  final scale = (viewport.width / width < viewport.height / height)
      ? viewport.width / width
      : viewport.height / height;
  final origin = Offset(
    (viewport.width - width * scale) / 2,
    (viewport.height - height * scale) / 2,
  );
  final local = (point - origin) / scale;
  if (!local.dx.isFinite ||
      !local.dy.isFinite ||
      local.dx < 0 ||
      local.dy < 0 ||
      local.dx >= width ||
      local.dy >= height) {
    return null;
  }
  return Offset(local.dx.floorToDouble(), local.dy.floorToDouble());
}

void validateComputerAction(
  Json action,
  ComputerLease current, {
  required bool virtualDesktop,
}) {
  switch (action['type']) {
    case 'click':
      if (action['x'] is! num ||
          action['y'] is! num ||
          !(action['x'] as num).isFinite ||
          !(action['y'] as num).isFinite ||
          action['x'] < 0 ||
          action['y'] < 0 ||
          action['x'] >= current.width ||
          action['y'] >= current.height) {
        invalidComputer();
      }
    case 'type':
      final text = action['text'];
      if (text is! String ||
          text.isEmpty ||
          text.contains('\u0000') ||
          text.length > (virtualDesktop ? 300 : 20000)) {
        invalidComputer();
      }
    case 'key':
      if (![
        'Enter',
        'Tab',
        'Backspace',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ].contains(action['key'])) {
        invalidComputer();
      }
    case 'scroll':
      if (action['deltaY'] is! num ||
          !(action['deltaY'] as num).isFinite ||
          (action['deltaY'] as num).abs() > 4000) {
        invalidComputer();
      }
    default:
      invalidComputer();
  }
}
