import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/core/request_ids.dart';
import 'package:openbot_mobile/features/computer/computer_controller.dart';
import 'package:openbot_mobile/features/teaching/teaching_controller.dart';

import 'computer_support.dart';
import 'support.dart';

const teachingModelId = '11111111-1111-4111-8111-111111111111';
Json teachingExample({String? id, String status = 'review'}) => {
  'id': id ?? requestId(),
  'revision': requestId(),
  'agentId': 'bot-a',
  'conversationId': 'chat-a',
  'status': status,
  'goal': 'Synthetic reviewed goal',
  'screen': {
    'instanceId': requestId(),
    'screenId': 'screen-a',
    'surface': 'browser',
  },
  'createdAt': DateTime.now().toUtc().toIso8601String(),
  'interrupted': status == 'interrupted',
  'steps': <Json>[
    {
      'id': requestId(),
      'action': 'type',
      'details': <String, dynamic>{},
      'note': '',
      'recordedAt': DateTime.now().toUtc().toIso8601String(),
    },
  ],
};

class TeachingServer {
  TeachingServer(this.computer);
  final ComputerServer computer;
  final requests = <http.Request>[];
  final records = <String, Json>{};
  final closed = <String>{};
  String? lose, reject;
  bool commitLost = true;
  int starts = 0, stops = 0, reviews = 0, generates = 0, cancels = 0;
  Json profile = {
    'id': teachingModelId,
    'name': 'Synthetic test model',
    'provider': 'openai',
    'model': 'mock',
    'baseUrl': 'https://model.example.test/v1',
    'vision': false,
    'configured': true,
    'hasApiKey': true,
  };
  Future<http.Response> Function(http.Request)? intercept;
  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    if (intercept != null) return intercept!(request);
    return respond(request);
  }

  Future<http.Response> respond(http.Request request) async {
    final path = request.url.path;
    if (path.endsWith('/model-profiles')) {
      return jsonResponse({
        'profiles': [profile],
      });
    }
    final index = request.url.pathSegments.indexOf('teaching');
    if (index < 0) return computer.handle(request);
    final parts = request.url.pathSegments.skip(index + 1).toList();
    if (request.method == 'GET') {
      if (parts.isEmpty) return jsonResponse(records.values.toList());
      if (closed.contains(parts.first)) {
        return jsonResponse({
          'error': 'Closed',
          'code': 'TEACHING_CLOSED',
        }, status: 410);
      }
      return records[parts.first] == null
          ? jsonResponse({'error': 'Not found'}, status: 404)
          : jsonResponse(records[parts.first]!);
    }
    final kind = parts.isEmpty
        ? 'start'
        : request.method == 'PATCH'
        ? 'review'
        : parts.last;
    final body = jsonDecode(request.body) as Json;
    if (kind == 'start') starts++;
    if (kind == 'stop') stops++;
    if (kind == 'review') reviews++;
    if (kind == 'generate') generates++;
    if (kind == 'cancel') cancels++;
    if (reject == kind) {
      return jsonResponse({'error': 'Synthetic rejected write'}, status: 409);
    }
    if (lose == kind && !commitLost) {
      throw http.ClientException('Synthetic unconfirmed write');
    }
    Json result;
    if (kind == 'start') {
      result = teachingExample(id: body['requestId'], status: 'recording');
      result['goal'] = '';
      result['steps'] = <Json>[];
      records[result['id']] = result;
    } else if (kind == 'cancel' && records[parts.first] == null) {
      closed.add(parts.first);
      result = {'id': parts.first, 'status': 'closed'};
    } else {
      final old = records[parts.first]!;
      result = {...old, 'revision': requestId()};
      if (kind == 'stop') result['status'] = 'review';
      if (kind == 'review') {
        result['goal'] = body['goal'];
        result['steps'] = [
          for (final s in body['steps'] as List)
            {
              ...(old['steps'] as List).firstWhere((v) => v['id'] == s['id'])
                  as Json,
              'note': s['note'],
            },
        ];
      }
      if (kind == 'generate') {
        result['status'] = 'generating';
        result['generationRequestId'] = body['requestId'];
      }
      if (kind == 'cancel' && old['status'] != 'proposed') {
        if (old['status'] == 'recording') {
          result['status'] = 'interrupted';
          result['interrupted'] = true;
        }
        if (old['status'] == 'generating') result['status'] = 'error';
        result['reason'] = 'user_cancelled';
      }
      records[parts.first] = result;
    }
    if (lose == kind) throw http.ClientException('Synthetic lost response');
    return jsonResponse(result);
  }
}

Future<void> teachingScenario(
  Future<void> Function(
    TeachingServer server,
    TeachingController teaching,
    ComputerController computer,
    MemorySecrets secrets,
  )
  action,
) async {
  final server = TeachingServer(ComputerServer(await computerPng()));
  final f = await fixture(server.handle);
  f.scope.data = server.computer.data;
  f.scope.find('agents', 'bot-a')!['configRevision'] = 'bot-revision-a';
  final computer = ComputerController(f.scope, 'bot-a');
  final teaching = TeachingController(computer);
  try {
    await action(server, teaching, computer, f.secrets);
  } finally {
    teaching.dispose();
    computer.dispose();
    await Future<void>.delayed(Duration.zero);
    f.scope.dispose();
    f.session.dispose();
  }
}

Future<void> startTeaching(
  TeachingController teaching,
  ComputerController computer,
) async {
  await computer.refresh();
  await computer.start();
  await teaching.initialize();
  await teaching.start();
}
