import 'dart:convert';
import 'dart:ui' as ui;

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';

class ChatFile {
  const ChatFile(this.id, this.name, this.size);
  final String id, name;
  final int size;
  String get extension => name.split('.').last.toLowerCase();
  bool get image => ['png', 'jpg', 'jpeg', 'webp'].contains(extension);
  bool get html => ['html', 'htm'].contains(extension);
  bool get markdown => ['md', 'markdown'].contains(extension);
  bool get supported =>
      image ||
      html ||
      markdown ||
      ['txt', 'csv', 'json', 'log', 'xml'].contains(extension);
  static ChatFile? fromMessage(WorkspaceController scope, Json message) {
    if (message['kind'] != 'file' || message['metadata'] is! Map) return null;
    final id = message['metadata']['fileId'];
    if (id is! String) return null;
    final file = scope.find('files', id);
    if (file == null ||
        (file['conversationId'] != null &&
            file['conversationId'] != message['conversationId'])) {
      return null;
    }
    return fromWorkspace(file);
  }

  static ChatFile? fromWorkspace(Json file) {
    final id = file['id'], name = file['name'], size = file['size'];
    if (id is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(id) ||
        name is! String ||
        size is! int ||
        size < 0) {
      return null;
    }
    final basename = name.split(RegExp(r'[/\\]')).last;
    return basename.trim().isEmpty ? null : ChatFile(id, basename, size);
  }
}

String previewText(FileBytes data, ChatFile file) {
  final allowed =
      data.mimeType.startsWith('text/') ||
      [
        'application/json',
        'application/xml',
        'application/octet-stream',
      ].contains(data.mimeType);
  if (!allowed || file.image || !file.supported) {
    throw const ApiException('FILE_FORMAT', 'mobileChatFileUnsupported');
  }
  try {
    final value = utf8.decode(data.bytes);
    if (value.contains('\u0000')) throw const FormatException();
    return value;
  } on FormatException {
    throw const ApiException('FILE_FORMAT', 'mobileChatFileUnsupported');
  }
}

Future<ui.Image> previewImage(FileBytes data, void Function() check) async {
  final b = data.bytes;
  bool prefix(List<int> signature) =>
      b.length >= signature.length &&
      List.generate(
        signature.length,
        (i) => b[i] == signature[i],
      ).every((v) => v);
  final valid = switch (data.mimeType) {
    'image/png' => prefix([137, 80, 78, 71, 13, 10, 26, 10]),
    'image/jpeg' => prefix([255, 216, 255]),
    'image/webp' =>
      prefix([82, 73, 70, 70]) &&
          b.length >= 12 &&
          ascii.decode(b.sublist(8, 12), allowInvalid: true) == 'WEBP',
    _ => false,
  };
  if (!valid) {
    throw const ApiException('FILE_FORMAT', 'mobileChatFileUnsupported');
  }
  check();
  final buffer = await ui.ImmutableBuffer.fromUint8List(b);
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    check();
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    check();
    if (descriptor.width < 1 ||
        descriptor.height < 1 ||
        descriptor.width * descriptor.height > 32 * 1024 * 1024) {
      throw const ApiException('IMAGE_TOO_LARGE', 'mobileChatImageTooLarge');
    }
    final scale =
        2048 /
        (descriptor.width > descriptor.height
            ? descriptor.width
            : descriptor.height);
    codec = await descriptor.instantiateCodec(
      targetWidth: scale < 1
          ? (descriptor.width * scale).round().clamp(1, 2048)
          : descriptor.width,
      targetHeight: scale < 1
          ? (descriptor.height * scale).round().clamp(1, 2048)
          : descriptor.height,
    );
    check();
    if (codec.frameCount != 1) {
      throw const ApiException('ANIMATED_IMAGE', 'mobileChatFileUnsupported');
    }
    image = (await codec.getNextFrame()).image;
    check();
    final result = image;
    image = null;
    return result;
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer.dispose();
  }
}
