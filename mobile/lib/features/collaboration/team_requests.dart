part of 'team_controller.dart';

extension TeamRequests on TeamController {
  Future<void> _write(
    String kind,
    String path,
    Json body, {
    Json? replacing,
  }) async {
    final marker = <String, dynamic>{
      'version': 1,
      'operationId': requestId(),
      'kind': kind,
      if (kind != 'start') 'planId': plan?['id'] ?? observed?['id'],
      if (body['requestId'] != null) 'requestId': body['requestId'],
      if (body['expectedRevision'] != null)
        'expectedRevision': body['expectedRevision'],
    };
    await recovery.claim(marker, replacing: replacing);
    guard();
    _body = copyJson(body);
    _path = path;
    await _dispatch(marker);
  }

  Future<void> _dispatch(Json marker) async {
    final value = await send('POST', _path!, _body);
    await _result(marker, value);
  }

  Future<void> _result(Json marker, Object? value) async {
    if (marker['kind'] == 'startChat') {
      if (value is! Json || !_matchesStart(value['message'])) {
        throw const ApiException('INVALID_MESSAGE', 'requestUnknown');
      }
      await recovery.clear(marker);
      guard();
      _body = null;
      _path = null;
      notice = 'mobileCollaborationStarted';
      return;
    }
    final next = teamPlan(
      marker['kind'] == 'catalog' && value is Json ? value['plan'] : value,
    );
    if ((marker['kind'] == 'start' &&
            next['requestId'] != marker['requestId']) ||
        (marker['kind'] != 'start' && next['id'] != marker['planId']) ||
        (marker['kind'] == 'commit' && next['status'] != 'committed')) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    if (marker['kind'] == 'catalog' &&
        (value is! Json ||
            value['requestId'] != marker['requestId'] ||
            value['planId'] != marker['planId'] ||
            !isRequestId(value['appliedRevision']))) {
      throw const ApiException('INVALID_RECEIPT', 'requestUnknown');
    }
    await recovery.clear(marker);
    guard();
    if (marker['kind'] == 'catalog' &&
        (value as Json)['appliedRevision'] != next['revision']) {
      observed = next;
      notice = 'mobileCollaborationChanged';
    } else {
      accept(next, replace: true);
      notice = 'mobileCollaborationSaved';
    }
    _body = null;
    _path = null;
  }

  Future<void> retry() => work(() async {
    final marker = pending;
    if (marker == null) return;
    if (_body == null && marker['kind'] == 'cancel') {
      _body = {};
      _path = '/bot-team-plans/${marker['planId']}/cancel';
    }
    if (_body == null &&
        marker['kind'] == 'startChat' &&
        plan?['status'] == 'committed' &&
        plan?['id'] == marker['planId']) {
      _body = {
        'clientId': plan!['id'],
        'content': plan!['goal'],
        'agentId': plan!['result']['leadAgentId'],
        'mode': 'followUp',
      };
      _path = '/conversations/${plan!['result']['conversationId']}/messages';
    }
    if (_body != null) await _dispatch(marker);
  });
  Future<void> check() => work(_check);
  Future<void> _check() async {
    final p = pending;
    if (p == null) {
      if (plan != null) {
        accept(teamPlan(await send('GET', '/bot-team-plans/${plan!['id']}')));
      }
      return;
    }
    if (p['kind'] == 'start') {
      final rows = await send(
        'GET',
        '/bot-team-plans?requestId=${p['requestId']}',
      );
      if (rows is! List || rows.length > 1) {
        throw const ApiException(
          'INVALID_HISTORY',
          'mobileCollaborationInvalid',
        );
      }
      if (rows.isEmpty) {
        error = 'mobileCollaborationUnknown';
        return;
      }
      await _result(p, rows.single);
      return;
    }
    if (p['kind'] == 'catalog') {
      try {
        await _result(
          p,
          await send(
            'GET',
            '/bot-team-plans/${p['planId']}/catalog-refreshes/${p['requestId']}',
          ),
        );
        return;
      } on ApiException catch (e) {
        if (e.status != 404) rethrow;
      }
    }
    final current = teamPlan(
      await send('GET', '/bot-team-plans/${p['planId']}'),
    );
    if (p['kind'] == 'startChat') {
      plan = current;
      final snapshot = await send('GET', '/bootstrap');
      if (snapshot is Json &&
          (snapshot['messages'] as List? ?? []).any(_matchesStart)) {
        await recovery.clear(p);
        guard();
        _body = null;
        _path = null;
        notice = 'mobileCollaborationStarted';
      } else {
        error = 'mobileCollaborationUnknown';
      }
      return;
    }
    if (current['status'] == 'committed' ||
        (p['kind'] == 'cancel' && current['status'] == 'cancelled')) {
      await recovery.clear(p);
      guard();
      accept(current, replace: true);
      _body = null;
      _path = null;
      return;
    }
    observed = current;
    error = 'mobileCollaborationUnknown';
  }

  Future<void> continueEditing() => work(() async {
    final fresh = observed, p = pending;
    if (fresh == null) return;
    if (p == null) {
      accept(fresh, replace: true);
      return;
    }
    if (p['kind'] == 'startChat' ||
        p['kind'] == 'start' ||
        p['kind'] == 'cancel') {
      return;
    }
    if (fresh['revision'] != p['expectedRevision'] ||
        fresh['status'] != 'ready') {
      await recovery.clear(p);
      guard();
      final kept = draft;
      accept(fresh, replace: true);
      if (kept != null && fresh['status'] == 'ready') draft = kept;
      _body = null;
      _path = null;
      return;
    }
    plan = fresh;
    await _write('revise', '/bot-team-plans/${fresh['id']}/revise', {
      'expectedRevision': fresh['revision'],
      'draft': copyJson(draft ?? fresh['draft'] as Json),
    }, replacing: p);
  });
}
