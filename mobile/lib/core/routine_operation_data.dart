import 'dart:convert';

import 'api.dart';
import 'request_ids.dart';
import 'routine_public_search.dart';

const routineConfigFields = [
  'agentId',
  'conversationId',
  'title',
  'prompt',
  'schedule',
  'timeZone',
  'enabled',
  routinePublicSearchField,
];

Json routineConfig(Json routine) => {
  for (final key in routineConfigFields)
    if (routine.containsKey(key))
      key: key == routinePublicSearchField && routine[key] is List
          ? List.of(routine[key] as List)
          : routine[key],
};
bool sameRoutineConfig(Json left, Json right) =>
    jsonEncode(routineConfig(left)) == jsonEncode(routineConfig(right));
Json cloneRoutineData(Json value) => jsonDecode(jsonEncode(value)) as Json;

String routineConfigError(ApiException error) => switch (error.code) {
  'ROUTINE_SEARCH_INVALID' => 'routinePublicSearchInvalid',
  'ROUTINE_SEARCH_SCOPE_CHANGED' => 'routinePublicSearchChanged',
  'ROUTINE_SEARCH_TARGET' => 'routinePublicSearchTarget',
  'ROUTINE_WEBHOOK_TARGET' => 'routineWebhookTarget',
  _ => error.message,
};

Json parseRoutinePending(
  String raw,
  String actor,
  String workspace,
  String agent,
) {
  final value = jsonDecode(raw);
  if (value is! Json ||
      value['version'] != 1 ||
      value['userId'] != actor ||
      value['workspaceId'] != workspace ||
      value['agentId'] != agent ||
      value['body'] is! Json) {
    throw const ApiException('INVALID_PENDING', 'routineRecoveryInvalid');
  }
  final body = value['body'] as Json;
  if (!isRequestId(body['requestId']) ||
      !['create', 'run'].contains(body['kind'])) {
    throw const ApiException('INVALID_PENDING', 'routineRecoveryInvalid');
  }
  final config = body['kind'] == 'create' ? body : body['expectedRoutine'];
  if (config is! Json ||
      config['agentId'] != agent ||
      !routinePublicSearchConfigValid(config) ||
      (body['kind'] == 'run' &&
          (body['routineId'] is! String ||
              (body['routineId'] as String).isEmpty))) {
    throw const ApiException('INVALID_PENDING', 'routineRecoveryInvalid');
  }
  final allowed = body['kind'] == 'create'
      ? {'kind', 'requestId', ...routineConfigFields}
      : {'kind', 'requestId', 'routineId', 'expectedRoutine'};
  if (body.keys.any((key) => !allowed.contains(key)) ||
      (body['kind'] == 'run' &&
          config.keys.any((key) => !routineConfigFields.contains(key)))) {
    throw const ApiException('INVALID_PENDING', 'routineRecoveryInvalid');
  }
  return value;
}

void validateRoutineReceipt(Json value, Json pending) {
  final body = pending['body'] as Json;
  final config = body['kind'] == 'create'
      ? body
      : body['expectedRoutine'] as Json;
  final statuses = body['kind'] == 'create'
      ? ['created', 'missing']
      : [
          'submitted',
          'completed',
          'error',
          'cancelled',
          'interrupted',
          'missing',
        ];
  if (value['requestId'] != body['requestId'] ||
      value['kind'] != body['kind'] ||
      value['userId'] != pending['userId'] ||
      value['workspaceId'] != pending['workspaceId'] ||
      value['agentId'] != pending['agentId'] ||
      !statuses.contains(value['status']) ||
      value['routineId'] is! String ||
      (value['routineId'] as String).isEmpty ||
      value['conversationId'] is! String ||
      (value['conversationId'] as String).isEmpty ||
      (config['conversationId'] != null &&
          value['conversationId'] != config['conversationId']) ||
      (body['kind'] == 'run' &&
          (value['routineId'] != body['routineId'] ||
              value['messageId'] is! String ||
              (value['messageId'] as String).isEmpty))) {
    throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
  }
}
