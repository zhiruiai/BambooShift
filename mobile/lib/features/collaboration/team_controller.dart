import 'package:flutter/foundation.dart';
import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import 'team_data.dart';
import 'team_pending.dart';

part 'team_requests.dart';

class TeamController extends ChangeNotifier {
  TeamController(this.scope) : recovery = TeamPending(scope) {
    scope.session.addListener(_identity);
  }
  final WorkspaceController scope;
  final TeamPending recovery;
  final cancellation = ByteReadCancellation();
  Json? plan, draft, observed, review;
  Json? _body;
  String? _path, error, notice;
  String goal = '';
  List<Json> history = [];
  bool busy = false, ready = false, blocked = false, _closed = false;
  int editorVersion = 0;
  bool get active => !_closed && scope.active && scope.owner;
  Json? get pending => recovery.value;
  bool get editable =>
      active &&
      ready &&
      !busy &&
      !blocked &&
      pending == null &&
      observed == null &&
      plan?['status'] == 'ready';
  bool get dirty =>
      draft != null && canonical(draft) != canonical(plan?['draft']);
  bool get canRetry =>
      active &&
      !busy &&
      pending != null &&
      (_body != null ||
          pending!['kind'] == 'cancel' ||
          (pending!['kind'] == 'startChat' &&
              plan?['status'] == 'committed' &&
              plan?['id'] == pending!['planId']));
  void guard() {
    scope.guard();
    if (!active) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  void notify() {
    if (!_closed) notifyListeners();
  }

  void _identity() {
    if (!active) {
      cancellation.cancel();
      _body = null;
      draft = null;
      review = null;
    }
    notify();
  }

  Future<Object?> send(String method, String path, [Json? body]) async {
    guard();
    final value = await scope.requestValue(
      method,
      path,
      body: body,
      cancellation: cancellation,
    );
    guard();
    return value;
  }

  Future<void> work(Future<void> Function() action) async {
    if (!active || busy) return;
    busy = true;
    error = null;
    notice = null;
    notify();
    try {
      await action();
    } catch (e) {
      if (active) error = e is ApiException ? e.message : 'requestUnknown';
    } finally {
      if (!_closed) {
        busy = false;
        notify();
      }
    }
  }

  void accept(Json next, {bool replace = false}) {
    if (!replace &&
        plan?['id'] == next['id'] &&
        dirty &&
        next['status'] == 'ready') {
      if (plan?['revision'] != next['revision']) observed = next;
      return;
    }
    plan = next;
    goal = next['goal'];
    draft = next['draft'] is Json ? copyJson(next['draft']) : null;
    observed = null;
    review = null;
    editorVersion++;
  }

  Future<void> initialize([String? initialPlanId]) => work(() async {
    try {
      await recovery.load();
      guard();
    } catch (_) {
      blocked = true;
      rethrow;
    }
    ready = true;
    if (pending != null) {
      await _check();
    } else if (initialPlanId != null) {
      if (!isRequestId(initialPlanId)) {
        throw const ApiException('INVALID_PLAN', 'mobileCollaborationInvalid');
      }
      accept(
        teamPlan(await send('GET', '/bot-team-plans/$initialPlanId')),
        replace: true,
      );
    }
    await _history();
  });
  Future<void> _history() async {
    final rows = await send('GET', '/bot-team-plans');
    if (rows is! List || rows.length > 20) {
      throw const ApiException('INVALID_HISTORY', 'mobileCollaborationInvalid');
    }
    history = rows.map(teamPlan).toList();
  }

  Future<void> listHistory() => work(_history);
  Future<void> load(String id) => work(() async {
    if (pending != null || !isRequestId(id)) return;
    accept(teamPlan(await send('GET', '/bot-team-plans/$id')), replace: true);
  });
  void newPlan() {
    if (!active || busy || pending != null) return;
    final previousGoal = plan?['status'] == 'error' ? goal : '';
    plan = null;
    draft = null;
    observed = null;
    review = null;
    goal = previousGoal;
    editorVersion++;
    notify();
  }

  void changeGoal(String value) {
    if (active && !busy && pending == null && plan == null) {
      goal = value;
      notify();
    }
  }

  void update(Json value) {
    if (!editable) return;
    draft = copyJson(value);
    review = null;
    notify();
  }

  String get starterLanguage =>
      scope.session.api.language == 'en' ? 'en' : 'zh-CN';

  Future<List<Json>> starterTemplates(String language) async {
    if (starterLanguage != language) {
      throw const ApiException(
        'STALE_LANGUAGE',
        'mobileTeamStarterLocaleChanged',
      );
    }
    final rows = await send('GET', '/bot-team-templates');
    if (rows is! List ||
        rows.length > 20 ||
        rows.any(
          (row) =>
              row is! Json ||
              !identifier(row['id']) ||
              draftProblem(row['draft'], const [], commit: true) != null ||
              (row['draft']['members'] as List).any(
                (member) => member['kind'] != 'create',
              ),
        )) {
      throw const ApiException(
        'INVALID_TEMPLATES',
        'mobileCollaborationInvalid',
      );
    }
    return rows.cast<Json>();
  }

  Future<void> start({Json? template, String? templateLanguage}) =>
      work(() async {
        final nextGoal = goal.trim().isEmpty && template != null
            ? template['draft']['summary']
            : goal;
        if (!ready ||
            blocked ||
            plan != null ||
            pending != null ||
            !boundedText(nextGoal, 6000, empty: false) ||
            (template != null && templateLanguage != starterLanguage) ||
            (template == null &&
                scope.data?['settings']?['configured'] != true)) {
          return;
        }
        await _write('start', '/bot-team-plans', {
          'requestId': requestId(),
          'goal': nextGoal,
          if (template != null)
            'template': {'id': template['id'], 'language': templateLanguage},
        });
      });
  Future<void> save({bool commit = false}) => work(() async {
    if (pending != null ||
        observed != null ||
        plan?['status'] != 'ready' ||
        draft == null) {
      return;
    }
    final issue = draftProblem(draft, scope.items('agents'), commit: commit);
    if (issue != null) throw ApiException('INVALID_DRAFT', issue);
    await _write(
      commit ? 'commit' : 'revise',
      '/bot-team-plans/${plan!['id']}/${commit ? 'commit' : 'revise'}',
      {
        if (commit) 'requestId': requestId(),
        'expectedRevision': plan!['revision'],
        'draft': copyJson(draft!),
      },
    );
  });
  Future<void> cancelPlan() => work(() async {
    if (pending != null || plan == null || plan!['status'] == 'committed') {
      return;
    }
    await _write('cancel', '/bot-team-plans/${plan!['id']}/cancel', {});
  });
  Future<void> reviewBots() => work(() async {
    if (pending != null ||
        observed != null ||
        plan?['status'] != 'ready' ||
        draft == null) {
      return;
    }
    final value = await send(
      'POST',
      '/bot-team-plans/${plan!['id']}/review-bots',
      {'expectedRevision': plan!['revision'], 'draft': copyJson(draft!)},
    );
    if (value is! Json ||
        value['planId'] != plan!['id'] ||
        value['expectedRevision'] != plan!['revision'] ||
        value['reviewToken'] is! String ||
        value['members'] is! List) {
      throw const ApiException('INVALID_REVIEW', 'mobileCollaborationInvalid');
    }
    final selected = (draft!['members'] as List)
        .where((m) => m['kind'] == 'reuse')
        .toList();
    final rows = value['members'] as List;
    if (rows.length != selected.length ||
        rows.any(
          (r) =>
              r is! Json ||
              !{'unchanged', 'changed', 'added'}.contains(r['state']) ||
              r['profile'] is! Json ||
              !selected.any(
                (m) => m['key'] == r['key'] && m['agentId'] == r['agentId'],
              ) ||
              !boundedText(r['profile']['name'], 40, empty: false) ||
              !boundedText(r['profile']['role'], 80, empty: false) ||
              !boundedText(r['profile']['description'], 1000) ||
              !boundedText(r['profile']['instructions'], 16000),
        )) {
      throw const ApiException('INVALID_REVIEW', 'mobileCollaborationInvalid');
    }
    review = value;
  });
  Future<void> acceptReview() => work(() async {
    if (pending != null ||
        review == null ||
        draft == null ||
        plan?['revision'] != review!['expectedRevision']) {
      return;
    }
    await _write('catalog', '/bot-team-plans/${plan!['id']}/refresh-bots', {
      'requestId': requestId(),
      'expectedRevision': plan!['revision'],
      'draft': copyJson(draft!),
      'reviewToken': review!['reviewToken'],
    });
  });
  bool _matchesStart(Object? message) =>
      message is Json &&
      plan?['status'] == 'committed' &&
      message['role'] == 'user' &&
      message['userId'] == scope.userId &&
      message['content'] == plan!['goal'] &&
      message['conversationId'] == plan!['result']['conversationId'] &&
      message['delivery'] is Json &&
      message['delivery']['agentId'] == plan!['result']['leadAgentId'] &&
      message['delivery']['explicitAgentId'] ==
          plan!['result']['leadAgentId'] &&
      message['delivery']['clientId'] == plan!['id'];
  Future<String?> conversation({bool start = false}) async {
    String? id;
    await work(() async {
      if (plan?['status'] != 'committed' || pending != null) return;
      final latest = teamPlan(
        await send('GET', '/bot-team-plans/${plan!['id']}'),
      );
      final result = teamResult(latest['result']);
      final value = await send('GET', '/bootstrap');
      if (value is! Json) {
        throw const ApiException('MISSING_CHAT', 'unavailable');
      }
      final chat = (value['conversations'] as List? ?? [])
          .whereType<Json>()
          .where(
            (c) => c['id'] == result['conversationId'] && c['isGroup'] == true,
          )
          .firstOrNull;
      final agents = (value['agents'] as List? ?? [])
          .whereType<Json>()
          .map((a) => a['id'])
          .toSet();
      if (chat == null ||
          chat['agentIds'] is! List ||
          (chat['agentIds'] as List).isEmpty ||
          !(chat['agentIds'] as List).every(agents.contains)) {
        throw const ApiException('MISSING_CHAT', 'unavailable');
      }
      plan = latest;
      if (start) {
        if (!(chat['agentIds'] as List).contains(result['leadAgentId'])) {
          throw const ApiException('MISSING_LEAD', 'unavailable');
        }
        await _write(
          'startChat',
          '/conversations/${result['conversationId']}/messages',
          {
            'clientId': latest['id'],
            'content': latest['goal'],
            'agentId': result['leadAgentId'],
            'mode': 'followUp',
          },
        );
      }
      guard();
      id = result['conversationId'] as String;
    });
    return id;
  }

  @override
  void dispose() {
    _closed = true;
    cancellation.cancel();
    _body = null;
    scope.session.removeListener(_identity);
    super.dispose();
  }
}
