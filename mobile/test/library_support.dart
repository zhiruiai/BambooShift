import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'support.dart';

const libraryRevision = '20000000-0000-4000-8000-000000000001';
const libraryShare = '20000000-0000-4000-8000-000000000002';
final libraryToken = 'T' * 43;
Json libraryBlueprint() => {
  'version': 1,
  'profile': {
    'name': 'Research Bot',
    'role': 'Research',
    'description': 'Public description',
    'instructions': 'Exact synthetic instructions',
    'avatar': 'leaf',
    'color': '#76568d',
  },
  'skills': [
    {
      'name': 'Review',
      'description': 'Active skill',
      'content': 'Exact skill content',
    },
  ],
  'routines': [
    {
      'title': 'Daily review',
      'prompt': 'Review changes',
      'schedule': 'daily:09:00',
      'timeZone': 'America/New_York',
      'enabled': true,
    },
  ],
};
Json libraryTemplate() => {
  'token': libraryToken,
  'revision': libraryRevision,
  'digest': 'b' * 64,
  'audience': 'public',
  'blueprint': libraryBlueprint(),
  'publishedAt': '2026-11-01T00:00:00Z',
};
Json libraryShared() => {
  'id': libraryShare,
  'name': 'Live Bot',
  'role': 'Research',
  'description': 'Maintained profile',
  'avatar': 'leaf',
  'color': '#76568d',
  'ownerName': 'Publisher',
  'teamName': 'Synthetic team',
  'sourceWorkspaceName': 'Publisher space',
  'targetTeamId': libraryShare,
  'sourceRevision': 'a' * 64,
  'skillCount': 1,
  'fileCount': 0,
  'appCount': 0,
};
Json libraryAccount() => {
  'authenticated': true,
  'user': {'id': 'user-a'},
  'workspaces': [
    {
      'id': 'space-a',
      'name': 'Team space',
      'kind': 'team',
      'role': 'owner',
      'status': 'active',
    },
    {
      'id': 'space-b',
      'name': 'My personal space',
      'kind': 'personal',
      'role': 'owner',
      'status': 'active',
    },
    {
      'id': 'space-c',
      'name': 'Other team',
      'kind': 'team',
      'role': 'member',
      'status': 'active',
    },
  ],
};

class LibraryServer {
  final List<http.Request> requests = [];
  final Map<String, Json> receipts = {};
  Json snapshot = bootstrap();
  bool missingBot = false, revoked = false;
  int installs = 0;
  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    final path = r.url.path;
    if (path == '/api/account/session') return jsonResponse(libraryAccount());
    if (path.endsWith('/bootstrap')) {
      return jsonResponse(missingBot ? bootstrap() : snapshot);
    }
    if (path == '/api/bot-template-gallery') {
      return jsonResponse([
        {
          'token': libraryToken,
          ...libraryBlueprint()['profile'],
          'audience': 'public',
          'skillCount': 1,
          'routineCount': 1,
        },
      ]);
    }
    if (path.startsWith('/api/bot-template-links/')) {
      return revoked
          ? jsonResponse({'error': 'Revoked'}, status: 404)
          : jsonResponse(libraryTemplate());
    }
    if (path == '/api/shared-bots') return jsonResponse([libraryShared()]);
    if (path == '/api/shared-bots/$libraryShare') {
      return jsonResponse(libraryShared());
    }
    if (r.method == 'GET') {
      final value = receipts[path.split('/').last];
      return value == null
          ? jsonResponse({'error': 'Missing'}, status: 404)
          : jsonResponse(value);
    }
    final body = jsonDecode(r.body) as Json;
    final prior = receipts[body['requestId']];
    if (prior != null) return jsonResponse(prior);
    installs++;
    final shared = path.endsWith('/shared-bot-references');
    final wid = path.split('/')[3];
    final receipt = <String, dynamic>{
      'requestId': body['requestId'],
      'agentId': 'installed-bot',
      'conversationId': 'installed-chat',
      'createdAt': '2026-11-01T00:00:00Z',
      if (shared) ...{
        'shareId': body['shareId'],
        'actorId': 'user-a',
        'workspaceId': wid,
      } else ...{
        'skillIds': ['skill-new'],
        'routineIds': ['routine-new'],
      },
    };
    receipts[body['requestId']] = receipt;
    snapshot = {
      'agents': [
        {
          'id': 'installed-bot',
          'name': 'Imported',
          if (shared)
            'sharedBot': {
              'shareId': libraryShare,
              'status': 'active',
              'sourceRevision': 'a' * 64,
            },
        },
      ],
      'conversations': [
        {
          'id': 'installed-chat',
          'isGroup': false,
          'agentIds': ['installed-bot'],
        },
      ],
      'messages': [],
      'sync': {'epoch': 'fresh', 'revision': 1},
    };
    return jsonResponse(receipt, status: 201);
  }

  List<http.Request> get posts =>
      requests.where((r) => r.method == 'POST').toList();
}
