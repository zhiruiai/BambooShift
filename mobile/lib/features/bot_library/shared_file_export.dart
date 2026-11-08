import 'package:flutter/material.dart';
import '../../core/api.dart';
import '../../core/binary_transport.dart';
import '../../core/byte_read.dart';
import '../../core/request_ids.dart';
import '../../core/workspace_controller.dart';
import '../../l10n/strings.dart';
import '../files/file_export_controller.dart';
import '../files/file_export_platform.dart';
import 'library_data.dart';
import 'sharing_data.dart';

class SharedFileExportController extends ChangeNotifier {
  SharedFileExportController(
    this.scope,
    this.shareId,
    Json value,
    this.destination,
  ) : file = sharedFile(value) {
    scope.session.addListener(changed);
  }
  final WorkspaceController scope;
  final String shareId;
  final Json file;
  final FileExportDestination destination;
  ByteReadCancellation? cancellation;
  bool busy = false, closed = false;
  String? error, notice;
  bool get active => !closed && scope.active;
  bool get canExport =>
      active &&
      !busy &&
      destination.supported &&
      isRequestId(shareId) &&
      file['status'] == 'available';
  void guard() {
    scope.guard();
    if (!active || cancellation?.cancelled == true) {
      throw const ApiException('STALE_SCOPE', 'scopeChanged');
    }
  }

  void changed() {
    if (!active) cancellation?.cancel();
    if (!closed) notifyListeners();
  }

  Future<void> authorize() async {
    guard();
    final values = libraryRows(
      await scope.session.api.requestValue(
        'GET',
        '/api/shared-bots/$shareId/files',
        expectedUser: scope.userId,
        cancellation: cancellation,
        isCurrent: () => active,
      ),
    );
    guard();
    final matching = values.where((v) => v['fileId'] == file['fileId']);
    final value = matching.length == 1 ? sharedFile(matching.single) : null;
    if (value == null ||
        value['status'] != 'available' ||
        ['revision', 'name', 'size', 'type'].any((k) => value[k] != file[k])) {
      throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
    }
  }

  Future<void> export(Rect origin) async {
    if (!canExport) return;
    busy = true;
    error = notice = null;
    cancellation = ByteReadCancellation();
    notifyListeners();
    try {
      await authorize();
      final result = await readBoundedBinary(
        scope.session.api,
        '/api/shared-bots/$shareId/files/${file['fileId']}/download?revision=${file['revision']}',
        expectedUser: scope.userId,
        isCurrent: () => active,
        cancellation: cancellation!,
        maximum: fileExportLimit,
        accept: 'application/octet-stream',
        validateHeaders: (headers) {
          if (headers['content-type']?.split(';').first.trim().toLowerCase() !=
              'application/octet-stream') {
            throw const ApiException('INVALID_FILE', 'mobileFilesExportFailed');
          }
        },
      );
      guard();
      if (result.bytes.length != file['size']) {
        throw const ApiException('FILE_CHANGED', 'mobileFilesChanged');
      }
      await authorize();
      final status = await destination.export(
        FileBytes(result.bytes, file['type']),
        file['name'],
        origin,
        authorize: authorize,
        guard: guard,
      );
      guard();
      notice = switch (status) {
        FileExportResult.selected => 'mobileFilesExportSelected',
        FileExportResult.dismissed => 'mobileFilesExportDismissed',
        FileExportResult.unknown => 'mobileFilesExportUnknown',
        FileExportResult.saved => 'mobileFilesExportSaved',
      };
    } catch (e) {
      if (active) {
        error = e is ApiException ? e.message : 'mobileFilesExportFailed';
      }
    } finally {
      busy = false;
      if (!closed) notifyListeners();
    }
  }

  @override
  void dispose() {
    closed = true;
    cancellation?.cancel();
    scope.session.removeListener(changed);
    super.dispose();
  }
}

class SharedFileExport extends StatefulWidget {
  const SharedFileExport({
    super.key,
    required this.scope,
    required this.shareId,
    required this.file,
  });
  final WorkspaceController scope;
  final String shareId;
  final Json file;
  @override
  State<SharedFileExport> createState() => _SharedFileExportState();
}

class _SharedFileExportState extends State<SharedFileExport> {
  late SharedFileExportController c;
  void create() {
    c = SharedFileExportController(
      widget.scope,
      widget.shareId,
      widget.file,
      NativeFileExport(),
    );
  }

  @override
  void initState() {
    super.initState();
    create();
  }

  @override
  void didUpdateWidget(SharedFileExport old) {
    super.didUpdateWidget(old);
    if (old.scope != widget.scope ||
        old.shareId != widget.shareId ||
        [
          'fileId',
          'revision',
          'name',
          'size',
          'type',
          'status',
        ].any((k) => old.file[k] != widget.file[k])) {
      c.dispose();
      create();
    }
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) => Builder(
      builder: (context) => IconButton(
        tooltip: context.tr('mobileFilesExport'),
        icon: c.busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.save_alt),
        onPressed: !c.canExport
            ? null
            : () async {
                final current = c;
                final box = context.findRenderObject();
                if (box is! RenderBox || !box.hasSize) return;
                await current.export(box.localToGlobal(Offset.zero) & box.size);
                if (!context.mounted || current != c || !current.active) return;
                final text = current.error ?? current.notice;
                if (text != null) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text(context.tr(text))));
                }
              },
      ),
    ),
  );
}
