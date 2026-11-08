import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';
import 'library_support.dart';
import 'support.dart';

const templateId = '20000000-0000-4000-8000-000000000003';
const templateDraft = '20000000-0000-4000-8000-000000000004';
Json ownedLibraryTemplate() => {
  'id': templateId,
  'revision': libraryRevision,
  'draftRevision': templateDraft,
  'sourceAgentId': 'bot-a',
  'sourceConversationId': 'chat-a',
  'blueprint': libraryBlueprint(),
  'projectionPending': false,
};

class TemplateServer {
  final requests = <http.Request>[];
  final receipts = <String, Json>{};
  Json template = ownedLibraryTemplate();
  String sourceRevision = 'a' * 64;
  bool projectionPending = false;
  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    final path = r.url.path;
    if (path == '/api/account/session') return jsonResponse(libraryAccount());
    if (path.endsWith('/bootstrap')) {
      return jsonResponse(
        bootstrap(
          agents: [
            {'id': 'bot-a', ...libraryBlueprint()['profile']},
            {'id': 'managed', 'name': 'Managed', 'sharedBot': {}},
          ],
        ),
      );
    }
    if (path.endsWith('/bot-copy-source/bot-a')) {
      return jsonResponse({
        'sourceRevision': sourceRevision,
        'blueprint': libraryBlueprint(),
      });
    }
    if (r.method == 'GET' && path.endsWith('/bot-templates')) {
      final id = r.url.queryParameters['requestId'];
      return jsonResponse(
        id == null ? [template] : [if (receipts[id] != null) receipts[id]],
      );
    }
    if (r.method == 'GET' && path.endsWith('/$templateId')) {
      return jsonResponse(template);
    }
    if (r.method == 'POST' || r.method == 'PATCH') {
      final body = jsonDecode(r.body) as Json;
      if (path.endsWith('/sync')) {
        template['projectionPending'] = false;
        return jsonResponse(template);
      }
      if (receipts[body['requestId']] != null) {
        return jsonResponse(receipts[body['requestId']]!);
      }
      template = {...template, 'projectionPending': projectionPending};
      if (body['blueprint'] != null) template['blueprint'] = body['blueprint'];
      if (path.endsWith('/publish')) {
        template['publication'] = {
          'revision': templateDraft,
          'audience': body['audience'],
          'path': '/templates/$libraryToken',
        };
      }
      if (path.endsWith('/revoke')) template.remove('publication');
      receipts[body['requestId']] = Map.of(template);
      return jsonResponse(template);
    }
    return jsonResponse({'error': 'Missing fixture'}, status: 404);
  }

  List<http.Request> get mutations =>
      requests.where((r) => r.method == 'POST' || r.method == 'PATCH').toList();
}
