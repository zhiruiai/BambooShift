import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/byte_read.dart';
import 'package:openbot_mobile/core/api.dart';
import 'package:openbot_mobile/features/chat/attachment_controller.dart';
import 'package:openbot_mobile/features/chat/attachment_data.dart';
import 'package:openbot_mobile/features/chat/attachment_selection.dart';

import 'attachment_support.dart';
import 'support.dart';

void main() {
  test(
    'selection reads no contents and upload creates only a file card with fixed scope',
    () async {
      final server = AttachmentServer();
      var picks = 0, reads = 0;
      final f = await fixture(server.handle);
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async {
          picks++;
          return selectedFile(onRead: () => reads++);
        },
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      expect(picks, 0);
      await c.choose();
      expect(picks, 1);
      expect(reads, 0);
      expect(server.requests, isEmpty);
      expect(await c.upload(), true);
      expect(reads, 1);
      expect(
        server.requests.every(
          (r) => r.headers['X-OpenBot-Expected-User'] == 'user-a',
        ),
        true,
      );
      expect(
        server.requests.where((r) => r.method == 'POST').single.url.path,
        '/api/workspaces/space-a/files',
      );
      expect(server.messages.single['kind'], 'file');
      expect(c.files.single['id'], 'file-1');
      expect(
        c.compose('Summarize'),
        'Summarize\n[note.txt](/api/workspaces/space-a/files/file-1/download)',
      );
      expect(
        f.secrets.values.values.join(),
        isNot(contains('Synthetic selected document')),
      );
      expect(
        f.secrets.values.values.join(),
        isNot(contains(server.lastContent!)),
      );
      await c.removeFile('file-1');
      expect(c.files, isEmpty);
      expect(server.files.length, 1);
      expect(server.requests.where((r) => r.method == 'DELETE'), isEmpty);
    },
  );
  test(
    'lost upload survives reopening; GET candidates require explicit selection',
    () async {
      final server = AttachmentServer()..loseUpload = true;
      final f = await fixture(server.handle);
      var c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.choose();
      await c.upload();
      expect(c.pending, isNotNull);
      expect(c.blocksSend, true);
      final stored = f.secrets.values.values.join();
      expect(stored, contains('sha256'));
      expect(stored, isNot(contains('Synthetic selected document')));
      c.dispose();
      c = AttachmentController(f.scope, 'chat-a');
      await c.initialize();
      expect(c.candidates.single['id'], 'file-1');
      expect(c.files, isEmpty);
      await c.upload();
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
      await c.useCandidate('file-1');
      expect(c.pending, isNull);
      expect(c.files.length, 1);
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
    },
  );
  test(
    'empty GET never resolves unknown; explicit abandonment only checks server',
    () async {
      final server = AttachmentServer()
        ..loseUpload = true
        ..acceptUpload = false;
      final f = await fixture(server.handle);
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.choose();
      await c.upload();
      await c.check();
      expect(c.pending, isNotNull);
      expect(c.candidates, isEmpty);
      expect(c.canPick, false);
      server.failRead = true;
      await c.abandon();
      expect(c.pending, isNotNull);
      server.failRead = false;
      await c.abandon();
      expect(c.pending, isNull);
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
    },
  );
  test(
    'another actor or earlier matching file is never adopted as this upload',
    () async {
      final server = AttachmentServer()..loseUpload = true;
      final f = await fixture(server.handle);
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.choose();
      await c.upload();
      server.messages.single['userId'] = 'user-b';
      await c.check();
      expect(c.candidates, isEmpty);
      await c.useCandidate('file-1');
      expect(c.pending, isNotNull);
      expect(c.files, isEmpty);
    },
  );
  test(
    'two mounted composers claim one persisted upload and never overwrite its marker',
    () async {
      final server = AttachmentServer()..loseUpload = true;
      final f = await fixture(server.handle);
      final a = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      final b = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        a.dispose();
        b.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await a.initialize();
      await b.initialize();
      await a.choose();
      await b.choose();
      await a.upload();
      final id = a.pending!['operationId'];
      await b.upload();
      expect(b.pending!['operationId'], id);
      expect(server.requests.where((r) => r.method == 'POST').length, 1);
    },
  );
  test(
    'storage failure prevents POST and actual oversized or changed bytes are rejected',
    () async {
      final server = AttachmentServer();
      final secrets = MemorySecrets();
      final f = await fixture(server.handle, secrets: secrets);
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.choose();
      secrets.rejectWrites = true;
      await c.upload();
      expect(server.requests.where((r) => r.method == 'POST'), isEmpty);
      await expectLater(
        readAttachment(selectedFile(size: 1), ByteReadCancellation(), () {}),
        throwsA(isA<ApiException>()),
      );
      await expectLater(
        readAttachment(
          SelectedAttachment(
            name: 'big.txt',
            size: 1,
            type: 'text/plain',
            openRead: () => Stream.fromIterable([
              List.filled(attachmentLimit, 1),
              [1],
            ]),
          ),
          ByteReadCancellation(),
          () {},
        ),
        throwsA(isA<ApiException>()),
      );
    },
  );
  test(
    'late native selection after account switch is discarded without reading',
    () async {
      final selected = Completer<SelectedAttachment?>();
      var reads = 0;
      final f = await fixture((_) async => jsonResponse({}));
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () => selected.future,
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      final choosing = c.choose();
      f.session.user = {...f.session.user!, 'id': 'user-b'};
      f.session.selectWorkspace(f.session.workspace);
      selected.complete(selectedFile(onRead: () => reads++));
      await choosing;
      expect(c.selected, isNull);
      expect(reads, 0);
    },
  );
  test('dispose cancels actual stream read before any upload', () async {
    final stream = StreamController<List<int>>();
    var cancelled = false;
    stream.onCancel = () {
      cancelled = true;
    };
    final server = AttachmentServer();
    final f = await fixture(server.handle);
    final c = AttachmentController(
      f.scope,
      'chat-a',
      picker: () async => SelectedAttachment(
        name: 'note.txt',
        size: 20,
        type: 'text/plain',
        openRead: () => stream.stream,
      ),
    );
    await c.initialize();
    await c.choose();
    final upload = c.upload();
    await Future<void>.delayed(Duration.zero);
    c.dispose();
    await upload;
    expect(cancelled, true);
    expect(server.requests, isEmpty);
    await stream.close();
    f.scope.dispose();
    f.session.dispose();
  });
  test(
    'accepted message acknowledgement clears only referenced draft files',
    () async {
      final server = AttachmentServer();
      final f = await fixture(server.handle);
      final c = AttachmentController(
        f.scope,
        'chat-a',
        picker: () async => selectedFile(),
      );
      addTearDown(() {
        c.dispose();
        f.scope.dispose();
        f.session.dispose();
      });
      await c.initialize();
      await c.choose();
      await c.upload();
      final content = c.compose('Use this');
      await c.acknowledgeSent(content);
      expect(c.files, isEmpty);
      expect(server.files.length, 1);
      expect(c.compose('Next'), 'Next');
    },
  );
}
