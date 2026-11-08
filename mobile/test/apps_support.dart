import 'package:openbot_mobile/core/api.dart';

Json connectedApp({
  String id = 'app-a',
  String revision = 'rev-a',
  String auth = 'none',
  String status = 'connected',
  String name = 'Example',
}) => {
  'id': id,
  'revision': revision,
  'name': name,
  'url': 'https://mcp.example.test/$id',
  'authType': auth,
  'status': status,
  'hasCredential': auth != 'none',
  'toolCount': 1,
};

Json oauthFlow({
  String status = 'pending',
  String revision = 'rev-b',
  String id = 'flow-a',
  String connectionId = 'app-a',
}) => {
  'id': id,
  'connectionId': connectionId,
  'connectionRevision': revision,
  'status': status,
  'appName': 'Example',
  'expiresAt': '2030-01-01T00:00:00Z',
  'scopes': ['read'],
  'authorizationOrigin': 'https://provider.example.test',
};

Json appDraft({String name = 'New', String auth = 'none'}) => {
  'name': name,
  'url': 'https://mcp.example.test/new',
  'authType': auth,
  'shared': true,
  if (auth == 'bearer') 'token': 'synthetic-access-token',
};
