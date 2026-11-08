import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'library_support.dart';
import 'support.dart';

const grantAppId = '20000000-0000-4000-8000-000000000005';
Json sharingFile() => {
  'fileId': 'file-a',
  'name': 'Review.txt',
  'size': 4,
  'type': 'text/plain',
  'revision': 'b' * 64,
};
Json sharingApp() => {
  'connectionId': grantAppId,
  'connectionRevision': libraryRevision,
  'name': 'Source app',
  'tools': [
    {
      'name': 'lookup',
      'description': 'Read records',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'query': {'type': 'string'},
        },
      },
      'revision': 'c' * 64,
    },
  ],
};
Json sharingValue() => {
  'share': {
    'id': libraryShare,
    'sourceWorkspaceId': 'space-a',
    'sourceAgentId': 'bot-a',
    'targetTeamId': libraryShare,
    'audience': 'team',
    'memberIds': [],
    'status': 'active',
    'revision': libraryRevision,
    'files': [sharingFile()],
    'apps': [sharingApp()],
  },
  'teams': [
    {
      'id': libraryShare,
      'name': 'Synthetic team',
      'members': [
        {'userId': 'user-a', 'name': 'Example'},
        {'userId': 'user-b', 'name': 'Colleague'},
      ],
    },
  ],
};

class SharingServer {
  final requests = <http.Request>[];
  Json value = sharingValue(),
      policy = {'mode': 'public', 'revision': libraryRevision};
  bool unavailable = true, failOptions = false;
  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    final p = r.url.path;
    if (p == '/api/account/session') return jsonResponse(libraryAccount());
    if (p.endsWith('/bot-sharing-policy')) {
      if (r.method == 'PUT') {
        final body = jsonDecode(r.body) as Json;
        policy = {'mode': body['mode'], 'revision': libraryShare};
      }
      return jsonResponse(policy);
    }
    if (p.endsWith('/sharing/files')) {
      if (failOptions) {
        return jsonResponse({'error': 'Unavailable'}, status: 503);
      }
      return jsonResponse({
        'files': [
          {
            'fileId': 'file-a',
            'name': 'Review.txt',
            'size': 4,
            'type': 'text/plain',
          },
        ],
        'selected': [
          for (final f in value['share']['files'])
            {...f, 'status': unavailable ? 'missing' : 'available'},
        ],
        'truncated': false,
      });
    }
    if (p.endsWith('/sharing/files/file-a')) return jsonResponse(sharingFile());
    if (p.endsWith('/sharing/apps')) {
      return jsonResponse({
        'apps': [
          {
            'connectionId': grantAppId,
            'name': 'Source app',
            'status': 'connected',
            'toolCount': 1,
          },
        ],
        'selected': [
          for (final a in value['share']['apps'])
            {...a, 'status': unavailable ? 'changed' : 'available'},
        ],
      });
    }
    if (p.endsWith('/sharing/apps/$grantAppId')) {
      return jsonResponse(sharingApp());
    }
    if (p.endsWith('/sharing') || p.endsWith('/sharing/revoke')) {
      if (r.method != 'GET') {
        final body = jsonDecode(r.body) as Json;
        value['share'] = {
          ...value['share'],
          'revision': libraryShare,
          if (p.endsWith('/revoke'))
            'status': 'revoked'
          else ...{
            'audience': body['audience'],
            'memberIds': body['memberIds'],
            'targetTeamId': body['targetTeamId'],
            if (body.containsKey('files'))
              'files': [
                for (final f in body['files']) {...sharingFile(), ...f},
              ],
            if (body.containsKey('apps'))
              'apps': [
                for (final a in body['apps']) {...sharingApp(), ...a},
              ],
          },
        };
      }
      return jsonResponse(value);
    }
    return jsonResponse({'error': 'Missing fixture'}, status: 404);
  }

  List<http.Request> get writes =>
      requests.where((r) => r.method == 'PUT' || r.method == 'POST').toList();
}
