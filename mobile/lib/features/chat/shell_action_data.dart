import '../../core/api.dart';
import 'action_data.dart';

bool isShellAction(ChatAction action) =>
    action.kind == 'computer' &&
    const ['remote_shell', 'local_shell'].contains(action.value['type']);

bool shellRequestReadable(Object? payload) {
  if (payload is! Json) return false;
  final command = payload['command'], path = payload['path'];
  return command is String &&
      command.trim().isNotEmpty &&
      command.length <= 16000 &&
      (!payload.containsKey('path') ||
          (path is String && path.trim().isNotEmpty));
}

String? shellResultLabel(Object? result) {
  if (result is! Json) return null;
  if (result['cancelled'] == true) return 'shellCancelled';
  if (result['timedOut'] == true) return 'shellTimedOut';
  if (const [
    'memory',
    'disk-reserve',
    'pids',
  ].contains(result['resourceLimit'])) {
    return 'shellResourceLimit';
  }
  if (result['signal'] is String && (result['signal'] as String).isNotEmpty) {
    return 'shellInterrupted';
  }
  if (result['exitCode'] is int) {
    return result['exitCode'] == 0 ? 'shellCompleted' : 'shellFailed';
  }
  if (result.containsKey('exitCode') && result['exitCode'] == null) {
    return 'shellInterrupted';
  }
  return null;
}
