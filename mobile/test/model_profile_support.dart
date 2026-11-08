import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:openbot_mobile/core/api.dart';

import 'support.dart';

Json modelProfile(String id, {String? name}) => {
  'id': id,
  'name': name ?? 'Profile $id',
  'provider': 'openai',
  'model': 'synthetic-model',
  'baseUrl': 'https://model.example.test/v1',
  'vision': false,
  'hasApiKey': true,
  'configured': true,
};

class ModelsServer {
  List<Json> profiles = [modelProfile('profile-a'), modelProfile('profile-b')];
  String activeId = 'profile-a';
  final List<http.Request> writes = [];
  Json get list => {'activeProfileId': activeId, 'profiles': profiles};
  Json get settings {
    final profile = profiles.firstWhere((p) => p['id'] == activeId);
    return {...profile, 'profileId': activeId, 'profileName': profile['name']};
  }

  Future<http.Response> handle(http.Request request) async {
    if (request.method == 'GET') {
      return jsonResponse(
        request.url.path.endsWith('/bootstrap')
            ? (bootstrap()..['settings'] = settings)
            : list,
      );
    }
    writes.add(request);
    final id = request.url.path.split('/').last;
    if (request.method == 'DELETE') {
      if (id == activeId) {
        return jsonResponse({'error': 'Default protected'}, status: 409);
      }
      profiles.removeWhere((p) => p['id'] == id);
      return jsonResponse({'ok': true});
    }
    if (id == 'activate') {
      activeId = request.url.path.split('/')[5];
      return jsonResponse(settings);
    }
    final body = jsonDecode(request.body) as Json;
    final profileId = body['id'] as String? ?? 'created-${writes.length}';
    final old = profiles.where((p) => p['id'] == profileId).firstOrNull;
    final keepKey =
        old != null &&
        old['provider'] == body['provider'] &&
        old['baseUrl'] == body['baseUrl'] &&
        body['clearApiKey'] != true;
    final profile = modelProfile(profileId)
      ..addAll({
        for (final key in ['name', 'provider', 'model', 'baseUrl', 'vision'])
          key: body[key],
        'hasApiKey':
            body['apiKey'] is String || (keepKey && old['hasApiKey'] == true),
      });
    profiles = [...profiles.where((p) => p['id'] != profileId), profile];
    return jsonResponse({'profile': profile, 'settings': settings});
  }
}
