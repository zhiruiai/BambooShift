import '../../core/api.dart';

const modelFields = ['name', 'provider', 'model', 'baseUrl', 'vision'];
Json publicModel(Json source) {
  final id = source['id'];
  if (id is! String ||
      !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(id) ||
      [
        'name',
        'provider',
        'model',
        'baseUrl',
      ].any((key) => source[key] is! String) ||
      source['vision'] is! bool) {
    throw const ApiException('INVALID_MODEL_PROFILE', 'requestFailed');
  }
  return {
    'id': id,
    for (final field in modelFields) field: source[field],
    'hasApiKey': source['hasApiKey'] == true,
    'configured': source['configured'] == true,
  };
}

Json? activeModel(Json? settings) {
  if (settings == null || settings['profileId'] is! String) return null;
  return publicModel({
    'id': settings['profileId'],
    'name': settings['profileName'] ?? settings['model'],
    'provider': settings['provider'],
    'model': settings['model'],
    'baseUrl': settings['baseUrl'] ?? '',
    'vision': settings['vision'] == true,
    'hasApiKey': settings['hasApiKey'] == true,
    'configured': settings['configured'] == true,
  });
}

Json newModel() => {
  'name': '',
  'provider': 'openai',
  'model': '',
  'baseUrl': '',
  'vision': false,
};

String? endpointProblem(String text) {
  if (text.trim().isEmpty) return null;
  final value = Uri.tryParse(text.trim());
  if (value == null ||
      !['http', 'https'].contains(value.scheme) ||
      value.host.isEmpty ||
      value.userInfo.isNotEmpty ||
      value.hasQuery ||
      value.hasFragment) {
    return 'mobileModelsEndpointInvalid';
  }
  return null;
}
