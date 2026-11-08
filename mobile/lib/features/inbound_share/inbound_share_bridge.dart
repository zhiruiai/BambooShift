import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

abstract interface class InboundShareBridge {
  Future<Object?> peek();
  Future<Uint8List?> read(String id, String fileId, int offset, int length);
  Future<bool> discard(String id);
  void listen(VoidCallback? changed);
}

InboundShareBridge? platformInboundShare() =>
    !kIsWeb &&
        const [
          TargetPlatform.android,
          TargetPlatform.iOS,
        ].contains(defaultTargetPlatform)
    ? const NativeInboundShare()
    : null;

class NativeInboundShare implements InboundShareBridge {
  const NativeInboundShare();
  static const channel = MethodChannel('com.openbot.client/inbound-share');

  @override
  Future<Object?> peek() => channel.invokeMethod<Object?>('peek');

  @override
  Future<Uint8List?> read(String id, String fileId, int offset, int length) =>
      channel.invokeMethod<Uint8List>('read', {
        'id': id,
        'fileId': fileId,
        'offset': offset,
        'length': length,
      });

  @override
  Future<bool> discard(String id) async =>
      await channel.invokeMethod<bool>('discard', {'id': id}) == true;

  @override
  void listen(VoidCallback? changed) => channel.setMethodCallHandler(
    changed == null
        ? null
        : (call) async {
            if (call.method == 'available') changed();
          },
  );
}
