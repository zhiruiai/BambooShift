import 'dart:async';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';

import '../../core/api.dart';
import '../../core/byte_read.dart';
import '../../core/selected_attachment.dart';
import 'attachment_data.dart';

export '../../core/selected_attachment.dart' show SelectedAttachment;

typedef AttachmentPicker = Future<SelectedAttachment?> Function();

Future<SelectedAttachment?> pickAttachment() async {
  final file = await openFile();
  if (file == null) return null;
  final name = attachmentName(file.name);
  final size = await file.length();
  if (size < 0 || size > attachmentLimit) {
    throw const ApiException('FILE_TOO_LARGE', 'mobileFilesLimit');
  }
  return SelectedAttachment(
    name: name,
    size: size,
    type: attachmentType(file.mimeType),
    openRead: () => file.openRead(),
  );
}

Future<Uint8List> readAttachment(
  SelectedAttachment selected,
  ByteReadCancellation cancellation,
  void Function() guard,
) async {
  guard();
  if (selected.size < 0 || selected.size > attachmentLimit) {
    throw const ApiException('FILE_TOO_LARGE', 'mobileFilesLimit');
  }
  final stream = StreamIterator(selected.openRead());
  final bytes = BytesBuilder(copy: false);
  final timeout = Completer<void>();
  final timer = Timer(const Duration(seconds: 30), () => timeout.complete());
  try {
    while (await Future.any([
      stream.moveNext(),
      cancellation.whenCancelled.then<bool>(
        (_) => throw const ApiException('CANCELLED', 'scopeChanged'),
      ),
      timeout.future.then<bool>(
        (_) =>
            throw const ApiException('READ_TIMEOUT', 'mobileFilesReadFailed'),
      ),
    ])) {
      guard();
      if (bytes.length + stream.current.length > attachmentLimit) {
        throw const ApiException('FILE_TOO_LARGE', 'mobileFilesLimit');
      }
      bytes.add(stream.current);
    }
    guard();
    if (bytes.length != selected.size) {
      throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
    }
    return bytes.takeBytes();
  } finally {
    timer.cancel();
    await stream.cancel();
  }
}
