import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';

import 'support.dart';

Future<Uint8List> computerPng([int width = 800, int height = 400]) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(const ui.Color(0xffeee8f5), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    return (await image.toByteData(
      format: ui.ImageByteFormat.png,
    ))!.buffer.asUint8List();
  } finally {
    image.dispose();
    picture.dispose();
  }
}

class ComputerServer {
  ComputerServer(this.png);
  final Uint8List png;
  final requests = <http.Request>[];
  final inputs = <Json>[];
  String assignment = 'assignment-a', screen = 'screen-a';
  bool available = true, assigned = true, active = false;
  bool privateCapable = true;
  Duration leaseLifetime = const Duration(minutes: 5);
  Json? workspaceTarget;
  Json? desktop;
  String surface = 'browser';
  int connections = 0, disconnections = 0, reconnections = 0;
  Json get machine =>
      workspaceTarget ??
      {
        'connected': false,
        'mode': 'remote',
        'surface': surface,
        'executionLocation': 'none',
      };
  bool loseStart = false, loseInput = false, loseEnd = false;
  int starts = 0, ends = 0, preparations = 0;
  int configuredScreens = 1;
  bool cloudConfigured = false;
  String cloudState = 'paused';
  int cloudStarts = 0;
  Json get cloud => {
    'configured': cloudConfigured,
    'state': cloudConfigured ? cloudState : 'unconfigured',
    'expiresAt': null,
    'observedAt': DateTime.now().toUtc().toIso8601String(),
    'operation': null,
    'worker': {
      'connected': cloudState == 'running',
      'reconnectRequired': false,
    },
    'canStart': cloudConfigured && ['paused', 'running'].contains(cloudState),
  };
  Future<http.Response> Function(http.Request)? intercept;
  Json get binding => {
    'agentId': 'bot-a',
    'screenId': screen,
    'assignmentRevision': assignment,
    'status': !assigned
        ? 'unassigned'
        : available
        ? 'ready'
        : 'unavailable',
    'lifecycle': {'state': 'ready'},
    'task': {'status': 'idle', 'queued': 0},
  };
  Json get status => {
    'botScreen': binding,
    'connected': available && assigned,
    'surface': surface,
    'mode': machine['mode'],
    'executionLocation': machine['executionLocation'],
    if (desktop != null) 'desktop': desktop,
    'capabilities': [if (privateCapable) 'private-takeover-frames-v1'],
  };
  Json get takeover => {
    'active': active,
    'width': 800,
    'height': 400,
    'surface': surface,
    'expiresAt': DateTime.now().add(leaseLifetime).toUtc().toIso8601String(),
  };
  Json get data => {
    ...bootstrap(
      agents: [
        {
          'id': 'bot-a',
          'name': 'Synthetic Bot',
          'avatar': 'orb',
          'color': '#76568d',
        },
      ],
    ),
    'computer': ?workspaceTarget,
  };
  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    if (intercept != null) return intercept!(request);
    return respond(request);
  }

  Future<http.Response> respond(http.Request request) async {
    final path = request.url.path;
    if (path.endsWith('/computer/status')) return jsonResponse(machine);
    if (path.endsWith('/computer/connect') ||
        path.endsWith('/computer/reconnect')) {
      final reconnect = path.endsWith('/reconnect');
      final body = jsonDecode(request.body) as Json;
      if (reconnect) {
        reconnections++;
      } else {
        connections++;
      }
      final mode = reconnect ? 'remote' : body['mode'];
      workspaceTarget = {
        'connected': true,
        'mode': mode,
        'surface': surface,
        'executionLocation': mode == 'local' ? 'server' : 'remote',
        'targetRevision': 'target-$connections-$reconnections',
        if (mode == 'remote') 'savedRemote': {'name': 'Synthetic computer'},
      };
      available = true;
      return jsonResponse(machine);
    }
    if (path.endsWith('/computer/disconnect')) {
      disconnections++;
      workspaceTarget = {
        ...machine,
        'connected': false,
        'executionLocation': 'none',
      };
      available = false;
      return jsonResponse(machine);
    }
    if (path.endsWith('/surface')) {
      surface = (jsonDecode(request.body) as Json)['surface'] as String;
      workspaceTarget = {...machine, 'surface': surface};
      return jsonResponse(status);
    }
    if (path.endsWith('/cloud-computer')) return jsonResponse(cloud);
    if (path.endsWith('/cloud-computer/start')) {
      cloudStarts++;
      cloudState = 'running';
      available = true;
      return jsonResponse(cloud);
    }
    if (path.endsWith('/bootstrap')) return jsonResponse(data);
    if (request.method == 'GET' && path.endsWith('/teaching')) {
      return jsonResponse(<Json>[]);
    }
    if (request.method == 'GET' && path.endsWith('/model-profiles')) {
      return jsonResponse({'profiles': <Json>[]});
    }
    if (path.endsWith('/computer/bots')) {
      return jsonResponse({
        'capacity': {
          'max': 2,
          'configured': configuredScreens,
          'ready': available ? configuredScreens : 0,
          'assigned': assigned ? 1 : 0,
        },
        'bots': [binding],
      });
    }
    if (path.endsWith('/takeover/status')) return jsonResponse(takeover);
    if (path.endsWith('/prepare')) {
      preparations++;
      assigned = true;
      return jsonResponse(status);
    }
    if (path.endsWith('/status')) return jsonResponse(status);
    if (path.endsWith('/screenshot')) {
      final private = path.endsWith('/takeover/screenshot');
      if (private
          ? !active ||
                !privateCapable ||
                request.method != 'POST' ||
                request.headers['X-OpenBot-Computer-Lease'] !=
                    'lease-original' ||
                request.body != '{}'
          : active ||
                request.method != 'GET' ||
                request.headers.containsKey('X-OpenBot-Computer-Lease')) {
        return jsonResponse({'code': 'COMPUTER_PRIVATE_TAKEOVER'}, status: 409);
      }
      return http.Response.bytes(
        png,
        200,
        headers: {
          'content-type': 'image/png',
          'cache-control': private ? 'private, no-store' : 'no-store',
          if (private) 'x-openbot-frame-visibility': 'takeover',
          'x-frame-width': '800',
          'x-frame-height': '400',
          'x-computer-surface': surface,
        },
      );
    }
    if (path.endsWith('/takeover/start')) {
      starts++;
      active = true;
      if (loseStart) throw http.ClientException('Synthetic lost response');
      return jsonResponse({...takeover, 'leaseId': 'lease-original'});
    }
    if (path.endsWith('/takeover/input')) {
      inputs.add(jsonDecode(request.body) as Json);
      if (loseInput) throw http.ClientException('Synthetic lost response');
      return jsonResponse({'ok': true});
    }
    if (path.endsWith('/takeover/end')) {
      ends++;
      if (loseEnd) throw http.ClientException('Synthetic lost response');
      active = false;
      return jsonResponse({'active': false});
    }
    return jsonResponse({'error': 'Unexpected route'}, status: 404);
  }
}
