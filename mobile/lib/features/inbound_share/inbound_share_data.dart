import '../../core/api.dart';
import '../../core/request_ids.dart';
import '../chat/attachment_data.dart';

const inboundShareTextLimit = 30000;
const inboundShareChunk = 64 * 1024;
const inboundShareQueueLimit = 4;

bool inboundShareId(Object? value) =>
    isRequestId(value) && value == value.toString().toLowerCase();

typedef InboundShareFile = ({String id, String name, String type, int size});

class InboundSharePacket {
  const InboundSharePacket(this.id, this.text, this.files, this.warning);
  final String id;
  final String? text, warning;
  final List<InboundShareFile> files;

  static InboundSharePacket? parse(Object? value) {
    if (value is! Map || !inboundShareId(value['id'])) return null;
    final id = value['id'] as String;
    final rawText = value['text'];
    final nativeError = value['error'];
    String? warning = switch (nativeError) {
      'limit' => 'mobileInboundLimited',
      'invalid' => 'mobileInboundPartial',
      _ => null,
    };
    final text = _inboundText(rawText);
    if (rawText != null && text == null) {
      warning ??= rawText is String && rawText.length > inboundShareTextLimit
          ? 'mobileInboundLimited'
          : 'mobileInboundPartial';
    }
    final rows = value['files'];
    final files = <InboundShareFile>[];
    final ids = <String>{};
    if (rows is List) {
      if (rows.length > attachmentCount) warning = 'mobileInboundLimited';
      for (final row in rows.take(attachmentCount)) {
        if (row case {
          'id': final String fileId,
          'name': final String name,
          'type': final String type,
          'size': final int size,
        } when inboundShareId(fileId) && ids.add(fileId)) {
          if (size < 0 || size > attachmentLimit) {
            warning = 'mobileInboundLimited';
            continue;
          }
          try {
            files.add((
              id: fileId,
              name: attachmentName(name),
              type: attachmentType(type),
              size: size,
            ));
          } on ApiException {
            warning ??= 'mobileInboundPartial';
          }
        } else {
          warning ??= 'mobileInboundPartial';
        }
      }
    } else {
      warning ??= 'mobileInboundPartial';
    }
    return InboundSharePacket(
      id,
      text,
      List.unmodifiable(files),
      text == null && files.isEmpty
          ? (warning ?? 'mobileInboundEmpty')
          : warning,
    );
  }
}

String? _inboundText(Object? value) {
  if (value is! String ||
      value.isEmpty ||
      value.length > inboundShareTextLimit ||
      RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]').hasMatch(value)) {
    return null;
  }
  final text = value.trim();
  if (text.isEmpty ||
      RegExp(
        r'^(?:(?:file|content):/|(?:data|javascript|intent|blob):\S)',
        caseSensitive: false,
      ).hasMatch(text)) {
    return null;
  }
  if (RegExp(r'^https?://[^\s]+$', caseSensitive: false).hasMatch(text)) {
    final link = Uri.tryParse(text);
    if (link == null || link.host.isEmpty || link.authority.contains('@')) {
      return null;
    }
  }
  return text;
}
