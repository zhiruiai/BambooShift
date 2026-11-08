import 'dart:async';
import 'dart:ui';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/shared_file_export.dart';
import 'file_export_support.dart' show ExportDestination;
import 'library_support.dart';
import 'sharing_support.dart';
import 'support.dart';

void main() {
  test(
    'shared file exports exact revision bytes after authority checks through native handoff',
    () async {
      final requests = <http.Request>[];
      final f = await fixture((r) async {
        requests.add(r);
        expect(r.headers['X-OpenBot-Expected-User'], 'user-a');
        if (r.url.path.endsWith('/download')) {
          expect(r.url.queryParameters, {'revision': 'b' * 64});
          expect(r.followRedirects, false);
          return http.Response(
            'data',
            200,
            headers: {'content-type': 'application/octet-stream'},
          );
        }
        return jsonResponse([
          {...sharingFile(), 'status': 'available'},
        ]);
      });
      final destination = ExportDestination();
      final c = SharedFileExportController(f.scope, libraryShare, {
        ...sharingFile(),
        'status': 'available',
      }, destination);
      await c.export(const Rect.fromLTWH(0, 0, 20, 20));
      expect(destination.calls, 1);
      expect(destination.received?.bytes, [100, 97, 116, 97]);
      expect(requests.where((r) => r.url.path.endsWith('/files')).length, 3);
      expect(c.notice, 'mobileFilesExportSelected');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'revoked file grant at native handoff never exposes bytes to destination',
    () async {
      var revoked = false;
      final f = await fixture(
        (r) async => r.url.path.endsWith('/download')
            ? http.Response(
                'data',
                200,
                headers: {'content-type': 'application/octet-stream'},
              )
            : jsonResponse(
                revoked
                    ? []
                    : [
                        {...sharingFile(), 'status': 'available'},
                      ],
              ),
      );
      final destination = ExportDestination()
        ..beforeHandoff = () async {
          revoked = true;
        };
      final c = SharedFileExportController(f.scope, libraryShare, {
        ...sharingFile(),
        'status': 'available',
      }, destination);
      await c.export(const Rect.fromLTWH(0, 0, 20, 20));
      expect(destination.calls, 0);
      expect(c.error, 'mobileFilesChanged');
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'late shared bytes after account switch are discarded and unavailable grant never downloads',
    () async {
      final gate = Completer<http.Response>();
      var downloads = 0;
      final f = await fixture((r) async {
        if (r.url.path.endsWith('/download')) {
          downloads++;
          return gate.future;
        }
        return jsonResponse([
          {...sharingFile(), 'status': 'available'},
        ]);
      });
      final destination = ExportDestination();
      final unavailable = SharedFileExportController(f.scope, libraryShare, {
        ...sharingFile(),
        'status': 'missing',
      }, destination);
      await unavailable.export(const Rect.fromLTWH(0, 0, 20, 20));
      expect(downloads, 0);
      unavailable.dispose();
      final c = SharedFileExportController(f.scope, libraryShare, {
        ...sharingFile(),
        'status': 'available',
      }, destination);
      final pending = c.export(const Rect.fromLTWH(0, 0, 20, 20));
      while (downloads == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      f.session.user = {'id': 'other'};
      f.session.notifyListeners();
      gate.complete(
        http.Response(
          'data',
          200,
          headers: {'content-type': 'application/octet-stream'},
        ),
      );
      await pending;
      expect(destination.calls, 0);
      expect(c.active, false);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
