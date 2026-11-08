import '../../core/api.dart';
import '../../core/chat_draft.dart';
import '../../core/workspace_controller.dart';
import '../chat/attachment_data.dart';
import '../chat/attachment_storage.dart';
import 'inbound_share_data.dart';
import 'inbound_share_inbox.dart';

Future<void> attachInboundShare({
  required WorkspaceController scope,
  required InboundShareInbox inbox,
  required InboundSharePacket packet,
  required String conversationId,
  required bool includeText,
  required Set<String> fileIds,
  required bool Function() isCurrent,
}) async {
  bool valid() =>
      isCurrent() &&
      scope.active &&
      inbox.contains(packet) &&
      isChatReference(conversationId) &&
      scope.find('conversations', conversationId) != null;

  void guard() {
    if (!valid()) throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }

  guard();
  final text = includeText ? packet.text : null;
  if (text == null && fileIds.isEmpty) {
    throw const ApiException('EMPTY_SHARE', 'mobileInboundEmpty');
  }
  final storage = AttachmentStorage(scope, conversationId);
  final vault = scope.session.api.vault,
      origin = scope.session.api.server!.origin;
  final purpose = chatPendingPurpose(
    scope.userId,
    scope.workspaceId,
    conversationId,
  );
  final fileSize = packet.files
      .where((item) => fileIds.contains(item.id))
      .fold(0, (bytes, item) => bytes + item.size);

  Future<String> inspectDraft() async {
    if (await vault.read(origin, purpose) != null) {
      throw const ApiException('PENDING_SEND', 'mobileInboundPending');
    }
    await storage.load();
    guard();
    if (storage.pending != null) {
      throw const ApiException('PENDING_FILE', 'mobileInboundPending');
    }
    if (fileIds.isNotEmpty &&
        (storage.files.length +
                    scope.attachmentDrafts(conversationId).length +
                    fileIds.length >
                attachmentCount ||
            scope.sharedDraftBytes + fileSize >
                attachmentCount * attachmentLimit)) {
      throw const ApiException('FILE_LIMIT', 'mobileInboundDraftLimit');
    }
    final current = scope.chatDraft(conversationId);
    final combined = [
      current,
      ?text,
    ].where((part) => part.isNotEmpty).join('\n\n');
    if (combined.length > inboundShareTextLimit) {
      throw const ApiException('TEXT_LIMIT', 'mobileInboundTextLimit');
    }
    return combined;
  }

  await inspectDraft();
  final files = await inbox.readFiles(packet, fileIds, valid);
  final combined = await inspectDraft();
  guard();
  inbox.finish(
    packet,
    () => scope.applyInboundDraft(conversationId, combined, files),
  );
}
