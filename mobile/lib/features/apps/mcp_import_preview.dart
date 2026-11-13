import 'dart:convert';

import '../../core/api.dart';
import 'apps_controller.dart';
import 'remote_mcp_import.dart';

Future<RemoteMcpImportResult> previewRemoteMcpImport(
  AppsController controller,
  RemoteMcpImportResult draft,
) async {
  controller.guard();
  if (!controller.canAdd || draft.error != null) {
    throw const ApiException('INVALID_PREVIEW', 'requestFailed');
  }
  final value = await controller.transport.send(
    'POST',
    '/apps/import/preview',
    body: {
      'candidates': [
        for (final candidate in draft.candidates)
          {'name': candidate.name, 'url': candidate.url},
      ],
      'skipped': draft.skipped,
    },
  );
  controller.guard();
  if (!controller.canAdd) {
    throw const ApiException('STALE_SCOPE', 'scopeChanged');
  }
  return readPreview(value);
}

RemoteMcpImportResult readPreview(Object? value) {
  const invalid = ApiException('INVALID_PREVIEW', 'requestFailed');
  if (value is! Json || !value.containsKey('error')) throw invalid;
  final entries = value['candidates'], skipped = value['skipped'];
  final error = value['error'];
  if (entries is! List ||
      entries.length > 100 ||
      skipped is! int ||
      skipped < 0 ||
      entries.length + skipped > 100 ||
      (error != null && error != 'empty') ||
      ((error == 'empty') != entries.isEmpty)) {
    throw invalid;
  }
  final candidates = <RemoteMcpCandidate>[];
  final seen = <String>{};
  for (final entry in entries) {
    if (entry is! Json || entry['name'] is! String || entry['url'] is! String) {
      throw invalid;
    }
    // Recheck the response shape without re-normalizing its canonical address.
    final checked = parseRemoteMcpImport(
      jsonEncode({
        'servers': {
          entry['name']: {'url': entry['url']},
        },
      }),
    );
    if (checked.error != null ||
        checked.candidates.length != 1 ||
        checked.candidates.single.name != entry['name'] ||
        checked.candidates.single.url != entry['url'] ||
        !seen.add(entry['url'])) {
      throw invalid;
    }
    candidates.add(checked.candidates.single);
  }
  return (candidates: candidates, skipped: skipped, error: error as String?);
}
