import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/binary_transport.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../../widgets/bot_avatar.dart';

bool safeLibraryAvatar(String path, String workspaceId) {
  final uri = Uri.tryParse(path);
  if (uri == null ||
      uri.hasAuthority ||
      uri.hasFragment ||
      !path.startsWith('/api/')) {
    return false;
  }
  const uuid = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  if (RegExp(
    '^/api/workspaces/${RegExp.escape(workspaceId)}/bot-avatars/$uuid\$',
  ).hasMatch(uri.path)) {
    return !uri.hasQuery;
  }
  final image = RegExp(
    '^/api/(?:bot-template-links/[A-Za-z0-9_-]{43}|workspaces/${RegExp.escape(workspaceId)}/bot-templates/$uuid|shared-bots/$uuid)/avatar\$',
  );
  return image.hasMatch(uri.path) &&
      uri.queryParametersAll.length == 1 &&
      uri.queryParametersAll['revision']?.length == 1 &&
      RegExp(
        '^(?:$uuid|[a-f0-9]{64})\$',
      ).hasMatch(uri.queryParameters['revision'] ?? '');
}

class LibraryAvatar extends StatefulWidget {
  const LibraryAvatar({
    super.key,
    required this.scope,
    required this.profile,
    this.path,
    this.expectedImage = false,
  });
  final WorkspaceController scope;
  final Json profile;
  final String? path;
  final bool expectedImage;
  @override
  State<LibraryAvatar> createState() => _LibraryAvatarState();
}

class _LibraryAvatarState extends State<LibraryAvatar> {
  ByteReadCancellation? cancellation;
  Uint8List? bytes;
  bool failed = false;
  int epoch = 0;
  @override
  void initState() {
    super.initState();
    widget.scope.session.addListener(identity);
    unawaited(load());
  }

  void identity() {
    if (!widget.scope.active) {
      epoch++;
      cancellation?.cancel();
      bytes = null;
      if (mounted) setState(() {});
    }
  }

  @override
  void didUpdateWidget(LibraryAvatar old) {
    super.didUpdateWidget(old);
    if (old.scope != widget.scope) {
      old.scope.session.removeListener(identity);
      widget.scope.session.addListener(identity);
    }
    if (old.path != widget.path || old.scope != widget.scope) unawaited(load());
  }

  Future<void> load() async {
    final order = ++epoch;
    cancellation?.cancel();
    bytes = null;
    failed = false;
    final path = widget.path, scope = widget.scope;
    if (!scope.active ||
        path == null ||
        !safeLibraryAvatar(path, scope.workspaceId)) {
      failed = widget.expectedImage;
      return;
    }
    final pending = ByteReadCancellation();
    cancellation = pending;
    bool current() => mounted && scope.active && order == epoch;
    try {
      final result = await readBoundedBinary(
        scope.session.api,
        path,
        expectedUser: scope.userId,
        isCurrent: current,
        cancellation: pending,
        maximum: 512 * 1024,
        accept: 'image/webp',
        validateHeaders: (headers) {
          if (headers['content-type']?.split(';').first.trim().toLowerCase() !=
              'image/webp') {
            throw const ApiException(
              'INVALID_IMAGE',
              'mobileLibraryImageUnavailable',
            );
          }
        },
      );
      final data = result.bytes;
      if (data.length < 12 ||
          String.fromCharCodes(data.sublist(0, 4)) != 'RIFF' ||
          String.fromCharCodes(data.sublist(8, 12)) != 'WEBP' ||
          ByteData.sublistView(data).getUint32(4, Endian.little) + 8 !=
              data.length) {
        throw const ApiException(
          'INVALID_IMAGE',
          'mobileLibraryImageUnavailable',
        );
      }
      if (current()) setState(() => bytes = data);
    } catch (_) {
      if (current()) setState(() => failed = true);
    } finally {
      if (identical(cancellation, pending)) cancellation = null;
    }
  }

  @override
  void dispose() {
    epoch++;
    cancellation?.cancel();
    widget.scope.session.removeListener(identity);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fallback = BotAvatar(
      bot: widget.profile,
      family: widget.scope.session.avatarTheme,
      size: 56,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (bytes != null && widget.scope.active)
          Image.memory(
            bytes!,
            width: 56,
            height: 56,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => fallback,
          )
        else
          fallback,
        if (failed)
          Text(
            context.tr('mobileLibraryImageUnavailable'),
            style: const TextStyle(fontSize: 12),
          ),
      ],
    );
  }
}
