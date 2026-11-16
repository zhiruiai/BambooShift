import 'dart:typed_data';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/binary_transport.dart';
import '../../core/byte_read.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/file_export_controller.dart';
import '../files/file_export_platform.dart';
import 'skill_package_data.dart';

bool _isSkillZip(Uint8List bytes, int fileCount) {
  // The server returns a single-disk ZIP32 archive without a footer comment.
  const footerSize = 22;
  if (bytes.length < footerSize + 4) return false;
  final data = ByteData.sublistView(bytes);
  final footer = bytes.length - footerSize;
  if (data.getUint32(0, Endian.little) != 0x04034b50 ||
      data.getUint32(footer, Endian.little) != 0x06054b50 ||
      data.getUint32(footer + 4, Endian.little) != 0 ||
      data.getUint16(footer + 8, Endian.little) != fileCount ||
      data.getUint16(footer + 10, Endian.little) != fileCount ||
      data.getUint16(footer + 20, Endian.little) != 0) {
    return false;
  }
  final centralSize = data.getUint32(footer + 12, Endian.little);
  final centralStart = data.getUint32(footer + 16, Endian.little);
  return centralSize >= fileCount * 46 &&
      centralStart + centralSize == footer &&
      data.getUint32(centralStart, Endian.little) == 0x02014b50;
}

class SkillPackagePreview extends StatelessWidget {
  const SkillPackagePreview({super.key, required this.package, this.export});

  final SkillPackageDetails package;
  final Widget? export;

  @override
  Widget build(BuildContext context) {
    final fields = package.frontmatter;
    final metadata = fields['metadata'];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            context.tr('mobileSkillPackageTitle'),
            style: Theme.of(context).textTheme.titleSmall,
          ),
          SelectableText('${package.root}/'),
          for (final (field, label) in [
            ('license', 'mobileSkillPackageLicense'),
            ('compatibility', 'mobileSkillPackageCompatibility'),
            ('allowed-tools', 'mobileSkillPackageTools'),
          ])
            if (fields[field] case final String value)
              SelectableText('${context.tr(label)} · $value'),
          if (metadata is Json)
            if (metadata['source'] case final String value)
              SelectableText(
                '${context.tr('mobileSkillPackageSource')} · $value',
              ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text(
              context
                  .tr('mobileSkillPackageFiles')
                  .replaceFirst('{count}', '${package.files.length}'),
            ),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final file in package.files) SelectableText(file.path),
            ],
          ),
          ?export,
        ],
      ),
    );
  }
}

class SkillPackageExport extends StatefulWidget {
  const SkillPackageExport({
    super.key,
    required this.scope,
    required this.agentId,
    required this.skillId,
    required this.package,
    this.destination,
  });

  final WorkspaceController scope;
  final String agentId, skillId;
  final SkillPackageDetails package;
  final FileExportDestination? destination;

  @override
  State<SkillPackageExport> createState() => _SkillPackageExportState();
}

class _SkillPackageExportState extends State<SkillPackageExport> {
  final _native = NativeFileExport();
  ByteReadCancellation? _pending;
  FileExportDestination get _destination => widget.destination ?? _native;
  bool get _supported =>
      (!kIsWeb || widget.destination != null) && _destination.supported;

  bool _matches(Json? snapshot, String fingerprint) {
    final bots = snapshot?['agents'], skills = snapshot?['skills'];
    return bots is List &&
        bots.whereType<Json>().any((bot) => bot['id'] == widget.agentId) &&
        skills is List &&
        skills.whereType<Json>().any(
          (skill) =>
              skill['id'] == widget.skillId &&
              skill['agentId'] == widget.agentId &&
              SkillPackageDetails.installed(skill)?.fingerprint == fingerprint,
        );
  }

  Future<void> _export(BuildContext anchor) async {
    final scope = widget.scope;
    final fingerprint = widget.package.fingerprint;
    final skillId = widget.skillId;
    final destination = _destination;
    final box = anchor.findRenderObject();
    if (_pending != null ||
        !_supported ||
        !scope.active ||
        !_matches(scope.data, fingerprint) ||
        box is! RenderBox ||
        !box.hasSize) {
      return;
    }
    final origin = box.localToGlobal(Offset.zero) & box.size;
    final name = '${widget.package.root}.zip';
    final token = ByteReadCancellation();
    setState(() => _pending = token);
    bool current() =>
        mounted &&
        !token.cancelled &&
        identical(scope, widget.scope) &&
        identical(destination, _destination) &&
        skillId == widget.skillId &&
        ModalRoute.isCurrentOf(context) != false &&
        scope.active &&
        _matches(scope.data, fingerprint);
    void guard() {
      if (!current()) throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }

    Future<void> authorize() async {
      guard();
      final latest = await scope.requestValue(
        'GET',
        '/bootstrap',
        cancellation: token,
      );
      guard();
      if (latest is! Json || !_matches(latest, fingerprint)) {
        throw const ApiException('SKILL_CHANGED', 'mobileSkillPackageChanged');
      }
    }

    String? notice;
    try {
      await authorize();
      final result = await readBoundedBinary(
        scope.session.api,
        scope.path('/skills/${Uri.encodeComponent(skillId)}/package'),
        expectedUser: scope.userId,
        isCurrent: current,
        cancellation: token,
        maximum: skillPackageMaxBytes + 128 * 1024,
        accept: 'application/zip',
        unavailable: 'mobileSkillPackageChanged',
        failed: 'mobileFilesExportFailed',
        validateHeaders: (headers) {
          final type = headers['content-type']?.split(';').first.trim();
          final disposition = headers['content-disposition'] ?? '';
          if (type != 'application/zip' ||
              !disposition.toLowerCase().startsWith('attachment;')) {
            throw const FormatException('Invalid skill package response');
          }
        },
      );
      final bytes = result.bytes;
      if (!_isSkillZip(bytes, widget.package.files.length)) {
        throw const FormatException('Invalid skill package ZIP');
      }
      guard();
      final outcome = await destination.export(
        FileBytes(bytes, 'application/zip'),
        name,
        origin,
        authorize: authorize,
        guard: guard,
      );
      guard();
      notice = switch (outcome) {
        FileExportResult.selected => 'mobileFilesExportSelected',
        FileExportResult.dismissed => 'mobileFilesExportDismissed',
        FileExportResult.saved => 'mobileFilesExportSaved',
        FileExportResult.unknown => 'mobileFilesExportUnknown',
      };
    } catch (error) {
      if (current()) {
        notice = error is ApiException
            ? error.message
            : 'mobileFilesExportFailed';
      }
    } finally {
      if (mounted) setState(() => _pending = null);
    }
    if (mounted && notice != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(context.tr(notice))));
    }
  }

  @override
  void dispose() {
    _pending?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Builder(
    builder: (anchor) => OutlinedButton.icon(
      onPressed: _pending == null && _supported ? () => _export(anchor) : null,
      icon: _pending == null
          ? const Icon(Icons.download_outlined)
          : const SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
      label: Text(
        context.tr(
          _supported
              ? 'mobileSkillPackageDownload'
              : 'mobileFilesExportUnavailable',
        ),
      ),
    ),
  );
}
