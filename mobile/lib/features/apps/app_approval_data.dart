import '../../core/api.dart';

final _ruleId = RegExp(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$');
final _ownerSegment = RegExp(r'^[A-Za-z0-9-]{1,39}$');
final _repoSegment = RegExp(r'^[A-Za-z0-9_.-]{1,100}$');

class ExactAppRead {
  const ExactAppRead._(
    this.agentName,
    this.conversationTitle,
    this.connectionName,
    this.toolName,
    this.method,
    this.repository,
    this.issueNumber,
  );

  final String agentName, conversationTitle, connectionName, toolName, method;
  final String repository;
  final int issueNumber;

  static ExactAppRead? _parse({
    required Object? agentName,
    required Object? conversationTitle,
    required Object? connectionName,
    required Object? toolName,
    required Object? input,
  }) {
    if (agentName is! String ||
        agentName.trim().isEmpty ||
        conversationTitle is! String ||
        conversationTitle.trim().isEmpty ||
        connectionName is! String ||
        connectionName.trim().isEmpty ||
        toolName != 'issue_read' ||
        input is! Json ||
        input.length != 4 ||
        input['method'] != 'get') {
      return null;
    }
    final owner = input['owner'];
    final repo = input['repo'];
    final number = input['issue_number'];
    if (owner is! String ||
        repo is! String ||
        number is! int ||
        number < 1 ||
        number > 0x7fffffff ||
        !_ownerSegment.hasMatch(owner) ||
        repo == '.' ||
        repo == '..' ||
        !_repoSegment.hasMatch(repo)) {
      return null;
    }
    return ExactAppRead._(
      agentName,
      conversationTitle,
      connectionName,
      'issue_read',
      'get',
      '$owner/$repo',
      number,
    );
  }

  static ExactAppRead? forAction(Json action) {
    final permission = action['interactiveApproval'];
    final expiresAt = action['expiresAt'];
    if (action['status'] != 'pending' ||
        action['source'] != null ||
        action['policy'] != null ||
        permission is! Json ||
        permission['eligible'] != true ||
        expiresAt is! String ||
        DateTime.tryParse(expiresAt)?.isAfter(DateTime.now()) != true) {
      return null;
    }
    return _parse(
      agentName: permission['agentName'],
      conversationTitle: permission['conversationTitle'],
      connectionName: action['appName'],
      toolName: action['toolName'],
      input: action['arguments'],
    );
  }
}

String? appApprovalUsage(Object? value) {
  if (value is! Json ||
      value['ruleId'] is! String ||
      !_ruleId.hasMatch(value['ruleId'] as String)) {
    return null;
  }
  final usage = value['usage'];
  return usage == 'saved' || usage == 'reused' ? usage as String : null;
}

class AppApprovalRule {
  const AppApprovalRule._(this.id, this.read);
  final String id;
  final ExactAppRead read;

  static List<AppApprovalRule> list(Object? response) {
    const invalid = ApiException('INVALID_RESPONSE', 'requestFailed');
    final rules = response is Json ? response['rules'] : null;
    if (rules is! List || rules.length > 20) throw invalid;
    final parsed = <AppApprovalRule>[];
    final ids = <String>{};
    for (final row in rules) {
      final id = row is Json ? row['id'] : null;
      if (row is! Json ||
          id is! String ||
          !_ruleId.hasMatch(id) ||
          !ids.add(id)) {
        throw invalid;
      }
      final read = ExactAppRead._parse(
        agentName: row['agentName'],
        conversationTitle: row['conversationTitle'],
        connectionName: row['connectionName'],
        toolName: row['toolName'],
        input: row['input'],
      );
      if (read == null) throw invalid;
      parsed.add(AppApprovalRule._(id, read));
    }
    return parsed;
  }
}
