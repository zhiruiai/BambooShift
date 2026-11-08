import 'dart:async';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/avatar_assets.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import 'avatar_camera.dart';
import 'avatar_crop.dart';

const _maximum = 25 * 1024 * 1024;
const _mimeTypes = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
};

Future<XFile?> _selectAvatar() => openFile(
  acceptedTypeGroups: const [
    XTypeGroup(
      label: 'Images',
      extensions: ['png', 'jpeg', 'jpg', 'webp'],
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
      uniformTypeIdentifiers: [
        'public.png',
        'public.jpeg',
        'org.webmproject.webp',
      ],
    ),
  ],
);

class AvatarCropDialog extends StatefulWidget {
  const AvatarCropDialog({
    super.key,
    required this.scope,
    this.selectAvatar = _selectAvatar,
    this.checkCamera = avatarCameraAvailable,
    this.captureAvatar = takeAvatarPhoto,
    this.targetCurrent,
  });

  final WorkspaceController scope;
  final Future<XFile?> Function() selectAvatar;
  final Future<bool> Function() checkCamera;
  final Future<XFile?> Function() captureAvatar;
  final bool Function()? targetCurrent;

  @override
  State<AvatarCropDialog> createState() => _AvatarCropDialogState();
}

class _AvatarCropDialogState extends State<AvatarCropDialog> {
  final cancellation = ByteReadCancellation();
  AvatarSource? source;
  MemoryImage? image;
  bool busy = false, cameraAvailable = false;
  String? error;
  double zoom = 1, x = .5, y = .5;

  WorkspaceController get scope => widget.scope;
  bool get current =>
      mounted &&
      !cancellation.cancelled &&
      scope.active &&
      scope.owner &&
      (widget.targetCurrent?.call() ?? true);

  @override
  void initState() {
    super.initState();
    scope.session.addListener(_identityChanged);
    scope.addListener(_identityChanged);
    unawaited(_checkCamera());
  }

  Future<void> _checkCamera() async {
    final available = await widget.checkCamera();
    if (current && available) setState(() => cameraAvailable = true);
  }

  void _identityChanged() {
    if (current || cancellation.cancelled) return;
    cancellation.cancel();
    _clear();
    if (mounted) setState(() => busy = false);
  }

  void _clear() {
    final previousImage = image;
    image = null;
    if (previousImage != null) unawaited(previousImage.evict());
    final previous = source;
    source = null;
    if (previous != null && scope.active && scope.owner) {
      unawaited(_drop(previous.id));
    }
  }

  Future<void> _drop(String id) async {
    try {
      await scope.requestValue('DELETE', '/bot-avatars/sources/$id');
    } catch (_) {
      // Sources also expire on the server if the client cannot release them.
    }
  }

  Future<Uint8List> _read(XFile file) async {
    const invalid = ApiException('INVALID_UPLOAD', 'avatarUploadInvalid');
    final length = await file.length();
    if (length <= 0 || length >= _maximum) throw invalid;
    final output = BytesBuilder(copy: false);
    await for (final bytes in file.openRead(0, length)) {
      if (!current) throw const ApiException('STALE_SCOPE', 'scopeChanged');
      if (output.length + bytes.length > length) throw invalid;
      output.add(bytes);
    }
    if (output.length != length) throw invalid;
    return output.takeBytes();
  }

  Future<void> _choose(
    Future<XFile?> Function() select, {
    bool camera = false,
  }) async {
    if (busy || !current) return;
    setState(() {
      busy = true;
      error = null;
    });
    XFile? captured;
    try {
      final file = await select();
      if (camera) captured = file;
      if (file == null || !current) return;
      final mime = camera
          ? 'image/png'
          : _mimeTypes[file.name.split('.').last.toLowerCase()];
      if (mime == null) {
        throw const ApiException('INVALID_UPLOAD', 'avatarUploadInvalid');
      }
      var bytes = await _read(file);
      if (camera && current) bytes = await avatarPhotoPixels(bytes);
      if (!current) return;
      setState(_clear);
      final response = await scope.session.api.requestValue(
        'POST',
        scope.path('/bot-avatars/sources'),
        rawBody: bytes,
        rawContentType: mime,
        expectedUser: scope.userId,
        isCurrent: () => current,
        cancellation: cancellation,
      );
      final prepared = AvatarSource.parse(response);
      if (prepared == null) {
        throw const ApiException('INVALID_IMAGE', 'avatarUploadFailed');
      }
      if (!current) {
        if (scope.active && scope.owner) unawaited(_drop(prepared.id));
        return;
      }
      source = prepared;
      final preview = await readAvatarImage(
        scope,
        scope.path('/bot-avatars/sources/${prepared.id}'),
        current: () => current,
        cancellation: cancellation,
        maximum: 2 * 1024 * 1024,
      );
      if (current) {
        setState(() {
          image = MemoryImage(preview);
          zoom = 1;
          x = y = .5;
        });
      }
    } catch (cause) {
      if (current) {
        setState(() {
          if (camera && cause is PlatformException) {
            switch (cause.code) {
              case 'camera_access_denied':
              case 'camera_access_restricted':
                error = 'avatarCameraDenied';
              case 'no_available_camera':
                cameraAvailable = false;
                error = 'avatarCameraUnavailable';
              default:
                error = 'avatarCameraFailed';
            }
          } else {
            error = cause is ApiException && cause.code == 'INVALID_UPLOAD'
                ? 'avatarUploadInvalid'
                : 'avatarUploadFailed';
          }
        });
      }
    } finally {
      if (captured != null) await discardAvatarPhoto(captured);
      if (current) setState(() => busy = false);
    }
  }

  Future<void> _apply() async {
    final prepared = source;
    if (busy || !current || prepared == null || image == null) return;
    final crop = prepared.crop(zoom, x, y);
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final asset = await scope.request(
        'POST',
        '/bot-avatars',
        body: {
          'sourceId': prepared.id,
          'crop': {'left': crop.left, 'top': crop.top, 'size': crop.size},
        },
      );
      final id = asset['id'];
      if (!isRequestId(id) ||
          asset['width'] != 512 ||
          asset['height'] != 512 ||
          asset['mimeType'] != 'image/webp') {
        throw const ApiException('INVALID_IMAGE', 'avatarUploadFailed');
      }
      if (mounted && current) Navigator.pop(context, id as String);
    } catch (_) {
      if (current) setState(() => error = 'avatarUploadFailed');
    } finally {
      if (current) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    scope.session.removeListener(_identityChanged);
    scope.removeListener(_identityChanged);
    cancellation.cancel();
    _clear();
    super.dispose();
  }

  Widget _slider(
    String label,
    double value,
    ValueChanged<double>? onChanged, {
    double min = 0,
    double max = 1,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(context.tr(label)),
      Semantics(
        label: context.tr(label),
        child: Slider(value: value, min: min, max: max, onChanged: onChanged),
      ),
    ],
  );

  Widget _preview(AvatarSource prepared, MemoryImage photo) {
    const side = 220.0;
    final crop = prepared.crop(zoom, x, y);
    final scale = side / crop.size;
    return Center(
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: SizedBox.square(
            dimension: side,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Positioned(
                  left: -crop.left * scale,
                  top: -crop.top * scale,
                  width: prepared.width * scale,
                  height: prepared.height * scale,
                  child: Image(image: photo, fit: BoxFit.fill),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final prepared = source, photo = image;
    final enabled = current && !busy;
    return PopScope(
      canPop: !busy,
      child: AlertDialog(
        title: Text(context.tr('avatarCrop')),
        scrollable: true,
        content: SizedBox(
          width: 300,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              OutlinedButton.icon(
                onPressed: enabled ? () => _choose(widget.selectAvatar) : null,
                icon: const Icon(Icons.image_outlined),
                label: Text(context.tr('avatarUpload')),
              ),
              if (cameraAvailable) ...[
                OutlinedButton.icon(
                  onPressed: enabled
                      ? () => _choose(widget.captureAvatar, camera: true)
                      : null,
                  icon: const Icon(Icons.photo_camera_outlined),
                  label: Text(context.tr('avatarCameraTake')),
                ),
                Text(context.tr('avatarCameraScope')),
              ],
              if (busy) const LinearProgressIndicator(),
              if (!current)
                Text(context.tr('scopeChanged'))
              else if (error != null)
                Text(context.tr(error!)),
              if (prepared != null && photo != null) ...[
                const SizedBox(height: 12),
                _preview(prepared, photo),
                const SizedBox(height: 12),
                _slider(
                  'avatarCropZoom',
                  zoom,
                  enabled ? (v) => setState(() => zoom = v) : null,
                  min: 1,
                  max: 4,
                ),
                _slider(
                  'avatarCropHorizontal',
                  x,
                  enabled ? (v) => setState(() => x = v) : null,
                ),
                _slider(
                  'avatarCropVertical',
                  y,
                  enabled ? (v) => setState(() => y = v) : null,
                ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: busy ? null : () => Navigator.pop(context),
            child: Text(context.tr('cancel')),
          ),
          FilledButton(
            onPressed: enabled && photo != null ? _apply : null,
            child: Text(context.tr('avatarCropApply')),
          ),
        ],
      ),
    );
  }
}
