import '../../core/api.dart';

const usageFields = [
  'modelTurns',
  'reportedTurns',
  'unreportedTurns',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
];

bool validUsageTotals(Object? value) =>
    value is Json &&
    usageFields.every((key) => value[key] is int && value[key] >= 0) &&
    value['modelTurns'] == value['reportedTurns'] + value['unreportedTurns'];

Json checkedUsage(
  Json value,
  String user,
  String workspace,
  int days,
  bool owner,
) {
  final scope = value['scope'], period = value['period'];
  bool date(Object? value) =>
      value is String && DateTime.tryParse(value)?.isUtc == true;
  bool rows(String key, bool Function(Json) valid) =>
      value[key] is List &&
      (value[key] as List).every(
        (row) => row is Json && validUsageTotals(row['totals']) && valid(row),
      );
  if (scope is! Json ||
      scope['userId'] != user ||
      scope['workspaceId'] != workspace ||
      scope['visibility'] != (owner ? 'workspace' : 'self') ||
      period is! Json ||
      period['days'] != days ||
      period['timeZone'] != 'UTC' ||
      !date(period['since']) ||
      !date(period['until']) ||
      DateTime.parse(
        period['since'],
      ).isAfter(DateTime.parse(period['until'])) ||
      value['cost'] != null ||
      !value.containsKey('cost') ||
      !validUsageTotals(value['totals']) ||
      !rows(
        'byDay',
        (r) =>
            r['day'] is String &&
            RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(r['day']),
      ) ||
      !rows(
        'byBot',
        (r) =>
            (r['agentId'] == null || r['agentId'] is String) &&
            (r['name'] == null || r['name'] is String),
      ) ||
      !rows(
        'byModel',
        (r) => r['provider'] is String && r['model'] is String,
      )) {
    throw const ApiException('INVALID_USAGE', 'mobileWorkspaceUsageInvalid');
  }
  return value;
}
