import '../../core/api.dart';
import '../../core/bot_access.dart';
import '../../core/byte_read.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../apps/app_catalog.dart';
import '../apps/custom_mcp_target.dart';
import 'team_data.dart';

Json? appProposal(Json message) {
  final metadata = message['metadata'];
  final value = metadata is Json ? metadata['appConnectionProposal'] : null;
  if (message['role'] != 'assistant' ||
      message['kind'] != 'app_connection_proposal' ||
      message['status'] != 'done' ||
      !identifier(message['id']) ||
      !identifier(message['agentId']) ||
      !identifier(message['conversationId']) ||
      value is! Json ||
      !boundedText(value['reason'], 300, empty: false) ||
      !identifier(value['runId']) ||
      !identifier(value['toolCallId'])) {
    return null;
  }
  final custom = value['kind'] == 'custom_mcp';
  final allowed = {
    'reason',
    'runId',
    'toolCallId',
    'requester',
    if (custom) ...{'kind', 'url', 'name'} else 'providerId',
  };
  if (value.keys.any((key) => !allowed.contains(key)) ||
      (custom
          ? customMcpTarget(value) == null
          : !appProviderIds.contains(value['providerId']))) {
    return null;
  }
  final who = value['requester'];
  if (who is! Json ||
      who.keys.any((k) => !{'userId', 'messageId'}.contains(k)) ||
      !identifier(who['userId']) ||
      !identifier(who['messageId'])) {
    return null;
  }
  return value;
}

bool isCreationProposal(Json message) =>
    message['kind'] == 'creation_preview' &&
    message['role'] == 'assistant' &&
    message['status'] == 'done' &&
    identifier(message['id']) &&
    identifier(message['conversationId']) &&
    identifier(message['agentId']);

bool canReviewCreation(WorkspaceController scope, Json message) {
  final metadata = message['metadata'];
  return isCreationProposal(message) &&
      metadata is Json &&
      metadata['requesterUserId'] == scope.userId &&
      identifier(metadata['inputMessageId']) &&
      identifier(metadata['runId']) &&
      localProposalBot(scope, message);
}

bool localProposalBot(WorkspaceController scope, Json message) {
  final bot = scope.find('agents', message['agentId'] as String? ?? '');
  return scope.active &&
      scope.owner &&
      botAvailable(bot) &&
      !isManagedBot(bot!);
}

bool customMcpProposalChat(Json? chat, Object? agentId) {
  final members = chat?['agentIds'];
  return chat?['isGroup'] == false &&
      chat?['demo'] != true &&
      members is List &&
      members.length == 1 &&
      members.single == agentId;
}

bool teamProposalBot(WorkspaceController scope, Json message) =>
    scope.active &&
    scope.owner &&
    botAvailable(scope.find('agents', message['agentId'] as String? ?? ''));

class ProposalAccess {
  ProposalAccess(this.scope);
  final WorkspaceController scope;
  final cancellation = ByteReadCancellation();
  bool get active => scope.active && scope.owner && !cancellation.cancelled;
  void guard() {
    scope.guard();
    if (!active) throw const ApiException('FORBIDDEN', 'scopeChanged');
  }

  Future<Json> snapshot({bool personal = false}) async {
    guard();
    final account = await scope.session.api.requestValue(
      'GET',
      '/api/account/session',
      expectedUser: scope.userId,
      cancellation: cancellation,
      isCurrent: () => active,
    );
    guard();
    if (account is! Json ||
        account['authenticated'] != true ||
        account['user'] is! Json ||
        account['user']['id'] != scope.userId ||
        account['workspaces'] is! List ||
        !(account['workspaces'] as List).whereType<Json>().any(
          (w) =>
              w['id'] == scope.workspaceId &&
              w['role'] == 'owner' &&
              w['status'] == 'active' &&
              (!personal || w['kind'] == 'personal'),
        )) {
      throw const ApiException('FORBIDDEN', 'mobileCollaborationOwner');
    }
    final result = await scope.requestValue(
      'GET',
      '/bootstrap',
      cancellation: cancellation,
    );
    guard();
    if (result is! Json) {
      throw const ApiException('INVALID_SNAPSHOT', 'unavailable');
    }
    return result;
  }

  Json original(Json snapshot, Json expected, {bool allowShared = false}) {
    final messages = (snapshot['messages'] as List? ?? []).whereType<Json>();
    final actual = messages
        .where(
          (m) =>
              m['id'] == expected['id'] &&
              m['agentId'] == expected['agentId'] &&
              m['conversationId'] == expected['conversationId'],
        )
        .firstOrNull;
    final bot = (snapshot['agents'] as List? ?? [])
        .whereType<Json>()
        .where((a) => a['id'] == expected['agentId'])
        .firstOrNull;
    final chat = (snapshot['conversations'] as List? ?? [])
        .whereType<Json>()
        .where((c) => c['id'] == expected['conversationId'])
        .firstOrNull;
    if (actual == null ||
        !botAvailable(bot) ||
        (!allowShared && isManagedBot(bot!)) ||
        chat?['agentIds'] is! List ||
        !(chat!['agentIds'] as List).contains(bot!['id'])) {
      throw const ApiException('MISSING_PROPOSAL', 'unavailable');
    }
    return actual;
  }

  Future<Json> creation(Json expected) async {
    guard();
    if (!canReviewCreation(scope, expected)) {
      throw const ApiException('INVALID_PROPOSAL', 'unavailable');
    }
    final data = await snapshot();
    final actual = original(data, expected);
    final metadata = actual['metadata'];
    final input = (data['messages'] as List? ?? [])
        .whereType<Json>()
        .where((row) => row['id'] == expected['metadata']['inputMessageId'])
        .firstOrNull;
    final delivery = input?['delivery'], inputMetadata = input?['metadata'];
    final chat = (data['conversations'] as List? ?? [])
        .whereType<Json>()
        .where((row) => row['id'] == actual['conversationId'])
        .firstOrNull;
    final members = chat?['agentIds'];
    if (!isCreationProposal(actual) ||
        metadata is! Json ||
        canonical(metadata) != canonical(expected['metadata']) ||
        chat?['demo'] == true ||
        chat?['isGroup'] != false ||
        members is! List ||
        members.length != 1 ||
        members.single != actual['agentId'] ||
        input?['role'] != 'user' ||
        input?['userId'] != scope.userId ||
        input?['conversationId'] != actual['conversationId'] ||
        chatThreadRoot(actual) != chatThreadRoot(expected) ||
        chatThreadRoot(input) != chatThreadRoot(actual) ||
        (inputMetadata is Json &&
            const [
              'routineRun',
              'routineOperation',
              'memoryImport',
              'primaryCheckIn',
            ].any(inputMetadata.containsKey)) ||
        delivery is! Json ||
        delivery['state'] != 'delivered' ||
        delivery['agentId'] != actual['agentId'] ||
        delivery['runId'] != metadata['runId']) {
      throw const ApiException('STALE_PROPOSAL', 'unavailable');
    }
    guard();
    return actual;
  }

  Future<Json> app(Json expected) async {
    final proposal = appProposal(expected);
    final custom = customMcpTarget(proposal) != null;
    guard();
    if (proposal == null ||
        proposal['requester']['userId'] != scope.userId ||
        (custom && !scope.personalOwner)) {
      throw const ApiException('INVALID_PROPOSAL', 'unavailable');
    }
    final data = await snapshot(personal: custom);
    final actual = original(data, expected);
    final chat = (data['conversations'] as List? ?? [])
        .whereType<Json>()
        .where((row) => row['id'] == actual['conversationId'])
        .firstOrNull;
    if (canonical(appProposal(actual)) != canonical(proposal) ||
        (custom &&
            (!scope.personalOwner ||
                !customMcpProposalChat(chat, actual['agentId'])))) {
      throw const ApiException('STALE_PROPOSAL', 'unavailable');
    }
    final input = (data['messages'] as List? ?? [])
        .whereType<Json>()
        .where((m) => m['id'] == proposal['requester']['messageId'])
        .firstOrNull;
    final delivery = input?['delivery'], metadata = input?['metadata'];
    final delivered =
        delivery is Json &&
        delivery['state'] == 'delivered' &&
        _appDeliveryMatches(
          input!,
          delivery,
          actual['agentId'],
          proposal['runId'],
        );
    if (input == null ||
        input['role'] != 'user' ||
        input['userId'] != scope.userId ||
        input['conversationId'] != actual['conversationId'] ||
        (custom &&
            (chatThreadRoot(actual) != chatThreadRoot(expected) ||
                chatThreadRoot(input) != chatThreadRoot(actual))) ||
        !delivered ||
        (metadata is Json &&
            [
              'routineRun',
              'routineOperation',
              'memoryImport',
              'primaryCheckIn',
            ].any(metadata.containsKey))) {
      throw const ApiException('INVALID_ROOT', 'unavailable');
    }
    guard();
    return proposal;
  }

  bool _appDeliveryMatches(
    Json input,
    Json delivery,
    Object? agent,
    Object? run,
  ) {
    if (!input.containsKey('mentions')) {
      return delivery['agentId'] == agent && delivery['runId'] == run;
    }
    final mentions = chatGroupMentionReceipt(input['mentions']);
    final targets = delivery['mentionTargets'];
    return mentions != null &&
        mentions.agentIds.contains(agent) &&
        targets is List &&
        targets.whereType<Json>().any(
          (target) => target['agentId'] == agent && target['runId'] == run,
        );
  }

  Future<String> team(Json expected) async {
    guard();
    final card = teamCard(expected);
    if (card == null) {
      throw const ApiException('INVALID_PROPOSAL', 'unavailable');
    }
    final actual = original(await snapshot(), expected, allowShared: true);
    if (teamCard(actual)?['planId'] != card['planId']) {
      throw const ApiException('STALE_PROPOSAL', 'unavailable');
    }
    final plan = teamPlan(
      await scope.requestValue(
        'GET',
        '/bot-team-plans/${card['planId']}',
        cancellation: cancellation,
      ),
    );
    guard();
    final source = plan['source'];
    if (source is! Json ||
        source['kind'] != 'conversation' ||
        !identifier(source['userId']) ||
        source['messageId'] != actual['id'] ||
        source['agentId'] != actual['agentId'] ||
        source['conversationId'] != actual['conversationId']) {
      throw const ApiException('INVALID_SOURCE', 'mobileCollaborationOwner');
    }
    return plan['id'];
  }

  void dispose() => cancellation.cancel();
}
