import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

const _channel = MethodChannel('com.openbot.client/avatar-camera');
const _photoEdge = 1600;
final _androidCapture = RegExp(
  r'^(?:scaled_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[0-9]+\.jpg$',
);
Future<void>? _startupCleanup;

bool get _android => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

Future<bool> avatarCameraAvailable() async {
  if (kIsWeb || (!_android && defaultTargetPlatform != TargetPlatform.iOS)) {
    return false;
  }
  try {
    return await _channel.invokeMethod<bool>('available') == true;
  } on PlatformException {
    return false;
  } on MissingPluginException {
    return false;
  }
}

Future<void> discardAbandonedAvatarPhotos() async {
  if (_android) await (_startupCleanup ??= _discardLost());
}

Future<void> _discardLost() async {
  try {
    final lost = await ImagePicker().retrieveLostData();
    for (final file in lost.files ?? const <XFile>[]) {
      await discardAvatarPhoto(file);
    }
  } catch (_) {
    // An interrupted capture cannot be restored into a different session.
  }
  await _discardAndroidCameraFiles();
}

Future<void> _discardAndroidCameraFiles() async {
  try {
    final directory = await getTemporaryDirectory();
    await for (final entry in directory.list(followLinks: false)) {
      if (entry is File &&
          _androidCapture.hasMatch(entry.uri.pathSegments.last)) {
        await entry.delete();
      }
    }
  } on Exception {
    // Private cache files can also be reclaimed by the operating system.
  }
}

Future<XFile?> takeAvatarPhoto() async {
  await discardAbandonedAvatarPhotos();
  XFile? photo;
  try {
    photo = await ImagePicker().pickImage(
      source: ImageSource.camera,
      maxWidth: _photoEdge.toDouble(),
      maxHeight: _photoEdge.toDouble(),
      imageQuality: 90,
      requestFullMetadata: false,
    );
    return photo;
  } finally {
    if (_android && photo == null) await _discardAndroidCameraFiles();
  }
}

Future<void> discardAvatarPhoto(XFile photo) async {
  if (kIsWeb || !photo.path.startsWith('/')) return;
  try {
    final file = File(photo.path);
    final path = await file.resolveSymbolicLinks();
    final temporary = _android
        ? await getTemporaryDirectory()
        : Directory.systemTemp;
    final root = await temporary.resolveSymbolicLinks();
    if (path.startsWith('$root/')) await file.delete();
  } on Exception {
    // No persistent user file is moved or removed.
  }
}

Future<Uint8List> avatarPhotoPixels(Uint8List bytes) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    final photo = descriptor = await ui.ImageDescriptor.encoded(buffer);
    if (photo.width * photo.height > 20 * 1024 * 1024) {
      throw const FormatException('Camera image dimensions are too large.');
    }
    final edge = math.max(photo.width, photo.height);
    final scale = math.min(1.0, _photoEdge / edge);
    codec = await photo.instantiateCodec(
      targetWidth: math.max(1, (photo.width * scale).round()),
      targetHeight: math.max(1, (photo.height * scale).round()),
    );
    image = (await codec.getNextFrame()).image;
    // PNG encoding retains pixels and removes the camera's original metadata.
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) {
      throw const FormatException('Camera image is unreadable.');
    }
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer.dispose();
  }
}
