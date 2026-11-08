part of 'teaching_controller.dart';

extension TeachingRequests on TeachingController {
  Json _marker(String kind, String id, String conversation, {Json? body}) => {
    'version': 1,
    'operationId': requestId(),
    'id': id,
    'agentId': computer.agentId,
    'conversationId': conversation,
    'userId': scope.userId,
    'workspaceId': scope.workspaceId,
    'kind': kind,
    if (body?['expectedRevision'] != null)
      'expectedRevision': body!['expectedRevision'],
    if (body?['requestId'] != null) 'requestId': body!['requestId'],
  };
  Future<void> _observed(Json marker, Json next, {bool direct = false}) async {
    final kind = marker['kind'];
    final known =
        direct ||
        kind == 'idle' ||
        kind == 'start' ||
        (kind == 'stop' && next['status'] != 'recording') ||
        (kind == 'review' && next['revision'] != marker['expectedRevision']) ||
        (kind == 'generate' &&
            next['generationRequestId'] == marker['requestId']) ||
        // A stale non-running record cannot prove a cancellation was committed.
        // A proposal is immutable for cancellation, so observing it is conclusive.
        (kind == 'cancel' && next['status'] == 'proposed');
    if (known && kind != 'idle') {
      await recovery.replace(
        _marker('idle', next['id'], next['conversationId']),
        marker,
      );
      guard();
    }
    _accept(next, load: direct);
    if (!known) {
      error = 'mobileTeachingUnknown';
    }
  }

  Future<void> _write(
    String kind,
    String path,
    Json body, {
    String method = 'POST',
  }) async {
    final id = record?['id'] ?? body['requestId'];
    final conversation = record?['conversationId'] ?? body['conversationId'];
    final marker = _marker(kind, id, conversation, body: body);
    await recovery.replace(marker, pending);
    guard();
    notify();
    final raw = await send(method, path, body);
    final next = teachingRecord(
      raw,
      computer.agentId,
      conversation: conversation,
      id: id,
    );
    if (kind == 'generate' &&
        next['generationRequestId'] != body['requestId']) {
      invalidTeaching();
    }
    await _observed(marker, next, direct: true);
  }

  Future<void> start() async {
    if (!canStart) {
      return;
    }
    final lease = computer.lease!, binding = computer.status!.fingerprint;
    final conversation = teachingConversation(scope, computer.agentId)!;
    final revision = scope.find('agents', computer.agentId)?['configRevision'];
    await work(() async {
      _leaseId = lease.id;
      _binding = binding;
      _botRevision = revision;
      final id = requestId();
      final marker = _marker('start', id, conversation);
      await recovery.replace(marker, null);
      guard();
      notify();
      if (computer.lease != lease ||
          lease.expired ||
          !computer.visible ||
          computer.status?.fingerprint != binding ||
          teachingConversation(scope, computer.agentId) != conversation ||
          scope.find('agents', computer.agentId)?['configRevision'] !=
              revision) {
        throw const ApiException(
          'BINDING_CHANGED',
          'mobileTeachingBindingChanged',
        );
      }
      final next = teachingRecord(
        await send('POST', '/teaching', {
          'requestId': id,
          'agentId': computer.agentId,
          'conversationId': conversation,
          'leaseId': lease.id,
        }),
        computer.agentId,
        conversation: conversation,
        id: id,
      );
      await _observed(marker, next, direct: true);
    });
  }

  Future<void> stop() => work(() async {
    if (uncertain || computer.busy || record?['status'] != 'recording') {
      return;
    }
    await _write('stop', '/teaching/${record!['id']}/stop', {});
  });
  Future<void> save() => work(() async {
    if (uncertain ||
        !local ||
        record == null ||
        draft == null ||
        changed ||
        !['review', 'interrupted', 'error'].contains(record!['status'])) {
      return;
    }
    await _write('review', '/teaching/${record!['id']}', {
      'expectedRevision': baseRevision,
      ...draft!,
    }, method: 'PATCH');
  });
  Future<void> generate() => work(() async {
    if (uncertain ||
        !local ||
        record == null ||
        dirty ||
        changed ||
        selectedModel == null ||
        !['review', 'interrupted', 'error'].contains(record!['status']) ||
        (record!['interrupted'] == true && !acceptPartial) ||
        (record!['steps'] as List).isEmpty ||
        (record!['goal'] as String).trim().isEmpty) {
      return;
    }
    final selected = selectedModel;
    await _models();
    if (selectedModel != selected) {
      throw const ApiException('MODEL_CHANGED', 'mobileTeachingModelChanged');
    }
    await _write('generate', '/teaching/${record!['id']}/generate', {
      'requestId': requestId(),
      'expectedRevision': record!['revision'],
      'profileId': selected,
      'acceptInterrupted': acceptPartial,
    });
  });
  Future<void> cancel() => work(() async {
    if (pending == null) {
      return;
    }
    final marker = _marker(
      'cancel',
      pending!['id'],
      pending!['conversationId'],
    );
    await recovery.replace(marker, pending);
    guard();
    final raw = await send('POST', '/teaching/${marker['id']}/cancel', {});
    if (raw is Json && raw['status'] == 'closed' && raw['id'] == marker['id']) {
      await recovery.clear(marker);
      guard();
      record = null;
      draft = null;
      _leaseId = null;
    } else {
      await _observed(
        marker,
        teachingRecord(
          raw,
          computer.agentId,
          conversation: marker['conversationId'],
          id: marker['id'],
        ),
        direct: true,
      );
    }
  });
}
